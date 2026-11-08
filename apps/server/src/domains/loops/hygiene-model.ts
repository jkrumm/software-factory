import type { HygieneCandidate } from '@software-factory/contract'
import type { PortError, Result } from '../../kernel/result.ts'

/**
 * The shapes the hygiene loop moves between its deterministic sweep (`adapters/hygiene/`, the I/O) and its pass
 * (`app/loops/hygiene.ts`, the decisions). Types only; the rules over them live in `hygiene.ts`.
 */

/** The deterministic probes, in the order their findings are filed when the budget is short. */
export const PROBES = ['check', 'links', 'retired', 'deps', 'cochange'] as const
export type Probe = (typeof PROBES)[number]

/** Documents under these directories are a record, not a reference: no staleness, filler or link finding is raised for them. */
export const ARCHIVE_DIRS = ['docs/research', 'docs/rewrite', 'docs/evidence', 'docs/spikes', 'docs/waves'] as const

/** One thing a probe found, ready to be a signal: `key` is stable per subject, so the same finding next week dedups. */
export interface ProbeFinding {
  probe: Probe
  /** `links:docs/a.md`, `deps`, `check`: one subject, one key */
  key: string
  /** one line, no counts or dates in it: intake's fingerprint is made of the title */
  title: string
  /** the evidence, at most `MAX_EVIDENCE_LINES` lines of at most 240 characters */
  lines: string[]
  /** how many items the finding groups (broken links in the file, outdated packages) */
  count: number
}

export const MAX_EVIDENCE_LINES = 8

/** How a probe ended: `skipped` when the repo has nothing for it (no Makefile target, no package.json), `failed` when it could not run. */
export interface ProbeRun {
  probe: Probe
  outcome: 'clean' | 'found' | 'skipped' | 'failed'
  /** one line: what it ran, how long, why it was skipped or failed */
  detail: string
}

/** What one sweep of one checkout found; stored as the pass's `report`. */
export interface SweepReport {
  /** the commit swept (full sha) */
  ref: string
  runs: ProbeRun[]
  findings: ProbeFinding[]
  /** living documents whose code moved on since they were last edited, most behind first */
  stale: HygieneCandidate[]
  /** living documents edited lately, most recent first */
  slop: HygieneCandidate[]
  /** why the candidates could not be read (the history scan failed); absent when they were */
  candidatesError?: string
}

/** A detached, throwaway worktree of the repo at `ref`. */
export interface Checkout {
  path: string
  /** the full sha checked out */
  ref: string
  /** the project's own checkout directory, which a red check is confirmed against */
  source: string
}

/** What the project's project.yaml lets a sweep run. */
export interface SweepOptions {
  /** the project's own words for why `make check` is not run here (its check needs a lab this host lacks); absent runs it */
  skipCheck?: string
}

/**
 * The I/O of a pass. `withCheckout` fetches, makes a detached worktree under the factory's data directory (at origin's default
 * branch when `ref` is null, at `ref` otherwise), calls `use`, and removes the worktree on every path. `sweep` runs every
 * probe in the checkout and never throws: a probe that cannot run is a `ProbeRun` of outcome `failed`.
 */
export interface HygieneChecker {
  withCheckout<T>(
    repo: string,
    ref: string | null,
    use: (checkout: Checkout) => Promise<T>,
  ): Promise<Result<T, PortError>>
  sweep(checkout: Checkout, options?: SweepOptions): Promise<SweepReport>
}
