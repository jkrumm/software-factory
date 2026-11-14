import type { ErrandScreenRequest } from '@software-factory/contract'
import { type DecisionId, type JudgeInput, judgeInputOf, precedentTerms } from '../domains/checkpoints/decision.ts'
import { checkErrandScreen, type ErrandId } from '../domains/checkpoints/errand.ts'
import { type DecisionRecord, type ErrandRecord, statusOf } from '../domains/checkpoints/ports.ts'
import {
  eventLines,
  type Recheck,
  type RecheckCandidate,
  recheckDue,
  recheckErrandDetail,
  recheckHours,
  recheckJudgeInput,
  recheckVerdict,
  type RecheckOutcome,
  REASON_MAX,
  replacedBy,
  versionAt,
  withdrawalReason,
} from '../domains/checkpoints/recheck.ts'
import { type AppliedRecord, replay } from '../domains/work/machine.ts'
import type { Issue } from '../domains/work/issue.ts'
import { key } from '../kernel/keys.ts'
import { ok, type PortError, type Result } from '../kernel/result.ts'
import {
  answerIn,
  type CheckpointError,
  type CheckpointStores,
  endJoined,
  formDigest,
  waitingOn,
} from './checkpoints.ts'
import { turnAway } from './checkpoints-errands.ts'
import { PASS_LIMIT, type SettleDeps } from './checkpoints-settle.ts'

export interface Rechecked {
  checkpoint: string
  kind: 'decision' | 'errand'
  outcome: RecheckOutcome
}

/** The candidates one pass reads: most of them are not due again (no new Issue event) and are skipped. */
const CANDIDATE_LIMIT = 200

type Step<T> = Promise<Result<T, CheckpointError | PortError>>

/** What the first look came to: nothing to do, a deterministic verdict already recorded, or a call to make. */
type Looked =
  | { action: 'skip' }
  | { action: 'done'; outcome: RecheckOutcome }
  | {
      action: 'decide'
      decision: DecisionRecord
      input: JudgeInput
      seen: number
    }
  | {
      action: 'screen'
      errand: ErrandRecord
      request: ErrandScreenRequest
      seen: number
    }

/** What the call came to: a verdict to record, or nothing (the checkpoint changed under it). */
type Recorded = RecheckOutcome | 'dropped'

const reasonOf = (text: string): string => text.trim().slice(0, REASON_MAX) || 'no reason given'

async function record(
  stores: CheckpointStores,
  deps: SettleDeps,
  recheck: Omit<Recheck, 'at' | 'reason'> & { reason: string },
) {
  await stores.checkpoints.insertRecheck({ ...recheck, reason: reasonOf(recheck.reason), at: deps.clock.now() })
}

/** The Issue as it is now and its log, read under the checkpoint's lock. */
async function issueAndLog(stores: CheckpointStores, candidate: RecheckCandidate) {
  const history = await stores.work.history(candidate.issueId)
  return history ? { history, issue: replay(candidate.issueId, history) } : null
}

/** What the first look knows of the checkpoint, shared by both kinds. */
interface Seen {
  stores: CheckpointStores
  at: Date
  issue: Issue
  waiting: boolean
  closed: boolean
  events: readonly AppliedRecord[]
  base: Omit<Recheck, 'outcome' | 'by' | 'reason' | 'at'>
}

async function lookDecision(deps: SettleDeps, seen: Seen, decision: DecisionRecord): Promise<Looked> {
  const { stores, at, issue, waiting, closed, events, base } = seen
  const { checkpoints } = stores
  const others = waiting ? [] : await checkpoints.decisions({ issueId: decision.issueId, limit: 100 })
  const reason = withdrawalReason({ waiting, closed, replacedBy: replacedBy(decision, others) })
  if (reason) {
    await checkpoints.withdrawDecision(decision.id, reason, at)
    await checkpoints.cancelPages(decision.id, at)
    await record(stores, deps, { ...base, outcome: 'withdrawn', by: 'factory', reason })
    return { action: 'done', outcome: 'withdrawn' }
  }
  const terms = precedentTerms(decision.form.question)
  const plain = judgeInputOf({
    decision: decision.id,
    repo: decision.repo,
    issue: issue.title,
    form: decision.form,
    precedents: terms ? await checkpoints.precedents(terms, { excluding: decision.id, limit: 5 }) : [],
  })
  return {
    action: 'decide',
    decision,
    input: recheckJudgeInput(plain, eventLines(events), deps.recheckAfterMs),
    seen: issue.version,
  }
}

async function lookErrand(deps: SettleDeps, seen: Seen, errand: ErrandRecord): Promise<Looked> {
  const { stores, at, issue, waiting, closed, events, base } = seen
  const reason = withdrawalReason({ waiting, closed, replacedBy: null })
  if (reason) {
    const ended = await endJoined(stores, deps, errand, { turnedAway: `${reason}: raise it again if it still applies` })
    if (!ended.ok)
      throw new Error(`errand ${errand.id} could not end its joined Issues: ${JSON.stringify(ended.error)}`)
    await stores.checkpoints.finishErrand(errand.id, at, reason)
    await stores.checkpoints.cancelPages(errand.id, at)
    await record(stores, deps, { ...base, outcome: 'withdrawn', by: 'factory', reason })
    return { action: 'done', outcome: 'withdrawn' }
  }
  return {
    action: 'screen',
    errand,
    request: {
      errand: {
        id: errand.id,
        summary: errand.summary,
        detail: recheckErrandDetail(errand.detail, eventLines(events, 2800), deps.recheckAfterMs),
      },
      issue: { id: issue.id, repo: issue.repo, title: issue.title, kind: issue.kind },
    },
    seen: issue.version,
  }
}

/** The checkpoint under its lock when it is still open and still at the owner; null otherwise. */
async function lockedAtOwner(
  { checkpoints }: CheckpointStores,
  candidate: RecheckCandidate,
): Promise<{ decision: DecisionRecord } | { errand: ErrandRecord } | null> {
  if (candidate.kind === 'decision') {
    const decision = await checkpoints.lockDecision(candidate.id as DecisionId)
    if (!decision || statusOf(decision) !== 'open') return null
    return decision.steps.find((step) => step.step === 'owner')?.outcome === 'open' ? { decision } : null
  }
  const errand = await checkpoints.lockErrand(candidate.id as ErrandId)
  return errand?.issueId && !errand.doneAt && errand.reachedOwnerAt ? { errand } : null
}

/**
 * The first look, in one transaction: the checkpoint under its lock, still open and still at the owner; due; and then the
 * deterministic verdict. An Issue that moved past it withdraws it with the reason. Anything else gets the events since it
 * was raised, for the call.
 */
async function look(deps: SettleDeps, candidate: RecheckCandidate): Step<Looked> {
  return deps.uow.run<Looked, CheckpointError>(async (stores) => {
    const at = deps.clock.now()
    const locked = await lockedAtOwner(stores, candidate)
    if (!locked) return ok({ action: 'skip' })
    const found = await issueAndLog(stores, candidate)
    if (!found) return ok({ action: 'skip' })
    const { history, issue } = found
    const since = candidate.throughVersion ?? versionAt(history, candidate.reachedAt)
    const due = recheckDue({
      reachedAt: candidate.reachedAt,
      lastCheckedAt: candidate.lastCheckedAt,
      now: at,
      afterMs: deps.recheckAfterMs,
      issueVersion: issue.version,
      throughVersion: since,
    })
    if (!due) return ok({ action: 'skip' })

    const seen: Seen = {
      stores,
      at,
      issue,
      waiting: waitingOn(issue, candidate.kind, candidate.id),
      closed: issue.state === 'closed',
      events: history.filter((event) => event.version > since),
      base: {
        checkpointId: candidate.id,
        kind: candidate.kind,
        issueId: candidate.issueId,
        throughVersion: issue.version,
      },
    }
    return ok(
      'decision' in locked
        ? await lookDecision(deps, seen, locked.decision)
        : await lookErrand(deps, seen, locked.errand),
    )
  })
}

/** The Issue is still where the call found it: no event came while it ran. */
const unmoved = (issue: Issue | undefined, seen: number): boolean => issue?.version === seen

async function recordDecision(
  deps: SettleDeps,
  candidate: RecheckCandidate,
  looked: Extract<Looked, { action: 'decide' }>,
  verdict: Awaited<ReturnType<SettleDeps['judge']['judge']>>,
): Step<Recorded> {
  return deps.uow.run<Recorded, CheckpointError>(async (stores) => {
    const { decision, seen } = looked
    const fresh = await stores.checkpoints.lockDecision(decision.id)
    if (!fresh || statusOf(fresh) !== 'open' || formDigest(fresh.form) !== formDigest(decision.form)) {
      return ok('dropped')
    }
    const found = await issueAndLog(stores, candidate)
    if (!unmoved(found?.issue, seen)) return ok('dropped')
    const base = {
      checkpointId: decision.id,
      kind: 'decision',
      issueId: decision.issueId,
      throughVersion: seen,
    } as const

    const made = recheckVerdict(fresh.form, verdict)
    if (made.action === 'kept') {
      await record(stores, deps, { ...base, outcome: 'kept', by: 'judge', reason: made.reason })
      return ok('kept')
    }
    const guarded = made
    const hours = recheckHours(deps.recheckAfterMs)
    const answered = await answerIn(stores, deps, {
      decision: fresh,
      text: guarded.answer,
      by: 'judge',
      source: guarded.source,
      note: `Rechecked after ${hours} h without an answer from the owner, the Judge settled it from the newer evidence (${guarded.source}): ${guarded.answer}. The owner can overrule it with a note.`,
    })
    if (!answered.ok) return answered.error.kind === 'already_answered' ? ok('dropped') : answered
    if (answered.value.status !== 'answered') return ok('dropped')
    await record(stores, deps, {
      ...base,
      outcome: 'settled',
      by: 'judge',
      reason: made.reason,
    })
    return ok('settled')
  })
}

async function recordErrand(
  deps: SettleDeps,
  candidate: RecheckCandidate,
  looked: Extract<Looked, { action: 'screen' }>,
  answer: Awaited<ReturnType<SettleDeps['errandScreen']['screen']>>,
): Step<Recorded> {
  return deps.uow.run<Recorded, CheckpointError>(async (stores) => {
    const { errand, seen } = looked
    const fresh = await stores.checkpoints.lockErrand(errand.id)
    if (!fresh || fresh.doneAt || !fresh.reachedOwnerAt) return ok('dropped')
    const found = await issueAndLog(stores, candidate)
    if (!unmoved(found?.issue, seen)) return ok('dropped')
    const base = { checkpointId: errand.id, kind: 'errand', issueId: candidate.issueId, throughVersion: seen } as const

    if (!answer.ok) {
      await record(stores, deps, {
        ...base,
        outcome: 'kept',
        by: 'judge',
        reason: `${answer.error.kind}: ${answer.error.detail}`,
      })
      return ok('kept')
    }
    const checked = checkErrandScreen(answer.value)
    if (checked.action !== 'turn_away') {
      const reason = checked.action === 'pass' ? checked.note : checked.why
      await record(stores, deps, { ...base, outcome: 'kept', by: 'judge', reason })
      return ok('kept')
    }
    const turned = await turnAway(stores, deps, fresh, 'judge', checked.reason)
    if (!turned.ok) return turned
    await record(stores, deps, { ...base, outcome: 'settled', by: 'judge', reason: checked.reason })
    return ok('settled')
  })
}

/**
 * Looks once more at one checkpoint: the deterministic verdict first, then the Judge with the newer events. The port is
 * called with no transaction open; the result is recorded in a new one that re-reads the checkpoint and the Issue, and a
 * checkpoint that changed under the call records nothing.
 */
async function recheckOne(deps: SettleDeps, candidate: RecheckCandidate): Step<Rechecked | null | 'skipped'> {
  const first = await look(deps, candidate)
  if (!first.ok) return first
  const looked = first.value
  const rechecked = (outcome: Recorded): Rechecked | null =>
    outcome === 'dropped' ? null : { checkpoint: candidate.id, kind: candidate.kind, outcome }
  if (looked.action === 'skip') return ok('skipped')
  if (looked.action === 'done') return ok(rechecked(looked.outcome))

  if (looked.action === 'decide') {
    const verdict = await deps.judge.judge(looked.input, key('factory-ask', 'recheck', candidate.id, looked.seen))
    const done = await recordDecision(deps, candidate, looked, verdict)
    return done.ok ? ok(rechecked(done.value)) : done
  }
  const answer = await deps.errandScreen.screen(
    looked.request,
    key('factory-errand', 'recheck', candidate.id, looked.seen),
  )
  const done = await recordErrand(deps, candidate, looked, answer)
  return done.ok ? ok(rechecked(done.value)) : done
}

/**
 * One pass over the checkpoints that have been in front of the owner longer than `recheckAfterMs`, oldest first. Each is
 * looked at once more (`docs/architecture.md`, Loops and agw): withdrawn when its Issue moved past it, else given to the
 * Judge with the Issue's events since, which may settle it. Every look is a `checkpoint_rechecks` row; the next one needs a
 * new Issue event.
 */
export async function recheckOpen(deps: SettleDeps, limit = PASS_LIMIT): Step<Rechecked[]> {
  if (deps.recheckAfterMs <= 0) return ok([])
  const reachedBefore = new Date(deps.clock.now().getTime() - deps.recheckAfterMs)
  const waiting = await deps.uow.run(async ({ checkpoints }) =>
    ok(await checkpoints.recheckCandidates({ reachedBefore, limit: CANDIDATE_LIMIT })),
  )
  if (!waiting.ok) return waiting
  const report: Rechecked[] = []
  // A candidate with no new Issue event is skipped at no cost; only a look that did work counts against the limit, so a
  // kept checkpoint never starves a newer one.
  let worked = 0
  for (const candidate of waiting.value) {
    if (worked >= limit) break
    const result = await recheckOne(deps, candidate)
    if (!result.ok) {
      worked += 1
      console.error(`checkpoints: ${candidate.id} could not be rechecked: ${JSON.stringify(result.error)}`)
    } else if (result.value !== 'skipped') {
      worked += 1
      if (result.value) report.push(result.value)
    }
  }
  return ok(report)
}
