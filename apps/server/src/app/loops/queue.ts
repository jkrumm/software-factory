import { QueueAnswer } from '@software-factory/contract'
import type { CallPolicy, CallRow } from '../../domains/loops/calls.ts'
import type { LoopReads, LoopStore } from '../../domains/loops/ports.ts'
import {
  byRepo,
  candidatesOf,
  checkQueue,
  cycleIn,
  lastAskAt,
  type QueueEdge,
  pairKey,
  type QueueIssue,
  type RefusedEdge,
  requestOf,
  shapeAsked,
  shapeOf,
  unappliedAnswer,
} from '../../domains/loops/queue.ts'
import { sweepEdges } from '../../domains/loops/edge-need.ts'
import { EDGE_NEED_DAYS, type EdgeNeed, stopReason, stopsEdges } from '../../kernel/edge-need.ts'
import { AGW_CALL_LEASE_MS } from '../../kernel/agw.ts'
import type { Clock } from '../../kernel/clock.ts'
import type { AgwPort } from '../../kernel/agw.ts'
import { WORKFLOWS } from '../../kernel/workflows.ts'
import { ok, type PortError, type Result } from '../../kernel/result.ts'
import { scrub } from '../../kernel/scrub.ts'
import { type Claimed, claimRound } from './claim.ts'
import { addAfter, removeInferredEdge } from '../planning-chain.ts'
import type { PlanningDeps } from '../planning-deps.ts'
import type { UnitOfWork } from '../unit-of-work.ts'
import { passLoop, type LoopSpec, type LoopWiring } from './runner.ts'

export type QueueStores = { loops: LoopStore; loopReads: LoopReads }

export interface QueueDeps {
  uow: UnitOfWork<QueueStores>
  clock: Clock
  agw: AgwPort
  /** planning's `addAfter`: the blocker check and the cycle check are one transaction there */
  planning: PlanningDeps
  /** a failed ask of a shape is asked again this long on */
  retryMs: number
  /** a repo is asked about a new shape at most once in this long, a failed ask included */
  minGapMs: number
  /** a blocker that waited on the owner longer than this releases the edges the factory put behind it; the domain's default when absent */
  ownerWaitMs?: number | undefined
  /** lets the runner know the queue loop changed the chain (the loop guard keeps it from firing the loop again) */
  changed(): void
}

interface QueuePass {
  /** repos with open Issues */
  looked: number
  asked: number
  applied: number
  refused: number
  /** edges the factory added that the sweep took back */
  removed: number
  /** repos left unasked because they were asked lately or the pass had asked enough repos */
  budget: number
  problems: string[]
}

/** Repos asked in one pass: a call is a model run. */
const ASK_LIMIT = 3
type Out<T> = Promise<Result<T, PortError>>

/** What the pass knows of the edges before it asks about a repo: the pairs taken back and why new edges are not added. */
interface EdgeFacts {
  removed: ReadonlySet<string>
  /** set when the queue loop's own kind of edge is mostly not needed */
  stopped: string | null
}

const policyOf = (deps: QueueDeps): CallPolicy => ({
  maxRounds: WORKFLOWS.queue.retry.tries,
  retryMs: deps.retryMs,
  leaseMs: AGW_CALL_LEASE_MS,
})

type Decision =
  | { kind: 'apply'; row: CallRow }
  | { kind: 'skip' }
  | { kind: 'budget' }
  | { kind: 'ask'; claim: Claimed }

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
  facts: EdgeFacts,
): Promise<void> {
  const checked = checkQueue(rows, answer, facts)
  const applied: QueueEdge[] = []
  const refused: RefusedEdge[] = [...checked.refused]
  for (const edge of checked.accepted) {
    const added = await addAfter(deps.planning, {
      issue: edge.issue,
      after: [edge.after],
      inferredBy: `queue: ${edge.reason}`.slice(0, 200),
    })
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

async function queueRepo(
  deps: QueueDeps,
  repo: string,
  rows: readonly QueueIssue[],
  pass: QueuePass,
  facts: EdgeFacts,
): Promise<void> {
  const cycle = cycleIn(rows)
  if (cycle) {
    pass.problems.push(`${repo}: the chain has a cycle ${cycle.join(' -> ')}`)
    return
  }
  if (candidatesOf(rows).length < 2) return

  const shape = shapeOf(rows)
  const now = deps.clock.now()
  const decided = await deps.uow.run<Decision, never>(async ({ loops }) => {
    const asks = await loops.calls('queue', repo)
    const pending = unappliedAnswer(asks.filter((row) => row.subject === shape))
    if (pending) return ok({ kind: 'apply', row: pending })
    if (shapeAsked(asks, shape)) return ok({ kind: 'skip' })
    if (!asks.some((row) => row.subject === shape)) {
      const last = lastAskAt(asks)
      if (last && now.getTime() < last.getTime() + deps.minGapMs) return ok({ kind: 'budget' })
    }
    if (pass.asked >= ASK_LIMIT) return ok({ kind: 'budget' })
    const claim = await claimRound(
      { loops },
      {
        loop: 'queue',
        scope: repo,
        subject: shape,
        now,
        policy: policyOf(deps),
        keyFor: (round) => WORKFLOWS.queue.key(repo, shape, round),
      },
    )
    return ok({ kind: 'ask', claim })
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
      await applyAnswer(deps, repo, rows, { key: decision.row.key, shape }, stored.data, pass, facts)
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
  const answered = await deps.agw.run('queue', request, claimKey)
  const recorded = await deps.uow.run(async ({ loops }) => {
    const at = deps.clock.now()
    if (answered.ok) {
      await loops.finishCall(claimKey, {
        outcome: 'answered',
        answer: answered.value,
        detail: answered.value.reason,
        at,
      })
    } else {
      await loops.finishCall(claimKey, {
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
  await applyAnswer(deps, repo, rows, { key: claimKey, shape }, answered.value, pass, facts)
}

/**
 * Takes back the edges the factory added that no longer hold (`sweepEdges`): the two Issues' shipped files are disjoint,
 * or the blocker has waited on the owner past `ownerWaitMs`. An edge somebody stated is never read. Each removal is kept
 * with its reason (`queue_edge_removals`) and noted on the Issue.
 */
async function sweep(deps: QueueDeps, pass: QueuePass): Promise<void> {
  const held = await deps.uow.run(async ({ loopReads }) => ok(await loopReads.heldEdges()))
  if (!held.ok) {
    pass.problems.push(`edge sweep: ${held.error.detail}`)
    return
  }
  const options = deps.ownerWaitMs === undefined ? {} : { ownerWaitMs: deps.ownerWaitMs }
  for (const removal of sweepEdges(held.value, deps.clock.now(), options)) {
    const done = await removeInferredEdge(deps.planning, removal)
    if (done.ok && done.value.removed) pass.removed++
    else if (!done.ok)
      pass.problems.push(
        `edge sweep: ${removal.issue} -> ${removal.after}: ${JSON.stringify(done.error)}`.slice(0, 300),
      )
  }
}

/** The pairs the loop took back, and whether its own kind of edge is mostly not needed over the last `EDGE_NEED_DAYS`. */
async function edgeFacts(deps: QueueDeps, pass: QueuePass): Promise<EdgeFacts> {
  const now = deps.clock.now()
  const from = new Date(now.getTime() - EDGE_NEED_DAYS * 24 * 3_600_000)
  const read = await deps.uow.run(async ({ loopReads }) =>
    ok({ removed: await loopReads.removedEdges(), need: await loopReads.edgeNeed({ from, to: now }) }),
  )
  if (!read.ok) {
    pass.problems.push(`edge facts: ${read.error.detail}`)
    return { removed: new Set(), stopped: null }
  }
  const mine: EdgeNeed | undefined = read.value.need.find((need) => need.source === 'queue')
  return {
    removed: new Set(read.value.removed.map((pair) => pairKey(pair.issue, pair.after))),
    stopped: mine && stopsEdges(mine) ? stopReason(mine) : null,
  }
}

/**
 * One pass of the queue loop. First the sweep: an edge the factory added that no longer holds is taken back, so the
 * Issues behind it are candidates again. Then per repo, deterministic first: a cycle in the chain is a problem and no ask;
 * fewer than two queued Issues that wait for nothing leave nothing to order. Otherwise `factory-queue` is asked once per
 * shape of the queue (an edge this loop added is part of the shape it already asked about), at most once per `minGapMs`
 * per repo and for at most three repos a pass. Its edges are checked (`checkQueue`: none while its own kind of edge is
 * mostly not needed, never a pair the sweep took back) and added through planning; its order is stored and the admission
 * order reads it as the tie-break after size.
 */
async function queuePass(deps: QueueDeps): Out<QueuePass> {
  const pass: QueuePass = { looked: 0, asked: 0, applied: 0, refused: 0, removed: 0, budget: 0, problems: [] }
  await sweep(deps, pass)
  const facts = await edgeFacts(deps, pass)
  const read = await deps.uow.run(async ({ loopReads }) => ok(await loopReads.queueIssues()))
  if (!read.ok) return read
  for (const [repo, rows] of byRepo(read.value)) {
    pass.looked++
    await queueRepo(deps, repo, rows, pass, facts)
  }
  if (pass.applied > 0 || pass.removed > 0) deps.changed()
  return ok(pass)
}

const queueSummary = (pass: QueuePass): string =>
  `looked at ${pass.looked} repo(s); asked ${pass.asked}, applied ${pass.applied} edge(s), refused ${pass.refused}, took back ${pass.removed}, skipped for budget ${pass.budget}${pass.problems.length ? `; ${pass.problems.length} problem(s): ${pass.problems.slice(0, 3).join(' | ')}` : ''}`

/** Deterministic first (cycles, real blockers, the queue's shape, a budget); `factory-queue` only for an unclear order. */
export const queueLoop = (wiring: LoopWiring, deps: QueueDeps): LoopSpec =>
  passLoop(wiring, {
    name: 'queue',
    onChange: true,
    pass: () => queuePass(deps),
    problems: (pass) => pass.problems,
    summary: queueSummary,
  })
