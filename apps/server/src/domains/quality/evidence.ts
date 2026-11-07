/** `base..head`, as agw's review commands take a range. */
export interface ReviewRange {
  base: string
  head: string
}

/** What the commits a ship names are: where they landed, what they touched. Read from git, never from the lead. */
export interface CommitRead {
  /**
   * `origin/<default>` as it stood when the commits were proven landed: one sha that holds every commit named. What a
   * deployed version must hold, whatever a squash or a rebase did to the branch's own commits. Null when nothing was
   * proven landed.
   */
  landedAt: string | null
  /** the commits named, full, then what else the lead's branch holds */
  commits: string[]
  /** every path they touched */
  paths: string[]
  /** the newest committer time of the commits named */
  mergedAt: Date | null
  /** the Issue's own commits as ranges of the default branch, oldest first: what a review judges */
  reviewRanges: ReviewRange[]
}

/** One commit a review does not cover, with the review level agw says it needs. */
export interface UncoveredCommit {
  sha: string
  subject: string
  required: string
  reason?: string
}

/** What agw says of a range: the review it asks for and whether the ledger covers every commit in it. */
export interface ReviewRead {
  tier: string
  covered: boolean
  uncovered: UncoveredCommit[]
}

/** The merged commits a ship named, as evidence. */
export interface CommitsEvidence {
  commits: string[]
  landedAt: string | null
  mergedAt: string | null
  /** whether any path is one a deploy carries: docs, text and tests are not */
  deploys: boolean
  /** a sample, as `commits` is; `deploys` was worked out from all of them */
  paths: string[]
}

/**
 * The review of a ship, or the record that there was none. A review is evidence when it exists (`covered`); the others
 * are recorded with their reason, and never refuse a ship (NL23), so the friction loop can count them.
 */
export type ReviewStatus = 'covered' | 'not_required' | 'uncovered' | 'unknown'

export interface ReviewEvidence {
  status: ReviewStatus
  /** the level agw asked for; null when it was not asked */
  tier: string | null
  ranges: ReviewRange[]
  uncovered: UncoveredCommit[]
  /** why there is no review: what agw said, or why it could not be asked */
  reason: string | null
}

/** One check of a run of verify, as data, whatever it printed. */
export interface CheckRecord {
  name: string
  ok: boolean
  detail: string
}

export const MAX_RECORDED = 100

const TEXT_FILE = /\.(md|mdx|txt)$/
const TEST_DIR = /(^|\/)(test|tests|__tests__)\//
const TEST_FILE = /\.(test|spec)\./

/** A path no deploy carries: documents, text, licences and tests. Mirrors `scripts/verify.sh`'s `inert_path`. */
export function isInert(path: string): boolean {
  return (
    path.startsWith('docs/') ||
    TEXT_FILE.test(path) ||
    /(^|\/)LICENSE/.test(path) ||
    /(^|\/)\.gitignore$/.test(path) ||
    TEST_DIR.test(path) ||
    TEST_FILE.test(path)
  )
}

export const deploys = (paths: readonly string[]): boolean => paths.some((path) => !isInert(path))

/** The review as evidence, from what agw answered for the ship's ranges (null: it could not be asked). */
export function reviewOf(input: {
  ranges: readonly ReviewRange[]
  read: ReviewRead | null
  /** why `read` is null */
  problem: string | null
}): ReviewEvidence {
  const ranges = [...input.ranges]
  const { read } = input
  if (!read) {
    return {
      status: 'unknown',
      tier: null,
      ranges,
      uncovered: [],
      reason: input.problem ?? 'no review was asked: none of the commits is on the default branch to review',
    }
  }
  if (read.covered) {
    return {
      status: read.tier === 'none' ? 'not_required' : 'covered',
      tier: read.tier,
      ranges,
      uncovered: [],
      reason: null,
    }
  }
  const named = read.uncovered.map((c) => `${c.sha.slice(0, 12)} ${c.subject} (needs ${c.required})`).join('; ')
  return {
    status: 'uncovered',
    tier: read.tier,
    ranges,
    uncovered: read.uncovered,
    reason: `agw does not cover the range${named ? `: ${named}` : ''}`,
  }
}
