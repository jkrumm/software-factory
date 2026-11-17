import { type Effort, REVIEWER_CHEAP_ROLE, type Tier } from '@software-factory/contract'
import { buildBrief, fitNotes, MAX_BRIEF_SIGNALS } from '../domains/leads/brief.ts'
import { LEAD_ROLE, LIGHT_ROLE, lightRule } from '../domains/leads/light.ts'
import { reviewerBrief, reviewerRoleFor } from '../domains/leads/reviewer.ts'
import { deriveSession } from '../domains/leads/session.ts'
import { leadBranch, leadKey, tabName } from '../domains/leads/names.ts'
import type { BriefSignal, BriefSpec, LeadAttempt, SeatOrigin } from '../domains/leads/ports.ts'
import type { EffectOf } from '../domains/work/effects.ts'
import type { Issue } from '../domains/work/issue.ts'
import type { AppliedRecord } from '../domains/work/machine.ts'
import { type IssueId, issueNumber } from '../kernel/ids.ts'
import { key } from '../kernel/keys.ts'
import { err, ok, type PortError, type Result } from '../kernel/result.ts'
import { recordIn } from './issues.ts'
import { type LeadDeps, loadIssue, toPortError } from './leads.ts'

type StartEffect = EffectOf<'start_lead'> & { issueId: IssueId }

interface PreviousAttempt {
  attempt: number
  branch: string
  worktree: string | null
  why: string
  ended: string | null
}

type Look =
  | { stop: true }
  | {
      stop: false
      issue: Issue
      history: AppliedRecord[]
      row: LeadAttempt
      previous: PreviousAttempt | null
      signals: BriefSignal[]
      filedSpec: BriefSpec | null
      origin: SeatOrigin
      movedFrom: { attempt: number; why: string; transcript: string | null } | null
    }

/** The notes recorded before the attempt's admission: the new lead has no memory, so all of them. */
function notesBefore(history: readonly AppliedRecord[], attempt: number) {
  const admitted = history.filter((record) => record.kind === 'admitted')[attempt - 1]
  const cut = admitted?.version ?? Number.POSITIVE_INFINITY
  const notes = history
    .filter((record) => record.kind === 'noted' && record.version < cut)
    .map((record) => ({
      at: record.at,
      text: String((record.payload as { text?: unknown }).text ?? ''),
      // the orchestrator is the owner's delegate: its steer has the owner's budget in the brief
      fromOwner: record.actor === 'owner' || record.actor === 'orchestrator',
    }))
  // Each kind has its own budget: a run of alert repeats must not push the owner's steer out of the brief.
  const owner = fitNotes(notes.filter((note) => note.fromOwner))
  const others = fitNotes(notes.filter((note) => !note.fromOwner))
  return { shown: [...owner.shown, ...others.shown], more: owner.more + others.more }
}

/**
 * `start_lead`: claim and look (one transaction), the worktree, then the terminal, then record the lead started (one
 * transaction), never a port inside one. The terminal is found by its key before it is made, so a replay after a crash
 * attaches to the lead that runs; a failure the retry cannot fix, or a start that outlives its budget, is the lead gone.
 */
export async function startLead(deps: LeadDeps, effect: StartEffect): Promise<Result<void, PortError>> {
  const { issueId: issue } = effect
  const { attempt } = effect.payload
  const branch = leadBranch(issue, attempt)
  const name = leadKey(issue, attempt)

  const looked = await deps.uow.run<Look, never>(async ({ work, leads }) => {
    const loaded = await loadIssue(work, issue)
    // An Issue that closed meanwhile, or moved to a later attempt, has no use for this lead.
    if (!loaded || loaded.issue.state === 'closed' || loaded.issue.attempt !== attempt) return ok({ stop: true })
    const row = await leads.tried(issue, attempt, branch, deps.clock.now())
    const before = attempt > 1 ? await leads.finalization(issue, attempt - 1) : null
    const gone = loaded.history.findLast(
      (record) => record.kind === 'lead_gone' && (record.payload as { attempt?: number }).attempt === attempt - 1,
    )
    const previous =
      before?.worktreeKept != null
        ? {
            attempt: attempt - 1,
            branch: leadBranch(issue, attempt - 1),
            worktree: before.worktreePath,
            why: before.worktreeKept,
            ended: gone ? String((gone.payload as { detail?: unknown }).detail ?? '') : null,
          }
        : null
    const signals = await leads.signalsOf(issue, MAX_BRIEF_SIGNALS)
    const filedSpec = await leads.filedSpecOf(issue)
    const found = await leads.originOf(issue)
    // An Issue the owner or an agent filed carries its text as notes, not as a signal: the light rule reads both.
    const origin = {
      ...found,
      text: [found.text, ...notesBefore(loaded.history, attempt).shown.map((note) => note.text)].join(' '),
    }
    const moved = loaded.history.findLast(
      (record) => record.kind === 'moved_up' && (record.payload as { attempt?: number }).attempt === attempt - 1,
    )
    const movedFrom = moved
      ? {
          attempt: attempt - 1,
          why: String((moved.payload as { why?: unknown }).why ?? ''),
          transcript: deriveSession(await leads.hookFacts(leadKey(issue, attempt - 1))).transcriptPath,
        }
      : null
    return ok({
      stop: false,
      issue: loaded.issue,
      history: loaded.history,
      row,
      previous,
      signals,
      filedSpec,
      origin,
      movedFrom,
    })
  })
  if (!looked.ok) return looked
  if (looked.value.stop) return ok(undefined)
  const { issue: current, history, row, previous, signals, filedSpec, origin, movedFrom } = looked.value

  const spent = deps.clock.now().getTime() - row.firstTryAt.getTime() > deps.startBudgetMs
  // A refusal retrying cannot fix is the lead gone; so is a start that has outlived its budget.
  const fail = (error: PortError): Promise<Result<void, PortError>> | Result<void, PortError> =>
    error.kind === 'refused'
      ? leadGone(deps, issue, attempt, error.detail)
      : spent
        ? leadGone(deps, issue, attempt, `the start did not work in time: ${error.detail}`)
        : err(error)

  if (row.startedAt === null || row.terminal === null) {
    let worktree = row.worktreePath
    let repoPath = row.repoPath
    let account = row.account
    if (worktree === null || repoPath === null || account === null) {
      const located = await deps.repos.locate(current.repo)
      if (!located.ok) return fail(located.error)
      const seat = await deps.seats.seat({ issue, attempt })
      if (!seat.ok) return fail(seat.error)
      const made = await deps.worktrees.create({ repo: located.value, branch })
      if (!made.ok) return fail(made.error)
      worktree = made.value.path
      repoPath = located.value
      account = seat.value.account
      const saved = await deps.uow.run(async ({ leads }) => {
        await leads.saveWorktree(issue, attempt, {
          account: seat.value.account,
          repoPath: located.value,
          worktreePath: made.value.path,
          baseSha: made.value.sha,
        })
        return ok(undefined)
      })
      if (!saved.ok) return saved
    }
    const role = await seatOf(deps, current, origin)
    if (!role.ok) return fail(role.error)
    const movedUp = movedFrom && {
      attempt: movedFrom.attempt,
      why: movedFrom.why,
      lastWords: await lastWordsOf(deps, movedFrom.transcript),
    }

    const reviewer = await reviewerOf(deps, issue, role.value.rule !== null)
    const notes = notesBefore(history, attempt)
    // A project's check tiers change what the brief tells the lead to run; a read that fails is the brief of today.
    const tiers = await deps.checks.of(repoPath)
    // The project's `env` reaches the session; a read that fails starts the lead without it, as before the key existed.
    const projectEnv = await deps.checks.env(repoPath)
    const mergeGuard = await deps.mergeGuard.has(worktree)
    const prompt = buildBrief({
      issue: {
        id: issue,
        number: issueNumber(issue),
        repo: current.repo,
        title: current.title,
        kind: current.kind,
        origin: current.origin,
        ...(current.checkpoint ? { checkpoint: current.checkpoint } : {}),
      },
      attempt,
      worktree: { path: worktree, branch },
      notes: notes.shown,
      notesMore: notes.more,
      checks: tiers.ok ? tiers.value : null,
      mergeGuard,
      signals,
      filedSpec,
      ...(previous ? { previous } : {}),
      light: role.value.rule,
      reviewer: reviewer ? reviewerBrief(reviewer.role, reviewer.cheap) : null,
      movedUp,
    })
    const started = await deps.terminals.start({
      key: name,
      cwd: worktree,
      space: repoPath,
      prompt,
      tier: role.value.tier,
      effort: role.value.effort,
      account,
      ...(projectEnv.ok && Object.keys(projectEnv.value).length > 0 ? { env: projectEnv.value } : {}),
      tabName: tabName(current.title),
    })
    if (!started.ok) return fail(started.error)

    const at = deps.clock.now()
    const recorded = await deps.uow.run(async ({ work, leads }) => {
      await leads.saveStarted(issue, attempt, {
        terminal: started.value.address,
        tab: started.value.tab,
        space: started.value.space,
        at,
        seat: { tier: role.value.tier, effort: role.value.effort },
      })
      // The brief is the program's argument: delivered with the start, never typed a second time.
      const brief = key('brief', issue, attempt)
      if (
        await leads.claimDelivery({ key: brief, issueId: issue, attempt, kind: 'brief', text: prompt, claimedAt: at })
      ) {
        await leads.markTyped(brief, at, false)
      }
      return recordStarted(work, deps, issue, attempt, started.value.address, role.value, reviewer?.role ?? null)
    })
    return recorded.ok ? ok(undefined) : err(toPortError(recorded.error))
  }

  // Attached: the terminal runs already. The fact is recorded again if a crash came between the two transactions, with
  // the seat decided again (the rule reads stored facts); a table that cannot be read leaves the filed seat, or none. The
  // reviewer row is not decided again: the brief was typed under a decision this path cannot read back, and a row that
  // differs from the brief would be measured as a seat the lead was never told to use. None is recorded: the reviews of
  // that lead are left out of the reviewer table.
  const decided = await seatOf(deps, current, origin)
  const seat = decided.ok ? decided.value : current.seat
  const recorded = await deps.uow.run(({ work }) =>
    recordStarted(work, deps, issue, attempt, row.terminal ?? name, seat, null),
  )
  return recorded.ok ? ok(undefined) : err(toPortError(recorded.error))
}

/** An Issue no loop or monitor filed, or one whose origin is not at hand: the light rule reads its kind and size alone. */
export const NO_ORIGIN: SeatOrigin = { hygieneKey: null, hygieneClass: null, unroutedMonitor: false, text: '' }

/** A lead seat: its tier and effort, the role row it came from, and the light rule that chose it. */
export interface LeadSeat {
  tier: Tier
  effort: Effort
  role?: string | undefined
  /** the light seat's rule (`domains/leads/light.ts`); null on any other seat */
  rule: string | null
}

/** The hygiene classes that start on the standard lead now; none when the reader is unset or cannot say. */
const classesOut = async (deps: LeadDeps): Promise<ReadonlySet<string>> =>
  (await deps.lightClassesOut?.().catch(() => null)) ?? new Set<string>()

/**
 * The seat the lead starts on: the Issue's seat as filed always wins; with none, the table's `light` row when the light
 * rule names the Issue (and the table has the row), else its `lead` row.
 */
export async function seatOf(deps: LeadDeps, issue: Issue, origin: SeatOrigin): Promise<Result<LeadSeat, PortError>> {
  if (issue.seat) return ok({ tier: issue.seat.tier, effort: issue.seat.effort, role: issue.seat.role, rule: null })
  const rule = lightRule({
    kind: issue.kind,
    size: issue.size ?? null,
    spec: issue.checkpoint === 'spec',
    hygieneKey: origin.hygieneKey,
    hygieneOut: origin.hygieneClass !== null && (await classesOut(deps)).has(origin.hygieneClass),
    unroutedMonitor: origin.unroutedMonitor,
    movedUp: issue.movedUp,
    text: `${issue.title} ${origin.text}`,
    triageSmall: issue.size === 'small' && (await (deps.lightGate?.().catch(() => false) ?? false)),
  })
  if (rule) {
    const light = await deps.roles.role(LIGHT_ROLE)
    if (light.ok) return ok({ ...light.value, role: LIGHT_ROLE, rule })
    if (light.error.kind !== 'refused') return light
  }
  const lead = await deps.roles.lead()
  return lead.ok ? ok({ ...lead.value, role: LEAD_ROLE, rule: null }) : lead
}

/**
 * The reviewer row this lead's reviews run on and the cheap row's seat (`domains/leads/reviewer.ts`), or null when the
 * role table cannot say (a table without the cheap row leaves reviews on agw's seat, as before Issue 2027). The tripwire
 * is read here, once, outside any transaction; with no reader every Issue is on its starting share.
 */
async function reviewerOf(
  deps: LeadDeps,
  issue: IssueId,
  light: boolean,
): Promise<{ role: string; cheap: { tier: Tier; effort: Effort } } | null> {
  const cheap = await deps.roles.role(REVIEWER_CHEAP_ROLE)
  if (!cheap.ok) return null
  const takesAll = deps.reviewerTakesAll ? await deps.reviewerTakesAll() : false
  return { role: reviewerRoleFor({ issueNumber: issueNumber(issue), light, takesAll }), cheap: cheap.value }
}

/** The last words of a moved-up light lead, for its successor's brief; nothing when they cannot be read. */
async function lastWordsOf(deps: LeadDeps, transcript: string | null): Promise<string | null> {
  if (!transcript || !deps.apiErrors) return null
  const words = await deps.apiErrors.tails.lastWords(transcript, LAST_WORDS_CHARS)
  return words.ok ? words.value : null
}

/** How much of a moved-up lead's last words its successor reads. */
const LAST_WORDS_CHARS = 3_000

async function recordStarted(
  work: Parameters<Parameters<LeadDeps['uow']['run']>[0]>[0]['work'],
  deps: LeadDeps,
  issue: IssueId,
  attempt: number,
  terminal: string,
  seat: { tier: Tier; effort: Effort; role?: string | undefined; rule?: string | null | undefined } | undefined,
  reviewer: string | null,
) {
  const result = await recordIn(work, deps, {
    issueId: issue,
    key: key('lead_started', issue, attempt),
    event: {
      kind: 'lead_started',
      payload: {
        attempt,
        terminal,
        ...(seat ? { seat: seatPayload(seat) } : {}),
        ...(reviewer ? { reviewer } : {}),
      },
      actor: 'factory',
    },
  })
  return result.ok ? ok(undefined) : result
}

/** Records the attempt's lead gone: the machine restarts it up to its limit, then stalls. */
export async function leadGone(
  deps: LeadDeps,
  issue: IssueId,
  attempt: number,
  detail: string,
): Promise<Result<void, PortError>> {
  const at = deps.clock.now()
  const recorded = await deps.uow.run(async ({ work, leads }) => {
    await leads.markGone(issue, attempt, at)
    // A loss still open ends here: the next attempt is the answer to it, and the health line has nothing to name.
    await leads.markAgentFound(issue, attempt, at)
    const result = await recordIn(work, deps, {
      issueId: issue,
      key: key('lead_gone', issue, attempt),
      event: { kind: 'lead_gone', payload: { attempt, detail: detail.slice(0, 2_000) || 'unknown' }, actor: 'factory' },
    })
    return result.ok ? ok(undefined) : result
  })
  return recorded.ok ? ok(undefined) : err(toPortError(recorded.error))
}

/** The seat as `lead_started` stores it: the role row, and the light rule only when the rule chose the seat. */
const seatPayload = (seat: {
  tier: Tier
  effort: Effort
  role?: string | undefined
  rule?: string | null | undefined
}) => ({
  tier: seat.tier,
  effort: seat.effort,
  ...(seat.role ? { role: seat.role } : {}),
  ...(seat.rule ? { rule: seat.rule } : {}),
})
