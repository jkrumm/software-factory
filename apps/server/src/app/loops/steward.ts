import type { StewardAnswer } from '@software-factory/contract'
import { scrub } from '../../kernel/scrub.ts'
import { readDecisionForm } from '../../domains/checkpoints/decision.ts'
import type { CallPolicy } from '../../domains/loops/calls.ts'
import type { ClaimHolder, LoopReads, LoopStore, StewardWorkflow } from '../../domains/loops/ports.ts'
import {
  checkAnswer,
  type Checked,
  decideStall,
  fallbackDecision,
  MAX_ROUNDS,
  STEWARD_DETAIL,
  type StallCause,
  type StallFacts,
  stallRequest,
  type StewardRules,
} from '../../domains/loops/stall.ts'
import type { Seats, Windows } from '../../domains/leads/ports.ts'
import type { Issue } from '../../domains/work/issue.ts'
import { WAITS } from '../../domains/work/issue.ts'
import type { AppliedRecord } from '../../domains/work/machine.ts'
import { replay } from '../../domains/work/machine.ts'
import type { WorkStore } from '../../domains/work/ports.ts'
import { type IssueId, issueNumber } from '../../kernel/ids.ts'
import { key } from '../../kernel/keys.ts'
import { err, ok, portError, type PortError, type Result } from '../../kernel/result.ts'
import { AGW_HANG_GUARD_MS } from '../../kernel/agw.ts'
import { askDecision, type CheckpointDeps } from '../checkpoints.ts'
import { type Claimed, claimRound } from './claim.ts'
import { recordIn, type WriteDeps } from '../issues.ts'
import type { PlanningDeps } from '../planning-deps.ts'
import { settleIssue } from '../planning-chain.ts'
import type { UnitOfWork } from '../unit-of-work.ts'

export type StewardStores = { work: WorkStore; loops: LoopStore; loopReads: LoopReads }

export interface StewardDeps extends WriteDeps {
  uow: UnitOfWork<StewardStores>
  workflow: StewardWorkflow
  /** capacity's side of the leads' ports: the account an attempt runs on, and when its window opens again */
  seats: Seats
  windows: Windows
  /** the checkpoints' use case that raises a Decision, with the Issue's machine behind it */
  checkpoints: CheckpointDeps
  /** planning's use case that settles an Issue: the edges and the event are one transaction */
  planning: PlanningDeps
  /** capacity's side: the Issues queued for lack of a claim in their repo (called outside any transaction) */
  claimQueued(): Promise<Result<{ issue: IssueId; repo: string }[], PortError>>
  rules: StewardRules
  retryMs: number
  /** an Issue still settling this long after it was filed is settled with no edges */
  settleTimeoutMs: number
  /** a watch with this many blocked checks in a row is told to its lead */
  blockedChecks: number
  /** lets the runner know the steward changed an Issue (the loop guard keeps it from firing the steward again) */
  changed(): void
}

export interface StewardPass {
  looked: number
  woken: number
  requeued: number
  asked: number
  decisions: number
  settled: number
  noted: number
  deferred: number
  problems: string[]
}

/** Stalled Issues looked at per pass: wide, because those the rules leave waiting (a closed wall, backoff) keep their place. */
const STALL_LIMIT = 100
const PASS_LIMIT = 20
const HISTORY_LINES = 12

const stallCause = (issue: Issue): StallCause | null => {
  const reason = issue.wait?.reason
  return issue.state === 'waiting' && reason && WAITS[reason].stall ? (reason as StallCause) : null
}

const field = (payload: unknown, name: string): string => {
  const value = payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[name] : undefined
  return typeof value === 'string' ? value : ''
}

/** One line of the Issue's history: its version, the kind, and what it says of itself. Notes are marked, not quoted. */
function lineOf(record: AppliedRecord): string {
  const said = record.kind === 'noted' ? 'a note' : field(record.payload, 'detail') || field(record.payload, 'reason')
  return `v${record.version} ${record.kind}${said ? `: ${said.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`
}

/** What the steward knows of a stalled Issue, from its events alone; `windowOpen` comes from capacity afterwards. */
export function factsOf(issue: Issue, history: readonly AppliedRecord[]): StallFacts | null {
  const cause = stallCause(issue)
  const wait = issue.wait
  if (!cause || !wait || !('detail' in wait)) return null
  const began = history.find((record) => record.version === wait.since)
  const lastAdmitted = history.findLast((record) => record.kind === 'admitted')?.version ?? 0
  return {
    issue: issue.id,
    repo: issue.repo,
    title: issue.title,
    kind: issue.kind,
    cause,
    detail: wait.detail,
    since: wait.since,
    stalledAt: began?.at ?? new Date(0),
    attempt: issue.attempt,
    restarts: issue.restarts,
    regressions: issue.regressions,
    stewardWakes: history.filter(
      (record) =>
        record.kind === 'woken' &&
        record.version > lastAdmitted &&
        field(record.payload, 'detail').startsWith(STEWARD_DETAIL),
    ).length,
    notes: history
      .filter((record) => record.kind === 'noted' && record.version > wait.told)
      .map((record) => field(record.payload, 'text')),
    history: history.slice(-HISTORY_LINES).map(lineOf),
    windowOpen: null,
  }
}

const policyOf = (deps: StewardDeps): CallPolicy => ({
  maxRounds: MAX_ROUNDS,
  retryMs: deps.retryMs,
  // The lease outlives the hang guard, so a second pass takes over only when the first call can no longer be running.
  leaseMs: AGW_HANG_GUARD_MS + 5 * 60_000,
})

type Out<T> = Promise<Result<T, PortError>>

async function load(deps: StewardDeps, id: IssueId): Out<StallFacts | null> {
  const loaded = await deps.uow.run(async ({ work }) => {
    const history = await work.history(id)
    return ok(history ? { issue: replay(id, history), history } : null)
  })
  if (!loaded.ok) return loaded
  if (!loaded.value) return ok(null)
  const facts = factsOf(loaded.value.issue, loaded.value.history)
  if (!facts) return ok(null)
  if (facts.cause === 'wall') {
    // Capacity answers outside the transaction: the account the attempt runs on, and when its window opens again.
    const seat = await deps.seats.seat({ issue: id, attempt: facts.attempt })
    const wall = seat.ok ? await deps.windows.wall(seat.value.account) : seat
    if (wall.ok) facts.windowOpen = wall.value.resetAt === null || wall.value.resetAt <= deps.clock.now()
  }
  return ok(facts)
}

/** Ends the stall: the note (if any) is recorded first so the wake's `note_lead` carries it, then `woken`. */
async function wake(deps: StewardDeps, facts: StallFacts, detail: string, note: string | null): Out<boolean> {
  const done = await deps.uow.run(async ({ work }) => {
    if (note) {
      const noted = await recordIn(work, deps, {
        issueId: facts.issue,
        key: key('noted', 'steward', facts.issue, facts.since),
        event: { kind: 'noted', payload: { text: note.slice(0, 4_000) }, actor: 'steward' },
      })
      if (!noted.ok) return err(portError('refused', JSON.stringify(noted.error)))
    }
    const woken = await recordIn(work, deps, {
      issueId: facts.issue,
      key: key('woken', 'steward', facts.issue, facts.since),
      event: { kind: 'woken', payload: { since: facts.since, detail: detail.slice(0, 500) }, actor: 'steward' },
    })
    if (!woken.ok) return err(portError('refused', JSON.stringify(woken.error)))
    return ok(woken.value.result === 'applied')
  })
  return done
}

/** The Decision goes the whole way: the checkpoints' own use case, so policy, the Judge, the default and the owner follow. */
async function raise(deps: StewardDeps, facts: StallFacts, form: unknown): Out<boolean> {
  const asked = await askDecision(deps.checkpoints, {
    issueId: facts.issue,
    attempt: facts.attempt,
    form,
    by: 'steward',
    // The wait it answers is part of the Decision's key: the same question about a later stall is a new Decision.
    salt: `wait:${facts.since}`,
  })
  if (asked.ok) return ok(asked.value.result === 'applied')
  const detail = 'detail' in asked.error ? asked.error.detail : asked.error.kind
  return err(portError('refused', `the Decision was refused: ${detail}`))
}

type Acted = 'woken' | 'requeued' | 'decision' | 'nothing'

async function act(deps: StewardDeps, facts: StallFacts, checked: Checked): Out<Acted> {
  switch (checked.kind) {
    case 'none':
      return ok('nothing')
    case 'wake':
    case 'requeue': {
      const detail = `${STEWARD_DETAIL}${checked.reason}`
      const woken = await wake(deps, facts, detail, checked.note)
      if (!woken.ok) return woken
      return ok(woken.value ? (checked.kind === 'wake' ? 'woken' : 'requeued') : 'nothing')
    }
    case 'decision': {
      const raised = await raise(deps, facts, checked.form)
      return raised.ok ? ok(raised.value ? 'decision' : 'nothing') : raised
    }
  }
}

/** What the workflow said, held to the stall and to the checkpoints' own form reader. A refusal is a round spent. */
function judgeAnswer(facts: StallFacts, answer: StewardAnswer): { checked: Checked; rejected: string | null } {
  const checked = checkAnswer(facts, answer)
  if (checked.kind === 'none') return { checked, rejected: checked.why }
  if (checked.kind !== 'decision') return { checked, rejected: null }
  const form = readDecisionForm(checked.form)
  if (!form.ok) {
    return { checked: { kind: 'none', why: form.error.detail }, rejected: form.error.detail }
  }
  return { checked: { ...checked, form: form.value }, rejected: null }
}

type Asking = { kind: 'act'; checked: Checked } | { kind: 'wait'; why: string } | { kind: 'fallback' }

/** Asks `factory-steward` once per stall and round: claim and commit, call with no transaction open, record. */
async function ask(deps: StewardDeps, facts: StallFacts): Out<Asking> {
  const subject = `wait:${facts.since}`
  const now = deps.clock.now()
  const policy = policyOf(deps)
  const claimed = await deps.uow.run<Claimed, never>(async (stores) =>
    ok(
      await claimRound(stores, {
        loop: 'steward',
        issue: facts.issue,
        subject,
        now,
        policy,
        keyFor: (round) => key('steward', facts.issue, facts.since, round),
      }),
    ),
  )
  if (!claimed.ok) return claimed
  const plan = claimed.value
  switch (plan.kind) {
    case 'answered': {
      // A replayed pass acts on the stored answer, never on a second call.
      const stored = plan.row.answer as StewardAnswer
      return ok({ kind: 'act', checked: judgeAnswer(facts, stored).checked })
    }
    case 'in_flight':
      return ok({ kind: 'wait', why: 'a call is in flight' })
    case 'backoff':
      return ok({ kind: 'wait', why: `the last ask came to nothing; the next waits until ${plan.until.toISOString()}` })
    case 'exhausted':
      return ok({ kind: 'fallback' })
    case 'claimed':
      break
  }

  const answered = await deps.workflow.ask(stallRequest(facts, now, scrub), plan.key)
  const verdict = answered.ok ? judgeAnswer(facts, answered.value) : null
  const recorded = await deps.uow.run(async ({ loops }) => {
    const at = deps.clock.now()
    if (!answered.ok) {
      await loops.finishCall(plan.key, {
        outcome: 'failed',
        answer: null,
        detail: `${answered.error.kind}: ${answered.error.detail}`.slice(0, 500),
        at,
      })
    } else if (verdict?.rejected) {
      await loops.finishCall(plan.key, {
        outcome: 'rejected',
        answer: answered.value,
        detail: verdict.rejected.slice(0, 500),
        at,
      })
    } else {
      await loops.finishCall(plan.key, {
        outcome: 'answered',
        answer: answered.value,
        detail: answered.value.reason,
        at,
      })
    }
    return ok(undefined)
  })
  if (!recorded.ok) return recorded
  if (verdict && !verdict.rejected) return ok({ kind: 'act', checked: verdict.checked })
  return ok({ kind: 'wait', why: answered.ok ? 'the answer was refused' : 'the ask failed' })
}

/** One stalled Issue: the rules first, the workflow only when they do not say. */
async function steward(deps: StewardDeps, id: IssueId, pass: StewardPass): Promise<void> {
  const loaded = await load(deps, id)
  if (!loaded.ok) {
    pass.problems.push(`${id}: ${loaded.error.detail}`)
    return
  }
  const facts = loaded.value
  if (!facts) return
  pass.looked++
  const action = decideStall(facts, deps.clock.now(), deps.rules)
  let acted: Result<Acted, PortError>
  switch (action.kind) {
    case 'wait':
      return
    case 'wake':
      acted = await act(deps, facts, { kind: 'wake', note: null, reason: action.detail.slice(STEWARD_DETAIL.length) })
      break
    case 'requeue':
      acted = await act(deps, facts, {
        kind: 'requeue',
        note: null,
        reason: action.detail.slice(STEWARD_DETAIL.length),
      })
      break
    case 'ask': {
      const asking = await ask(deps, facts)
      if (!asking.ok) {
        pass.problems.push(`${id}: ${asking.error.detail}`)
        return
      }
      if (asking.value.kind === 'wait') return
      if (asking.value.kind === 'fallback' && facts.cause === 'lead_gone') {
        // Its exit is a new attempt, which no Decision starts: it stays a stall the owner sees, and the problem says so.
        pass.problems.push(`${id}: lead_gone: ${MAX_ROUNDS} asks gave no usable answer; left stalled`)
        return
      }
      pass.asked++
      acted =
        asking.value.kind === 'act'
          ? await act(deps, facts, asking.value.checked)
          : await act(deps, facts, { kind: 'decision', form: fallbackDecision(facts), reason: 'no usable answer' })
      break
    }
  }
  if (!acted.ok) {
    pass.problems.push(`${id}: ${acted.error.detail}`)
    return
  }
  if (acted.value === 'woken') pass.woken++
  else if (acted.value === 'requeued') pass.requeued++
  else if (acted.value === 'decision') pass.decisions++
}

/**
 * The checkout a watch needs could not be moved for `blockedChecks` checks in a row (package 5 reads and waits, it does
 * not tell): the lead hears it once per watch, as a note. The machine has no stall for a watching Issue, so a note is the
 * one action the steward has here.
 */
async function noteBlockedCheckouts(deps: StewardDeps, pass: StewardPass): Promise<void> {
  const blocked = await deps.uow.run(async ({ loopReads }) =>
    ok(await loopReads.blockedCheckouts(deps.blockedChecks, PASS_LIMIT)),
  )
  if (!blocked.ok) {
    pass.problems.push(`blocked checkouts: ${blocked.error.detail}`)
    return
  }
  for (const watch of blocked.value) {
    const noted = await deps.uow.run(async ({ work }) => {
      const text = scrub(
        `The checkout that verify needs could not be moved to the shipped commit for ${watch.checks} checks in a row since ${watch.since.toISOString()}: ${watch.detail.replace(/\s+/g, ' ').slice(0, 300)}. Verify cannot pass until it can; fix the checkout, then the watch goes on.`,
      )
      const recorded = await recordIn(work, deps, {
        issueId: watch.issue,
        key: key('noted', 'steward', 'blocked-checkout', watch.issue, watch.watch),
        event: { kind: 'noted', payload: { text }, actor: 'steward' },
      })
      if (!recorded.ok) return err(portError('refused', JSON.stringify(recorded.error)))
      return ok(recorded.value.result === 'applied')
    })
    if (!noted.ok) pass.problems.push(`${watch.issue}: ${noted.error.detail}`)
    else if (noted.value) pass.noted++
  }
}

/**
 * The claim deadlock: a working or watching Issue is after an Issue of its own repo that stays queued for lack of a
 * claim, and holds the only one. It is deferred behind that Issue (a dependency wait frees the claim; the woken Issue is
 * counted as owed and served before new leads), with the reason in the event itself. The edge is the owner's `after`. Only open planning edges are read, never what a lead or a
 * subagent wrote: an Issue that merely mentions another is not detected.
 */
async function breakClaimDeadlocks(deps: StewardDeps, pass: StewardPass): Promise<void> {
  const queued = await deps.claimQueued()
  if (!queued.ok) {
    pass.problems.push(`claim queue: ${queued.error.detail}`)
    return
  }
  const holders = await deps.uow.run(async ({ loopReads }) =>
    ok(
      await loopReads.claimHolders(
        queued.value.map((q) => q.issue),
        PASS_LIMIT,
      ),
    ),
  )
  if (!holders.ok) {
    pass.problems.push(`claim holders: ${holders.error.detail}`)
    return
  }
  for (const holder of holders.value) {
    const deferred = await deferHolder(deps, holder)
    if (!deferred.ok) pass.problems.push(`${holder.issue}: ${deferred.error.detail}`)
    else if (deferred.value) pass.deferred++
  }
}

async function deferHolder(deps: StewardDeps, holder: ClaimHolder): Out<boolean> {
  return deps.uow.run(async ({ work }) => {
    const history = await work.history(holder.issue)
    if (!history) return ok(false)
    const issue = replay(holder.issue, history)
    if (issue.state !== 'working' && issue.state !== 'watching') return ok(false)
    const names = holder.blockers.map((id) => `Issue ${issueNumber(id)}`).join(', ')
    const why = `${names} stays queued for lack of a claim in ${issue.repo}, and this Issue holds it while it is after ${holder.blockers.length === 1 ? 'that Issue' : 'them'}`
    const wakes = holder.blockers.length === 1 ? 'it closes' : 'they close'
    const resumes = issue.state === 'watching' ? 'the watch runs again' : 'work resumes'
    const noted = await recordIn(work, deps, {
      issueId: issue.id,
      key: key('noted', 'steward', 'claim-deadlock', issue.id, issue.version),
      event: {
        kind: 'noted',
        payload: {
          text: `${why}: a deadlock. It is deferred behind ${names} and wakes when ${wakes}; then ${resumes}.`,
        },
        actor: 'steward',
      },
    })
    if (!noted.ok) return err(portError('refused', JSON.stringify(noted.error)))
    const deferred = await recordIn(work, deps, {
      issueId: issue.id,
      key: key('deferred', 'steward', 'claim-deadlock', issue.id, issue.version),
      event: {
        kind: 'deferred',
        payload: { attempt: issue.attempt, after: holder.blockers, why },
        actor: 'steward',
      },
    })
    if (!deferred.ok) return err(portError('refused', JSON.stringify(deferred.error)))
    // A refusal rolls the note back too: the deferral is one change.
    if (deferred.value.result === 'refused' || deferred.value.result === 'ignored') {
      return err(portError('refused', `the deferral was ${deferred.value.result}`))
    }
    return ok(deferred.value.result === 'applied')
  })
}

/** An Issue that stays `settling` after the timeout is settled with no edges: nothing waits forever for an answer. */
async function settleOverdue(deps: StewardDeps, pass: StewardPass): Promise<void> {
  const overdue = await deps.uow.run(async ({ loopReads }) => ok(await loopReads.settling(PASS_LIMIT)))
  if (!overdue.ok) {
    pass.problems.push(`settling: ${overdue.error.detail}`)
    return
  }
  const now = deps.clock.now().getTime()
  for (const row of overdue.value) {
    if (now - row.filedAt.getTime() < deps.settleTimeoutMs) continue
    const settled = await settleIssue(deps.planning, { issue: row.issue, after: [] })
    if (!settled.ok) pass.problems.push(`${row.issue}: settle: ${JSON.stringify(settled.error)}`.slice(0, 300))
    else if (settled.value.result === 'settled') pass.settled++
  }
}

/** One pass of the steward over the stalled Issues, the Issues settling too long and the checkouts blocked too long. */
export async function stewardPass(deps: StewardDeps): Out<StewardPass> {
  const pass: StewardPass = {
    looked: 0,
    woken: 0,
    requeued: 0,
    asked: 0,
    decisions: 0,
    settled: 0,
    noted: 0,
    deferred: 0,
    problems: [],
  }
  const stalled = await deps.uow.run(async ({ loopReads }) => ok(await loopReads.stalled(STALL_LIMIT)))
  if (!stalled.ok) return stalled
  for (const id of stalled.value) await steward(deps, id, pass)
  await settleOverdue(deps, pass)
  await noteBlockedCheckouts(deps, pass)
  await breakClaimDeadlocks(deps, pass)
  if (pass.woken + pass.requeued + pass.decisions + pass.settled + pass.noted + pass.deferred > 0) deps.changed()
  return ok(pass)
}

export const stewardSummary = (pass: StewardPass): string =>
  `looked at ${pass.looked} stalled; woken ${pass.woken}, requeued ${pass.requeued}, asked ${pass.asked}, Decisions ${pass.decisions}, settled ${pass.settled}, noted ${pass.noted}, deferred ${pass.deferred}${pass.problems.length ? `; ${pass.problems.length} problem(s): ${pass.problems.slice(0, 3).join(' | ')}` : ''}`
