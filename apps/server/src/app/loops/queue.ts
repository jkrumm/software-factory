import { QueueAnswer } from '@software-factory/contract'
import { type CallPlan, type CallPolicy, planCall } from '../../domains/loops/calls.ts'
import type { LoopReads, LoopStore, QueueWorkflow } from '../../domains/loops/ports.ts'
import {
  byRepo,
  candidatesOf,
  checkQueue,
  cycleIn,
  type QueueAskRow,
  type QueueEdge,
  type QueueIssue,
  type RefusedEdge,
  requestOf,
  shapeOf,
} from '../../domains/loops/queue.ts'
import { MAX_ROUNDS } from '../../domains/loops/stall.ts'
import { AGW_HANG_GUARD_MS } from '../../kernel/agw.ts'
import type { Clock } from '../../kernel/clock.ts'
import { type Key, key } from '../../kernel/keys.ts'
import { ok, type PortError, type Result } from '../../kernel/result.ts'
import { scrub } from '../../kernel/scrub.ts'
import { addAfter } from '../planning-chain.ts'
import type { PlanningDeps } from '../planning-deps.ts'
import type { UnitOfWork } from '../unit-of-work.ts'

export type QueueStores = { loops: LoopStore; loopReads: LoopReads }

export interface QueueDeps {
  uow: UnitOfWork<QueueStores>
  clock: Clock
  workflow: QueueWorkflow
  /** planning's `addAfter`: the blocker check and the cycle check are one transaction there */
  planning: PlanningDeps
  /** a failed ask of a shape is asked again this long on */
  retryMs: number
  /** a repo is asked about a new shape at most once in this long, a failed ask included */
  minGapMs: number
  /** lets the runner know the queue loop changed the chain (the loop guard keeps it from firing the loop again) */
  changed(): void
}

export interface QueuePass {
  /** repos with open Issues */
  looked: number
  asked: number
  applied: number
  refused: number
  /** repos left unasked because they were asked lately or the pass had asked enough repos */
  budget: number
  problems: string[]
}

/** Repos asked in one pass: a call is a model run. */
const ASK_LIMIT = 3
type Out<T> = Promise<Result<T, PortError>>

const policyOf = (deps: QueueDeps): CallPolicy => ({
  maxRounds: MAX_ROUNDS,
  retryMs: deps.retryMs,
  leaseMs: AGW_HANG_GUARD_MS + 5 * 60_000,
})

/** What the loop does about one shape: the stored ask, a wait, or a call this pass now owns (`claimed`, a retaken one included). */
type QueueClaim = Exclude<CallPlan<QueueAskRow>, { kind: 'claim' | 'retake' }> | { kind: 'claimed'; key: Key }

/** Claim and commit, as `claimRound` does for an Issue: the call itself is made by the caller with no transaction open. */
async function claimQueueRound(
  stores: { loops: LoopStore },
  input: { repo: string; shape: string; now: Date; policy: CallPolicy },
): Promise<QueueClaim> {
  const { loops } = stores
  const plan = planCall(await loops.queueAsks(input.repo, input.shape), input.now, input.policy)
  const leaseUntil = new Date(input.now.getTime() + input.policy.leaseMs)
  if (plan.kind === 'retake') {
    const taken = await loops.retakeQueueAsk(plan.row.key, input.now, leaseUntil)
    return taken ? { kind: 'claimed', key: plan.row.key as Key } : { kind: 'in_flight' }
  }
  if (plan.kind !== 'claim') return plan
  const claimKey = key('queue', input.repo, input.shape, plan.round)
  const won = await loops.claimQueueAsk({
    key: claimKey,
    repo: input.repo,
    shape: input.shape,
    round: plan.round,
    claimedAt: input.now,
    leaseUntil,
  })
  return won ? { kind: 'claimed', key: claimKey } : { kind: 'in_flight' }
}

type Decision =
  | { kind: 'apply'; row: QueueAskRow }
  | { kind: 'skip' }
  | { kind: 'budget' }
  | { kind: 'ask'; claim: QueueClaim }

/**
 * Applies an answer: the accepted edges one by one through planning, which checks the blocker and the cycle again. A
 * refusal there refuses that edge only. Then the repo is read again, and what was done and the shape it left are stored.
 */
async function applyAnswer(
  deps: QueueDeps,
  repo: string,
  rows: readonly QueueIssue[],
  ask: { key: string; shape: string },
  answer: QueueAnswer,
  pass: QueuePass,
): Promise<void> {
  const checked = checkQueue(rows, answer)
  const applied: QueueEdge[] = []
  const refused: RefusedEdge[] = [...checked.refused]
  for (const edge of checked.accepted) {
    const added = await addAfter(deps.planning, { issue: edge.issue, after: [edge.after] })
    if (added.ok && added.value.edges > 0) applied.push(edge)
    else if (added.ok) refused.push({ issue: edge.issue, after: edge.after, why: 'the edge exists already' })
    else {
      const why = added.error.kind
      refused.push({ issue: edge.issue, after: edge.after, why: `planning: ${why}` })
    }
  }
  const reread = await deps.uow.run(async ({ loopReads }) => ok(await loopReads.queueIssues()))
  if (!reread.ok) {
    pass.problems.push(`${repo}: ${reread.error.detail}`)
    return
  }
  const afterShape = shapeOf(reread.value.filter((row) => row.repo === repo))
  const recorded = await deps.uow.run(async ({ loops }) => {
    await loops.recordQueueApplied(ask.key, { applied, refused, afterShape })
    return ok(undefined)
  })
  if (!recorded.ok) pass.problems.push(`${repo}: ${recorded.error.detail}`)
  pass.applied += applied.length
  pass.refused += refused.length
}

async function queueRepo(deps: QueueDeps, repo: string, rows: readonly QueueIssue[], pass: QueuePass): Promise<void> {
  const cycle = cycleIn(rows)
  if (cycle) {
    pass.problems.push(`${repo}: the chain has a cycle ${cycle.join(' -> ')}`)
    return
  }
  if (candidatesOf(rows).length < 2) return

  const shape = shapeOf(rows)
  const now = deps.clock.now()
  const decided = await deps.uow.run<Decision, never>(async ({ loops }) => {
    const rounds = await loops.queueAsks(repo, shape)
    // A crash between the answer and its application: the stored answer is applied, with no second call.
    const pending = rounds.find((row) => row.outcome === 'answered' && row.applied === null)
    if (pending) return ok({ kind: 'apply', row: pending })
    if (await loops.shapeAsked(repo, shape)) return ok({ kind: 'skip' })
    if (rounds.length === 0) {
      const last = await loops.lastQueueAskAt(repo)
      if (last && now.getTime() < last.getTime() + deps.minGapMs) return ok({ kind: 'budget' })
    }
    if (pass.asked >= ASK_LIMIT) return ok({ kind: 'budget' })
    return ok({ kind: 'ask', claim: await claimQueueRound({ loops }, { repo, shape, now, policy: policyOf(deps) }) })
  })
  if (!decided.ok) {
    pass.problems.push(`${repo}: ${decided.error.detail}`)
    return
  }
  const decision = decided.value
  if (decision.kind === 'skip') return
  if (decision.kind === 'budget') {
    pass.budget++
    return
  }
  if (decision.kind === 'apply') {
    const stored = QueueAnswer.safeParse(decision.row.answer)
    if (stored.success) {
      await applyAnswer(deps, repo, rows, { key: decision.row.key, shape }, stored.data, pass)
      return
    }
    pass.problems.push(`${repo}: the stored answer of ${decision.row.key} does not parse`)
    return
  }
  // In flight, backing off, or out of rounds: nothing to do until the lease or the retry window passes.
  if (decision.claim.kind !== 'claimed') return

  const request = requestOf(rows, now, scrub)
  if (!request) return
  const claimKey = decision.claim.key
  pass.asked++
  const answered = await deps.workflow.ask(request, claimKey)
  const recorded = await deps.uow.run(async ({ loops }) => {
    const at = deps.clock.now()
    if (answered.ok) {
      await loops.finishQueueAsk(claimKey, {
        outcome: 'answered',
        answer: answered.value,
        detail: answered.value.reason,
        at,
      })
    } else {
      await loops.finishQueueAsk(claimKey, {
        outcome: 'failed',
        answer: null,
        detail: `${answered.error.kind}: ${answered.error.detail}`.slice(0, 500),
        at,
      })
    }
    return ok(undefined)
  })
  if (!recorded.ok) {
    pass.problems.push(`${repo}: ${recorded.error.detail}`)
    return
  }
  if (!answered.ok) {
    pass.problems.push(`${repo}: ${answered.error.kind}: ${answered.error.detail}`.slice(0, 300))
    return
  }
  await applyAnswer(deps, repo, rows, { key: claimKey, shape }, answered.value, pass)
}

/**
 * One pass of the queue loop. Per repo, deterministic first: a cycle in the chain is a problem and no ask; fewer than two
 * queued Issues that wait for nothing leave nothing to order. Otherwise `factory-queue` is asked once per shape of the queue
 * (an edge this loop added is part of the shape it already asked about), at most once per `minGapMs` per repo and for at
 * most three repos a pass. Its edges are checked (`checkQueue`) and added through planning; its order is stored, never applied.
 */
export async function queuePass(deps: QueueDeps): Out<QueuePass> {
  const pass: QueuePass = { looked: 0, asked: 0, applied: 0, refused: 0, budget: 0, problems: [] }
  const read = await deps.uow.run(async ({ loopReads }) => ok(await loopReads.queueIssues()))
  if (!read.ok) return read
  for (const [repo, rows] of byRepo(read.value)) {
    pass.looked++
    await queueRepo(deps, repo, rows, pass)
  }
  if (pass.applied > 0) deps.changed()
  return ok(pass)
}

export const queueSummary = (pass: QueuePass): string =>
  `looked at ${pass.looked} repo(s); asked ${pass.asked}, applied ${pass.applied} edge(s), refused ${pass.refused}, skipped for budget ${pass.budget}${pass.problems.length ? `; ${pass.problems.length} problem(s): ${pass.problems.slice(0, 3).join(' | ')}` : ''}`
