import { SPEC_WAIT_HOURS } from '@software-factory/contract'
import type { ArtifactId } from '../domains/checkpoints/artifact.ts'
import { deepLink, reviewPushPage } from '../domains/checkpoints/page.ts'
import { type Recheck, type ReviewWait, STALE_REVIEW_MS } from '../domains/checkpoints/recheck.ts'
import { ok, type PortError, type Result } from '../kernel/result.ts'
import { type CheckpointError, giveVerdict, issueOf, waitingOn } from './checkpoints.ts'
import type { SettleDeps } from './checkpoints-settle.ts'

/** What the look at a Concept or Spec that waited a day for the owner came to. */
export interface ReviewLooked {
  artifact: string
  outcome: 'withdrawn' | 'defaulted' | 'pushed'
}

/** The Concepts and Specs one pass looks at. */
const REVIEW_LIMIT = 50

const SPEC_WAIT_MS = SPEC_WAIT_HOURS * 3_600_000

/** A filed Spec holds its Issue in the queue: until a lead starts, the Issue is settling or queued. */
const holdsFiledSpec = (issue: { state: string }): boolean => issue.state === 'settling' || issue.state === 'queued'

type Step<T> = Promise<Result<T, CheckpointError | PortError>>

type Look = { outcome: ReviewLooked['outcome']; reason: string }

/**
 * What a Concept or Spec that waited a day is: `withdrawn` when its Issue moved past it or closed, `defaulted` when its Issue
 * carries the `spec` checkpoint and its wait ran out (the lead goes on with the defaults it named), else `pushed`, once.
 * Pure: the same facts give the same look.
 */
export function lookAtReview(input: {
  wait: ReviewWait
  now: Date
  closed: boolean
  waiting: boolean
  flaggedSpec: boolean
}): Look {
  const { wait, now, closed, waiting, flaggedSpec } = input
  if (closed || !waiting) {
    return {
      outcome: 'withdrawn',
      reason: closed ? 'the Issue is closed' : 'the Issue no longer waits for this review',
    }
  }
  if (flaggedSpec && wait.kind === 'spec' && now.getTime() - wait.at.getTime() >= SPEC_WAIT_MS) {
    return {
      outcome: 'defaulted',
      reason: `no verdict in ${SPEC_WAIT_HOURS} hours: the lead goes on with the defaults the Spec names`,
    }
  }
  return { outcome: 'pushed', reason: 'unanswered for a day: pushed once' }
}

async function apply(deps: SettleDeps, wait: ReviewWait, look: Look): Step<null> {
  const artifactId = wait.artifact as ArtifactId
  if (look.outcome !== 'pushed') {
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
  }
  return deps.uow.run(async ({ work, checkpoints }) => {
    const at = deps.clock.now()
    const issue = await issueOf(work, wait.issueId)
    if (look.outcome === 'pushed' && issue) {
      await checkpoints.planPage(
        reviewPushPage({
          issue: { id: issue.id, repo: issue.repo },
          link: deepLink(deps.consoleUrl, wait.artifact),
          artifact: wait.artifact,
          revision: wait.revision,
          kind: wait.kind,
          title: wait.title,
        }),
        at,
      )
    }
    const recheck: Recheck = {
      checkpointId: wait.artifact,
      kind: 'artifact',
      issueId: wait.issueId,
      throughVersion: wait.revision,
      outcome: look.outcome === 'withdrawn' ? 'withdrawn' : look.outcome === 'defaulted' ? 'settled' : 'kept',
      by: 'factory',
      reason: look.reason,
      at,
    }
    await checkpoints.insertRecheck(recheck)
    return ok(null)
  })
}

/**
 * One pass over the Concepts and Specs the owner has not answered for a day, oldest first: each is looked at once per
 * revision (`lookAtReview`). A decision here is deterministic and calls no model; the verdict, the page and the recheck row
 * are keyed by the artifact and its revision, so a repeated pass changes nothing.
 */
export async function recheckReviews(deps: SettleDeps): Step<ReviewLooked[]> {
  const now = deps.clock.now()
  const before = new Date(now.getTime() - Math.min(STALE_REVIEW_MS, SPEC_WAIT_MS))
  const waits = await deps.uow.run(async ({ checkpoints }) =>
    ok(await checkpoints.staleReviews({ before, limit: REVIEW_LIMIT })),
  )
  if (!waits.ok) return waits
  const report: ReviewLooked[] = []
  for (const wait of waits.value) {
    if (now.getTime() - wait.at.getTime() < STALE_REVIEW_MS) continue
    const issue = await deps.uow.run(async ({ work }) => ok(await issueOf(work, wait.issueId)))
    if (!issue.ok) return issue
    if (!issue.value) continue
    const look = lookAtReview({
      wait,
      now,
      closed: issue.value.state === 'closed',
      waiting: waitingOn(issue.value, 'review', wait.artifact) || (wait.filed && holdsFiledSpec(issue.value)),
      flaggedSpec: issue.value.checkpoint === 'spec',
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
