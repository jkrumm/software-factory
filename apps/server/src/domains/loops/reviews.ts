import type { PortError, Result } from '../../kernel/result.ts'

/**
 * A pull request (GitHub) or merge request (GitLab) as the `reviews` loop reads it: whether it is still open, what the
 * reviewers decided, and how many reviews and comments others than its author made.
 */
export interface PrLook {
  state: 'open' | 'merged' | 'closed'
  decision: 'approved' | 'changes_requested' | 'review_required' | 'none'
  /** reviews and comments by anyone but the author */
  others: number
}

/** `gh pr view` / `glab mr view` for one pull request, in the repo's checkout. One call, never inside a transaction. */
export interface ReviewPort {
  look(input: { cwd: string | null; ref: string; work: boolean }): Promise<Result<PrLook, PortError>>
}

/** An Issue that waits on a pull request's review, and what it saw the first time the poll looked. */
export interface ExternalWait {
  issue: string
  repo: string
  /** the version that began the wait: a wake names it */
  since: number
  /** a URL or `#<number>` */
  ref: string
}

/** The review poll looks at every review wait this often. */
export const REVIEW_POLL_MS = 15 * 60_000

/**
 * What ends the wait, in the words the lead hears: the pull request merged or closed, was approved or got changes
 * requested, or has a review or comment by someone else that the first look did not see. Null while nothing happened.
 */
export function wakeReason(look: PrLook, baseline: number): string | null {
  if (look.state === 'merged') return 'the pull request was merged'
  if (look.state === 'closed') return 'the pull request was closed without merging'
  if (look.decision === 'approved') return 'the pull request was approved'
  if (look.decision === 'changes_requested') return 'a reviewer requested changes'
  if (look.others > baseline) return 'a reviewer commented'
  return null
}

/** `#91` and `91` are one pull request: the number the tools take. */
export const prNumber = (ref: string): string => ref.replace(/^#/, '')
