import type { IssueId } from '../../kernel/ids.ts'
import type { Result } from '../../kernel/result.ts'
import type { CommitRead, ReviewRange, ReviewRead } from './evidence.ts'
import type { Check, ProjectChecks } from './watch.ts'

/**
 * Every port here is called outside any transaction and answers with a `Result`. A `refused` error from `Commits` says
 * the commits cannot count and why; the other kinds are a git or an agw that did not answer.
 */
export interface Commits {
  read(input: {
    repo: string
    /** the lead's branch and where its worktree was cut, when known: what else the branch holds counts too */
    branch: string | null
    cut: string | null
    /** the commits the ship names, as the lead wrote them */
    reported: readonly string[]
  }): Promise<Result<CommitRead>>
}

/** agw's review ledger: the factory only asks, and records the answer. */
export interface Review {
  read(input: { repo: string; ranges: readonly ReviewRange[] }): Promise<Result<ReviewRead>>
}

/** What the watch's verify runs; `signal` is the server stopping, and nothing of a check may outlive it. */
export interface ProofInput {
  repo: string
  /** the make contract says the repo has `make verify` */
  makeVerify: boolean
  /**
   * Set where the deployed version must hold what was shipped (a change that deploys, under deploy mode `make`): the
   * `origin/<default>` the ship found, or why there is none, which is red. Unset: the change deploys nothing.
   */
  version?: { landedAt: string } | { problem: string }
  probes: ProjectChecks['probes']
}

export interface Proof {
  /** the checks, each pass or fail; an error only when the server is stopping and the checks say nothing */
  run(input: ProofInput, signal: AbortSignal): Promise<Result<Check[]>>
}

/** The project's settings for the watch and its verify. The project file brings the real values with planning. */
export interface Projects {
  checksOf(repo: string): Promise<Result<ProjectChecks>>
}

/** Where a lead's branch was cut: the lead's package (4) knows; null when nothing is known of the attempt. */
export interface LeadCheckout {
  of(issue: IssueId, attempt: number): Promise<Result<{ branch: string; cut: string } | null>>
}
