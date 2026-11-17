import { noteText } from '../domains/leads/note.ts'
import { leadKey } from '../domains/leads/names.ts'
import { deriveSession } from '../domains/leads/session.ts'
import type { Delivery } from '../domains/leads/ports.ts'
import type { Issue } from '../domains/work/issue.ts'
import type { EffectOf } from '../domains/work/effects.ts'
import type { IssueId } from '../kernel/ids.ts'
import { err, ok, portError, type PortError, type Result } from '../kernel/result.ts'
import { leadGone, NO_ORIGIN, seatOf } from './leads-start.ts'
import { tabName } from '../domains/leads/names.ts'
import { type LeadDeps, loadIssue } from './leads.ts'

type NoteEffect = EffectOf<'note_lead'> & { issueId: IssueId }

/** What starting a lead's session again needs (a dormant lead, or one whose terminal fell back to a shell), read in the same look as the delivery. */
export interface Dormant {
  session: string | null
  worktree: string | null
  repoPath: string | null
  account: string | null
  issue: Issue
}

/** What a session started again over a shell is told first: the host's restart took everything the old session had running. */
export const HOST_RESTARTED =
  'The host restarted: your terminal came back as a shell and this session was started again with `--resume`. ' +
  'Everything that ran in the background (checks, builds, merge windows, subagents, waits) is gone. ' +
  'Check git, the pull request and production before you repeat anything that left the machine, then go on.'

type Look =
  | { done: true }
  | {
      done: false
      delivery: Pick<Delivery, 'claimedAt' | 'text'>
      working: boolean
      dormant: Dormant | null
      /** what starting the session again needs, dormant or not: a lead moved to another account is started again while it runs */
      resume: Dormant
      /** when the lead's hooks say its turn ended with none begun since; null while a turn runs or none was seen */
      idleSince: Date | null
    }

/**
 * `note_lead`: the Issue's events from `from` to `version` typed into the lead's terminal, once. The effect's key is the
 * delivery's key, claimed before the typing, so a replay finds it: typed already is done, claimed and a turn since is
 * delivered, claimed and nothing since is typed again. A lead mid-turn is asked again until its turn ends (the outbox
 * waits between tries), and typed into its working turn after `forceNoteAfterMs`. Before the typing the lead takes its
 * repo's claim back (`claims.resume`), which is where a lead whose wait ended gets its place. A lead whose terminal is gone is the
 * lead gone, and the next attempt's brief carries the notes.
 */
export async function noteLead(deps: LeadDeps, effect: NoteEffect): Promise<Result<void, PortError>> {
  const { issueId: issue, key: deliveryKey } = effect
  const { attempt, from, version } = effect.payload
  const name = leadKey(issue, attempt)

  const looked = await deps.uow.run<Look, never>(async ({ work, leads }) => {
    const loaded = await loadIssue(work, issue)
    if (!loaded || loaded.issue.state === 'closed' || loaded.issue.attempt !== attempt) return ok({ done: true })
    const working = loaded.issue.state === 'working' || loaded.issue.state === 'watching'
    const row = await leads.attempt(issue, attempt)
    // A lead that never started, or is gone, hears nothing: the next attempt's brief carries the notes.
    if (!row?.terminal || row.goneAt) return ok({ done: true })
    const existing = await leads.delivery(deliveryKey)
    if (existing?.typedAt) return ok({ done: true })
    const view = deriveSession(await leads.hookFacts(name))
    const idleSince = view.state === 'idle' ? view.idleSince : null
    if (existing) {
      // Claimed, never confirmed: a turn that began since proves the lead took it.
      if (view.lastTurnAt && view.lastTurnAt > existing.claimedAt) {
        await leads.markTyped(deliveryKey, view.lastTurnAt, false)
        // A resumed session's first turn is that proof too: the lead runs again.
        await leads.markRevived(issue, attempt)
        return ok({ done: true })
      }
      return ok({
        done: false,
        delivery: existing,
        working,
        dormant: dormantOf(row, loaded.issue, view.claudeSession),
        resume: resumeOf(row, loaded.issue, view.claudeSession),
        idleSince,
      })
    }
    const text = noteText(
      issue,
      loaded.history.filter((record) => record.version >= from && record.version <= version),
    )
    const claimedAt = deps.clock.now()
    await leads.claimDelivery({ key: deliveryKey, issueId: issue, attempt, kind: 'note', text, claimedAt })
    const dormant = dormantOf(row, loaded.issue, view.claudeSession)
    return ok({
      done: false,
      delivery: { claimedAt, text },
      working,
      dormant,
      resume: resumeOf(row, loaded.issue, view.claudeSession),
      idleSince,
    })
  })
  if (!looked.ok) return looked
  if (looked.value.done) return ok(undefined)
  const { delivery, working, dormant, resume, idleSince } = looked.value

  const found = await deps.terminals.find(name)
  if (!found.ok) return found
  // A live terminal must run the agent: a shell the core put in place of a lost program is no lead, and a note is never typed into it.
  const live = found.value.find((terminal) => terminal.live && terminal.agent)
  // A live terminal with no agent in it (a host restart brought it back as a shell): the session starts again over it, below.
  const shellOnly = !live && found.value.some((terminal) => terminal.live)
  // A dormant lead has no process by design; the wake starts its session again, below.
  if (!live && !dormant && !shellOnly) {
    return leadGone(deps, issue, attempt, 'its terminal was gone when a note arrived')
  }

  // A wait that ended left the lead without a claim: it takes its repo's place back before it is told, and a full repo
  // refuses so the outbox tries again. A lead that is waiting again by now has nothing to take.
  if (working) {
    const resumed = await deps.claims.resume({ issue, attempt })
    // A closed Issue has nothing to tell: its finalize is the claim's end.
    if (!resumed.ok) return resumed.error.kind === 'gone' ? ok(undefined) : resumed
  }

  // The account the attempt belongs to now. A lead whose account ran out is given another one (`seats.move`) and woken:
  // its session ends and starts again there, the same session, so the wake is the first message it reads.
  const seat = await deps.seats.seat({ issue, attempt })
  if (!seat.ok) return seat
  // An attempt with no assignment answers `default`: nothing to move to.
  // A session that cannot be started again (no id on file) is not ended for it: the note is typed to it where it runs.
  const movedTo =
    resume.account && resume.session && seat.value.account !== 'default' && seat.value.account !== resume.account
      ? seat.value.account
      : null
  if (movedTo && (live || dormant)) {
    if (!dormant) {
      const marked = await deps.uow.run(async ({ leads }) => {
        await leads.markDormant(issue, attempt, deps.clock.now(), movedTo)
        return ok(undefined)
      })
      if (!marked.ok) return marked
    }
    // Ending twice, or a session already ended, is the same as once.
    const ended = await deps.terminals.quiesce(name)
    if (!ended.ok) return ended
    return reviveAndTell(deps, {
      issue,
      attempt,
      name,
      deliveryKey,
      text: delivery.text,
      dormant: resume,
      account: movedTo,
    })
  }

  if (!live) {
    // A shell over a lead that was not dormant: the loss is on record (the follow may not have met the grace yet), the
    // account it belongs to now, and the restart told first.
    if (!dormant) {
      await deps.uow.run(async ({ leads }) => {
        await leads.markAgentLost(issue, attempt, deps.clock.now())
        return ok(undefined)
      })
    }
    return reviveAndTell(deps, {
      issue,
      attempt,
      name,
      deliveryKey,
      text: dormant ? delivery.text : `${HOST_RESTARTED}\n\n${delivery.text}`,
      dormant: dormant ?? resume,
      ...(!dormant && movedTo ? { account: movedTo } : {}),
    })
  }
  // Dormant but its process never ended (the quiesce failed): the lead runs, so the mark goes and the note is typed.
  if (dormant) await clearDormant(deps, issue, attempt)

  const now = deps.clock.now().getTime()
  const force = now - delivery.claimedAt.getTime() >= deps.forceNoteAfterMs
  // The hooks know the turn is over; the core's status can say otherwise for good (issue 1190), so after the same wait the
  // screen decides: an empty input box takes the note whatever the status reads.
  const idle = idleSince !== null && now - idleSince.getTime() >= deps.forceNoteAfterMs
  await deps.typePace?.()
  const typed = await deps.terminals.type({ terminal: live.address, text: delivery.text, force, idle })
  if (!typed.ok) return typed
  if (typed.value === 'busy') {
    return err(portError('refused', 'the lead is mid-turn; it hears the note when its turn ends'))
  }
  const at = deps.clock.now()
  const marked = await deps.uow.run(async ({ leads }) => {
    await leads.markTyped(deliveryKey, at, force)
    return ok(undefined)
  })
  return marked.ok ? ok(undefined) : marked
}

type AttemptRow = {
  dormantAt: Date | null
  worktreePath: string | null
  repoPath: string | null
  account: string | null
}

const resumeOf = (row: AttemptRow, issue: Issue, session: string | null): Dormant => ({
  session,
  worktree: row.worktreePath,
  repoPath: row.repoPath,
  account: row.account,
  issue,
})

const dormantOf = (row: AttemptRow, issue: Issue, session: string | null): Dormant | null =>
  row.dormantAt ? resumeOf(row, issue, session) : null

const clearDormant = (deps: LeadDeps, issue: IssueId, attempt: number) =>
  deps.uow.run(async ({ leads }) => {
    await leads.markRevived(issue, attempt)
    return ok(undefined)
  })

/**
 * The wake of a dormant lead: its session starts again with the note as its first message, so there is nothing to type. A
 * start that fails is tried again by the outbox; the third failure, or one a retry cannot fix, is the lead gone.
 */
export async function reviveAndTell(
  deps: LeadDeps,
  input: {
    issue: IssueId
    attempt: number
    name: string
    /** the note's delivery, marked typed with the start; none for a start that carries no note */
    deliveryKey?: string
    text: string
    dormant: Dormant
    /** the account the session starts on when it is not the one it ran on: a lead moved off an account that ran out */
    account?: string
  },
): Promise<Result<void, PortError>> {
  const { issue, attempt, name, deliveryKey, text, dormant } = input
  const account = input.account ?? dormant.account
  if (!dormant.session || !dormant.worktree || !dormant.repoPath || !account) {
    return leadGone(deps, issue, attempt, 'the lead was dormant without a session to resume')
  }
  // The session resumes on the seat its attempt started on; an attempt recorded before seats were stored reads the table.
  const ranOn = dormant.issue.ranOn
  const seat = ranOn ? ok(ranOn) : await seatOf(deps, dormant.issue, NO_ORIGIN)
  if (!seat.ok) return seat
  await deps.typePace?.()
  const started = await deps.terminals.revive({
    key: name,
    cwd: dormant.worktree,
    space: dormant.repoPath,
    prompt: text,
    tier: seat.value.tier,
    effort: seat.value.effort,
    account,
    tabName: tabName(dormant.issue.title),
    session: dormant.session,
  })
  if (!started.ok) {
    const failed = await deps.uow.run(async ({ leads }) => ok(await leads.reviveFailed(issue, attempt)))
    const tries = failed.ok ? failed.value : 0
    if (started.error.kind === 'refused' || tries >= (deps.quiesce?.maxReviveTries ?? 3)) {
      return leadGone(deps, issue, attempt, `its dormant session could not be resumed: ${started.error.detail}`)
    }
    return started
  }
  const at = deps.clock.now()
  const marked = await deps.uow.run(async ({ leads }) => {
    if (deliveryKey) await leads.markTyped(deliveryKey, at, false)
    await leads.markAgentFound(issue, attempt, at)
    await leads.markRevived(issue, attempt, {
      address: started.value.address,
      tab: started.value.tab,
      space: started.value.space,
      ...(input.account ? { account: input.account } : {}),
    })
    return ok(undefined)
  })
  return marked.ok ? ok(undefined) : marked
}
