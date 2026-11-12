import type { Effort, Tier } from '@software-factory/contract'
import { buildBrief, fitNotes, MAX_BRIEF_SIGNALS } from '../domains/leads/brief.ts'
import { leadBranch, leadKey, tabName } from '../domains/leads/names.ts'
import type { BriefSignal, LeadAttempt } from '../domains/leads/ports.ts'
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
    return ok({ stop: false, issue: loaded.issue, history: loaded.history, row, previous, signals })
  })
  if (!looked.ok) return looked
  if (looked.value.stop) return ok(undefined)
  const { issue: current, history, row, previous, signals } = looked.value

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
    const role = await seatOf(deps, current)
    if (!role.ok) return fail(role.error)

    const notes = notesBefore(history, attempt)
    // A project's check tiers change what the brief tells the lead to run; a read that fails is the brief of today.
    const tiers = await deps.checks.of(repoPath)
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
      signals,
      ...(previous ? { previous } : {}),
    })
    const started = await deps.terminals.start({
      key: name,
      cwd: worktree,
      space: repoPath,
      prompt,
      tier: role.value.tier,
      effort: role.value.effort,
      account,
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
      })
      // The brief is the program's argument: delivered with the start, never typed a second time.
      const brief = key('brief', issue, attempt)
      if (
        await leads.claimDelivery({ key: brief, issueId: issue, attempt, kind: 'brief', text: prompt, claimedAt: at })
      ) {
        await leads.markTyped(brief, at, false)
      }
      return recordStarted(work, deps, issue, attempt, started.value.address, role.value)
    })
    return recorded.ok ? ok(undefined) : err(toPortError(recorded.error))
  }

  // Attached: the terminal runs already. The fact is recorded again if a crash came between the two transactions. The
  // role table is not read: a seat the Issue carries is what ran, and for one without, the table may have changed since.
  const recorded = await deps.uow.run(({ work }) =>
    recordStarted(work, deps, issue, attempt, row.terminal ?? name, current.seat),
  )
  return recorded.ok ? ok(undefined) : err(toPortError(recorded.error))
}

/** The tier and effort the lead starts on: the Issue's seat as filed, else the table's `lead` row. */
async function seatOf(deps: LeadDeps, issue: Issue): Promise<Result<{ tier: Tier; effort: Effort }, PortError>> {
  if (!issue.seat) return deps.roles.lead()
  return ok({ tier: issue.seat.tier, effort: issue.seat.effort })
}

async function recordStarted(
  work: Parameters<Parameters<LeadDeps['uow']['run']>[0]>[0]['work'],
  deps: LeadDeps,
  issue: IssueId,
  attempt: number,
  terminal: string,
  seat: { tier: Tier; effort: Effort } | undefined,
) {
  const result = await recordIn(work, deps, {
    issueId: issue,
    key: key('lead_started', issue, attempt),
    event: {
      kind: 'lead_started',
      payload: { attempt, terminal, ...(seat ? { seat: { tier: seat.tier, effort: seat.effort } } : {}) },
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
    const result = await recordIn(work, deps, {
      issueId: issue,
      key: key('lead_gone', issue, attempt),
      event: { kind: 'lead_gone', payload: { attempt, detail: detail.slice(0, 2_000) || 'unknown' }, actor: 'factory' },
    })
    return result.ok ? ok(undefined) : result
  })
  return recorded.ok ? ok(undefined) : err(toPortError(recorded.error))
}
