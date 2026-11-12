import { SPEC_WAIT_HOURS } from '@software-factory/contract'
import type { ArtifactId } from '../domains/checkpoints/artifact.ts'
import { type Recheck, type ReviewWait, STALE_REVIEW_MS } from '../domains/checkpoints/recheck.ts'
import { ok, type PortError, type Result } from '../kernel/result.ts'
import { type CheckpointError, giveVerdict, issueOf, waitingOn } from './checkpoints.ts'
import type { SettleDeps } from './checkpoints-settle.ts'

/** What the look at a Concept or Spec that waited a day for the owner came to. */
export interface ReviewLooked {
  artifact: string
  outcome: 'withdrawn' | 'defaulted'
}

/** The Concepts and Specs one pass looks at. */
const REVIEW_LIMIT = 50

const SPEC_WAIT_MS = SPEC_WAIT_HOURS * 3_600_000

/** A filed Spec holds its Issue in the queue: until a lead starts, the Issue is settling or queued. */
const holdsFiledSpec = (issue: { state: string }): boolean => issue.state === 'settling' || issue.state === 'queued'

type Step<T> = Promise<Result<T, CheckpointError | PortError>>

type Look = { outcome: ReviewLooked['outcome']; reason: string }

/**
 * What a Concept or Spec that waited its `SPEC_WAIT_HOURS` is: `withdrawn` when its Issue moved past it or closed, else
 * `defaulted`, flagged Issue or not: the lead goes on with the defaults it named, and the owner can still overrule them with
 * a note. Nothing waits on the owner for good, so the callers look only at a wait that has run out. Pure: the same facts give
 * the same look.
 */
export function lookAtReview(input: { wait: ReviewWait; closed: boolean; waiting: boolean }): Look {
  const { wait, closed, waiting } = input
  if (closed || !waiting) {
    return {
      outcome: 'withdrawn',
      reason: closed ? 'the Issue is closed' : 'the Issue no longer waits for this review',
    }
  }
  return {
    outcome: 'defaulted',
    reason: `no verdict in ${SPEC_WAIT_HOURS} hours: the lead goes on with the defaults the ${wait.kind === 'spec' ? 'Spec' : 'Concept'} names`,
  }
}

async function apply(deps: SettleDeps, wait: ReviewWait, look: Look): Step<null> {
  const artifactId = wait.artifact as ArtifactId
  const given = await giveVerdict(deps, {
    artifactId,
    verdict: look.outcome === 'withdrawn' ? 'no_longer_applies' : 'looks_good',
    note:
      look.outcome === 'withdrawn'
        ? look.reason
        : `${look.reason}. Build on your defaults; the owner can still overrule them with a note.`,
    revision: wait.revision,
    by: 'factory',
  })
  if (!given.ok) return given
  return deps.uow.run(async ({ checkpoints }) => {
    const recheck: Recheck = {
      checkpointId: wait.artifact,
      kind: 'artifact',
      issueId: wait.issueId,
      throughVersion: wait.revision,
      outcome: look.outcome === 'withdrawn' ? 'withdrawn' : 'settled',
      by: 'factory',
      reason: look.reason,
      at: deps.clock.now(),
    }
    await checkpoints.insertRecheck(recheck)
    return ok(null)
  })
}

/**
 * One pass over the Concepts and Specs the owner has not answered for `SPEC_WAIT_HOURS`, oldest first: each is looked at
 * once per revision (`lookAtReview`). A decision here is deterministic and calls no model; the verdict and the recheck row
 * are keyed by the artifact and its revision, so a repeated pass changes nothing.
 */
export async function recheckReviews(deps: SettleDeps): Step<ReviewLooked[]> {
  const now = deps.clock.now()
  const before = new Date(now.getTime() - Math.max(STALE_REVIEW_MS, SPEC_WAIT_MS))
  const waits = await deps.uow.run(async ({ checkpoints }) =>
    ok(await checkpoints.staleReviews({ before, limit: REVIEW_LIMIT })),
  )
  if (!waits.ok) return waits
  const report: ReviewLooked[] = []
  for (const wait of waits.value) {
    const issue = await deps.uow.run(async ({ work }) => ok(await issueOf(work, wait.issueId)))
    if (!issue.ok) return issue
    if (!issue.value) continue
    const look = lookAtReview({
      wait,
      closed: issue.value.state === 'closed',
      waiting: waitingOn(issue.value, 'review', wait.artifact) || (wait.filed && holdsFiledSpec(issue.value)),
    })
    const applied = await apply(deps, wait, look)
    if (!applied.ok) {
      console.error(`checkpoints: ${wait.artifact} could not be looked at: ${JSON.stringify(applied.error)}`)
      continue
    }
    report.push({ artifact: wait.artifact, outcome: look.outcome })
  }
  return ok(report)
}
