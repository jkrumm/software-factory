import type { Result } from '../../kernel/result.ts'
import {
  type CommitRead,
  type AcceptanceEvidence,
  type CiEvidence,
  type CiRead,
  ciOf,
  type CommitsEvidence,
  deploys,
  MAX_RECORDED,
  type ReviewEvidence,
  type ReviewRead,
  reviewOf,
} from './evidence.ts'

export type ShipVerdict =
  | { accepted: true; commits: CommitsEvidence; review: ReviewEvidence; acceptance: AcceptanceEvidence; ci: CiEvidence }
  /** `error` is the verb's own: what the lead reads, naming what is missing */
  | { accepted: false; error: string }

/** What came back from agw for the ship's ranges: its answer, or why there is none. */
export interface ReviewOutcome {
  read: ReviewRead | null
  problem: string | null
}

/** What came back from the CI port for the ship's commits: its answer, or why there is none. */
export interface CiOutcome {
  read: CiRead | null
  problem: string | null
}

/**
 * The ship gate. A ship names merged commits, and git must have found them on the default branch: without that the
 * ship is refused, with the error named. A review is recorded as evidence when it exists and its absence is recorded
 * with its reason; it never refuses a ship (NL23). Pure: the same answers give the same verdict.
 */
export function judgeShip(input: {
  reported: readonly string[]
  commits: Result<CommitRead>
  review: ReviewOutcome
  /** the pull request's CI; recorded like the review, never judged */
  ci: CiOutcome
  /** the lead's acceptance lines, parsed; recorded, never judged */
  acceptance: AcceptanceEvidence
}): ShipVerdict {
  const refuse = (why: string): ShipVerdict => ({ accepted: false, error: `ship refused: ${why}` })
  if (input.reported.length === 0) return refuse('ship names no merged commit')
  if (!input.commits.ok) {
    const { kind, detail } = input.commits.error
    return refuse(kind === 'refused' ? detail : `the commits could not be read: ${detail}`)
  }
  const read = input.commits.value
  if (read.commits.length === 0) return refuse('ship names no merged commit')
  return {
    accepted: true,
    commits: {
      commits: read.commits.slice(0, MAX_RECORDED),
      landedAt: read.landedAt,
      mergedAt: read.mergedAt?.toISOString() ?? null,
      deploys: deploys(read.paths),
      paths: read.paths.slice(0, MAX_RECORDED),
    },
    review: reviewOf({ ranges: read.reviewRanges, ...input.review }),
    acceptance: input.acceptance,
    ci: ciOf(input.ci),
  }
}
