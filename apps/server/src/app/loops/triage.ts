import { SPEC_SCREEN_PRECEDENTS, type TriageAnswer } from '@software-factory/contract'
import type { CallPolicy } from '../../domains/loops/calls.ts'
import { cycleThrough } from '../../domains/planning/chain.ts'
import type { LoopReads, LoopStore, SettleWorkflow, SettlingRow } from '../../domains/loops/ports.ts'
import { checkSettle, MAX_CANDIDATES, type Refinement, settleRequest, settleRule } from '../../domains/loops/settle.ts'
import { MAX_ROUNDS } from '../../domains/loops/stall.ts'
import type { WorkStore } from '../../domains/work/ports.ts'
import { AGW_HANG_GUARD_MS } from '../../kernel/agw.ts'
import type { IssueId } from '../../kernel/ids.ts'
import { key } from '../../kernel/keys.ts'
import { ok, type PortError, type Result } from '../../kernel/result.ts'
import { scrub } from '../../kernel/scrub.ts'
import type { WriteDeps } from '../issues.ts'
import { readChain, settleIssue } from '../planning-chain.ts'
import type { PlanningDeps } from '../planning-deps.ts'
import type { UnitOfWork } from '../unit-of-work.ts'
import { type Claimed, claimRound } from './claim.ts'

export type TriageStores = { work: WorkStore; loops: LoopStore; loopReads: LoopReads }

export interface TriageDeps extends WriteDeps {
  uow: UnitOfWork<TriageStores>
  workflow: SettleWorkflow
  /** planning's use cases: the edges, the cycle check and the `settled` event are one transaction there */
  planning: PlanningDeps
  retryMs: number
  /** lets the runner know triage changed an Issue (the loop guard keeps it from firing triage again) */
  changed(): void
}

export interface TriagePass {
  looked: number
  /** settled by the rules, needing no edges */
  settled: number
  /** settled after `factory-triage` named its edges */
  chained: number
  /** settled with a kind `factory-triage` corrected */
  refined: number
  /** settled with `checkpoint: spec` set by `factory-triage` */
  flagged: number
  asked: number
  /** edges of an answer left out: one that inverts an existing edge, one that names an Issue filed later */
  dropped: number
  /** answers refused: an Issue it was not shown, a cycle, a blocker that closed */
  refused: number
  problems: string[]
}

const PASS_LIMIT = 20
type Out<T> = Promise<Result<T, PortError>>

const policyOf = (deps: TriageDeps): CallPolicy => ({
  maxRounds: MAX_ROUNDS,
  retryMs: deps.retryMs,
  leaseMs: AGW_HANG_GUARD_MS + 5 * 60_000,
})

/** Settles with no edges; a repeat of the call settles nothing twice. */
async function settleWithout(
  deps: TriageDeps,
  issue: IssueId,
  pass: TriagePass,
  refinement: Refinement = {},
): Promise<void> {
  const settled = await settleIssue(deps.planning, { issue, after: [], ...refinement })
  if (!settled.ok) pass.problems.push(`${issue}: ${JSON.stringify(settled.error)}`.slice(0, 300))
  else if (settled.value.result === 'settled') {
    pass.settled++
    countRefinement(pass, refinement)
  }
}

function countRefinement(pass: TriagePass, refinement: Refinement): void {
  if (refinement.kind) pass.refined++
  if (refinement.checkpoint) pass.flagged++
}

/**
 * Settles the Issue after the edges `factory-triage` named. Planning checks them again (every blocker open, no cycle), and
 * a refusal there is the answer refused: the Issue is settled with no edges rather than left behind.
 */
async function settleAfter(
  deps: TriageDeps,
  issue: IssueId,
  after: IssueId[],
  pass: TriagePass,
  refinement: Refinement = {},
): Promise<void> {
  const settled = await settleIssue(deps.planning, { issue, after, ...refinement })
  if (settled.ok) {
    if (settled.value.result === 'settled') {
      countRefinement(pass, refinement)
      if (after.length > 0) pass.chained++
      else pass.settled++
    }
    return
  }
  const planned = 'kind' in settled.error ? settled.error.kind : ''
  if (planned === 'cycle' || planned === 'issue_closed' || planned === 'unknown_issue') {
    pass.refused++
    // The refused answer's kind is dropped with its edges; the Spec flag does not depend on them and stands.
    await settleWithout(deps, issue, pass, { checkpoint: refinement.checkpoint })
    return
  }
  pass.problems.push(`${issue}: ${JSON.stringify(settled.error)}`.slice(0, 300))
}

async function askTriage(deps: TriageDeps, row: SettlingRow, pass: TriagePass): Promise<void> {
  const candidates = await deps.uow.run(async ({ loopReads }) =>
    ok(await loopReads.openIssues(row.repo, row.issue, MAX_CANDIDATES)),
  )
  if (!candidates.ok) {
    pass.problems.push(`${row.issue}: ${candidates.error.detail}`)
    return
  }
  const shown = candidates.value
  if (settleRule(row, shown) === 'now') {
    await settleWithout(deps, row.issue, pass)
    return
  }
  // The chain as planning checks it, so what is dropped here is what planning would refuse as a cycle.
  const chained = await readChain(deps.planning)
  if (!chained.ok) {
    pass.problems.push(`${row.issue}: ${chained.error.detail}`)
    return
  }
  const waitsForIssue = (blocker: IssueId) => cycleThrough(chained.value, row.issue, blocker) !== undefined

  const now = deps.clock.now()
  const policy = policyOf(deps)
  const claimed = await deps.uow.run<Claimed, never>(async (stores) =>
    ok(
      await claimRound(stores, {
        loop: 'triage',
        issue: row.issue,
        subject: 'settle',
        now,
        policy,
        keyFor: (round) => key('triage', 'settle', row.issue, round),
      }),
    ),
  )
  if (!claimed.ok) {
    pass.problems.push(`${row.issue}: ${claimed.error.detail}`)
    return
  }
  const plan = claimed.value
  // A replayed pass acts on the stored answer, never on a second call. The answer was shown the candidates of its own pass:
  // checked again against these, an Issue that closed since is simply no longer one it may name.
  if (plan.kind === 'answered') {
    const checked = checkSettle(shown, row, plan.row.answer as TriageAnswer, waitsForIssue)
    if (checked.ok) await settleAfter(deps, row.issue, checked.after, pass, checked.refinement)
    else await settleWithout(deps, row.issue, pass)
    return
  }
  // In flight, backing off, or out of rounds: the steward settles it with no edges once the timeout passes.
  if (plan.kind !== 'claimed') return

  pass.asked++
  // The owner's newest needed-me marks go with the request: a mark changes the next settle, not next week's retro.
  const precedents = await deps.uow.run(async ({ loopReads }) =>
    ok(await loopReads.specPrecedents(SPEC_SCREEN_PRECEDENTS)),
  )
  const answered = await deps.workflow.settle(
    settleRequest(row, shown, scrub, precedents.ok ? precedents.value : []),
    plan.key,
  )
  const checked = answered.ok ? checkSettle(shown, row, answered.value, waitsForIssue) : null
  if (checked?.ok) pass.dropped += checked.dropped.length
  const recorded = await deps.uow.run(async ({ loops }) => {
    const at = deps.clock.now()
    if (!answered.ok) {
      await loops.finishCall(plan.key, {
        outcome: 'failed',
        answer: null,
        detail: `${answered.error.kind}: ${answered.error.detail}`.slice(0, 500),
        at,
      })
    } else if (checked && !checked.ok) {
      await loops.finishCall(plan.key, { outcome: 'rejected', answer: answered.value, detail: checked.why, at })
    } else {
      const dropped = checked?.ok ? checked.dropped : []
      await loops.finishCall(plan.key, {
        outcome: 'answered',
        answer: answered.value,
        detail: [answered.value.reason, ...dropped.map((edge) => `dropped: ${edge.why}`)].join('; ').slice(0, 500),
        at,
      })
    }
    return ok(undefined)
  })
  if (!recorded.ok) {
    pass.problems.push(`${row.issue}: ${recorded.error.detail}`)
    return
  }
  if (checked?.ok) await settleAfter(deps, row.issue, checked.after, pass, checked.refinement)
  else if (checked && !checked.ok) pass.refused++
}

/**
 * One pass of the triage loop over the Issues still `settling`: settle by the rules when no edges are needed, else ask
 * `factory-triage` once for the Issues it must wait for. An Issue whose answer was refused or never came stays settling
 * until the steward settles it after the timeout; nothing stays `settling` forever.
 */
export async function triagePass(deps: TriageDeps): Out<TriagePass> {
  const pass: TriagePass = {
    looked: 0,
    settled: 0,
    chained: 0,
    refined: 0,
    flagged: 0,
    asked: 0,
    dropped: 0,
    refused: 0,
    problems: [],
  }
  const settling = await deps.uow.run(async ({ loopReads }) => ok(await loopReads.settling(PASS_LIMIT)))
  if (!settling.ok) return settling
  for (const row of settling.value) {
    pass.looked++
    await askTriage(deps, row, pass)
  }
  if (pass.settled + pass.chained > 0) deps.changed()
  return ok(pass)
}

export const triageSummary = (pass: TriagePass): string =>
  `looked at ${pass.looked} settling; settled ${pass.settled}, chained ${pass.chained}, refined ${pass.refined}, flagged ${pass.flagged}, asked ${pass.asked}, dropped ${pass.dropped}, refused ${pass.refused}${pass.problems.length ? `; ${pass.problems.length} problem(s): ${pass.problems.slice(0, 3).join(' | ')}` : ''}`
