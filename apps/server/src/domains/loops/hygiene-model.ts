import {
  type CatalogueName,
  HYGIENE_CATALOGUE,
  HYGIENE_DEFAULTS,
  type HygieneCandidate,
} from '@software-factory/contract'
import type { DepsThresholds } from '@software-factory/contract'
import type { PortError, Result } from '../../kernel/result.ts'
import type { UpgradeRow } from './upgrades.ts'

/**
 * The shapes the hygiene loop moves between its deterministic sweep (`adapters/hygiene/`, the I/O) and its pass
 * (`app/loops/hygiene.ts`, the decisions). Types only; the rules over them live in `hygiene.ts`.
 */

/** A deterministic probe: every catalogue entry but the document judgment, which is one agent call and no probe. */
export type Probe = Exclude<CatalogueName, 'judgment'>

/**
 * The deterministic probes, in the order their findings are filed when the budget is short: the catalogue's order
 * (`HYGIENE_CATALOGUE`). `probe` is last: the probes a project declares (`hygiene.probes`), one run and at most one finding
 * each, after every built-in probe.
 */
export const PROBES: readonly Probe[] = HYGIENE_CATALOGUE.map((entry) => entry.name).filter(
  (name): name is Probe => name !== 'judgment',
)

/**
 * How much of the catalogue a pass runs: `full` every probe and the document judgment (weekly, monthly for an idle repo, or
 * sooner for a busy one), `steady` all but the probes and the judgment the catalogue marks `idle: 'monthly'` (an idle repo's
 * weekly pass), `daily` the probes the catalogue marks `daily` and no judgment.
 */
export type Scope = 'full' | 'steady' | 'daily'

/**
 * Whether the default branch has had no commit for `idleAfterDays` (the catalogue's default when absent; 0 is never idle).
 * A repo whose newest commit is unknown is never idle: the weekly pass stays whole.
 */
export function isIdle(input: { lastCommitAt: string | undefined; idleAfterDays?: number; now: Date }): boolean {
  const days = input.idleAfterDays ?? HYGIENE_DEFAULTS.idleAfterDays
  const at = input.lastCommitAt === undefined ? Number.NaN : Date.parse(input.lastCommitAt)
  if (days === 0 || Number.isNaN(at)) return false
  return input.now.getTime() - at > days * 86_400_000
}

/** Whether a probe runs in a pass of this scope. */
export const runsIn = (probe: Probe, scope: Scope): boolean => {
  if (scope === 'full') return true
  const entry = HYGIENE_CATALOGUE.find((candidate) => candidate.name === probe)
  if (scope === 'steady') return !(entry && 'idle' in entry)
  return entry?.cadence === 'daily'
}

/** A probe a project declares in `project.yaml`: `make <target>` in the checkout, red on any exit but 0. */
export interface DeclaredProbe {
  name: string
  target: string
}

/** Documents under these directories are a record, not a reference: no staleness, filler or link finding is raised for them. */
export const ARCHIVE_DIRS = [
  'docs/research',
  'docs/rewrite',
  'docs/evidence',
  'docs/spikes',
  'docs/waves',
  'docs/history',
] as const

export type DependencyEcosystem = 'npm' | 'cargo' | 'python' | 'swift' | 'docker' | 'actions'

/** One outdated dependency of one ecosystem; `dev` is a tool the build uses and the product does not run (a dev dependency, a GitHub Action). */
export interface DependencyRow extends UpgradeRow {
  ecosystem: DependencyEcosystem
  dev: boolean
}

/** A high or critical advisory that has a fixed version; one without is listed in the probe's detail and never filed. */
export interface AdvisoryRow {
  pkg: string
  version: string
  id: string
  severity: 'critical' | 'high'
  fixedIn: string
  source: 'bun' | 'osv'
}

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
  /** the command that shows it again, when it is not `make check` or a sweep */
  reproduce?: string
  /** facts after the evidence, uncapped: the `deps` finding's upgrade plan and procedure */
  plan?: string[]
  /** the `deps` probe's rows of one ecosystem, folded into the one `deps` finding by `foldDependencies` and never stored */
  rows?: DependencyRow[]
  /** the `advisories` probe's advisories with a fixed version, folded the same way */
  advisories?: AdvisoryRow[]
}

export const MAX_EVIDENCE_LINES = 8

/** How a probe ended: `skipped` when the repo has nothing for it (no Makefile target, no package.json), `failed` when it could not run. */
export interface ProbeRun {
  probe: Probe
  outcome: 'clean' | 'found' | 'skipped' | 'failed'
  /** one line: what it ran, how long, why it was skipped or failed */
  detail: string
  /**
   * The finding keys this run is the verdict on: a key equal to it, or under it (`links` covers `links:docs/a.md`; a declared
   * probe covers `probe:<name>`). A run that is `clean` or `found` covers them: a covered key it did not raise is green. Absent
   * on a run recorded before the lifecycle: such a run covers nothing.
   */
  covers?: string
  /** exact keys under `covers` the run did not judge (a part of the probe failed or was skipped), or `*` for all of them: neither raised nor green */
  unjudged?: string[]
}

/** What one sweep of one checkout found; stored as the pass's `report`. */
export interface SweepReport {
  /** the commit swept (full sha) */
  ref: string
  /** how much of the catalogue ran; absent on a pass recorded before the daily scope: it was `full` */
  scope?: Scope
  /** when the default branch's newest commit was made (ISO); absent when git could not say: the repo is then never idle */
  lastCommitAt?: string
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

/** A built-in probe a project switches off in `project.yaml` (`hygiene.skip`), with its reason. */
export interface SkippedProbe {
  probe: Exclude<Probe, 'check' | 'probe'>
  reason: string
}

/** What the project's project.yaml lets a sweep run. */
export interface SweepOptions {
  /** the project's own words for why `make check` is not run here (its check needs a lab this host lacks, or its doctor says so); absent runs it */
  skipCheck?: string
  /** the probes the project declares (`hygiene.probes`); absent or empty runs none */
  probes?: readonly DeclaredProbe[]
  /** the built-in probes the project opts out of (`hygiene.skip`): each is `skipped` with its reason */
  skip?: readonly SkippedProbe[]
  /** how much of the catalogue runs; absent is `full` */
  scope?: Scope
  /** the bar the `deps` refresh must clear; absent is the catalogue's defaults */
  deps?: DepsThresholds
  /** a `steady` pass becomes a full one when the default branch has a commit younger than this many days; 0 never */
  idleAfterDays?: number
  /** only these probes run, no judgment candidates: a scripted fix asks the probe it fixed again (`applyFixes`) */
  only?: readonly Probe[]
}

/**
 * What a scripted fix did to one finding key: `fixed` (the script ran to its end), `failed` (it did not), `skipped` (it does
 * not apply here, with why), `deferred` (it could not start now, say for want of a test slot: nothing is filed for the key
 * this pass and the next pass asks again).
 */
export const FIX_OUTCOMES = ['fixed', 'failed', 'skipped', 'deferred'] as const
export type FixOutcome = (typeof FIX_OUTCOMES)[number]

/** One scripted fix, as the pass records it (`hygiene_passes.fixes`). The probe's second run says whether the key is green. */
export interface FixEntry {
  key: string
  outcome: FixOutcome
  /** one line: what the script did, or why it failed or did not start */
  detail: string
  /** the tail of the script's output when it failed: it goes on the finding, so the lead who gets the Issue has the failure */
  output?: string[]
}

/** How a project's changes land (`project.yaml` `ship`): a fix pushes to the default branch where the repo ships by push and merges a pull request where it ships by pull request. */
export type Landing = 'push' | 'pr'

export interface FixOptions {
  /** what the sweep ran with; the probes a fix ran for are asked again with the same opt-outs */
  sweep: SweepOptions
  landing: Landing
  /** the project's name: the merge window a pull request lands in is the project's */
  project: string
}

/** The sweep after its scripted fixes: the report with the fixed probes' second run in it, and what each fix did. */
export interface FixedReport {
  report: SweepReport
  fixes: FixEntry[]
}

/**
 * The I/O of a pass. `withCheckout` fetches, makes a detached worktree under the factory's data directory (at origin's default
 * branch when `ref` is null, at `ref` otherwise), calls `use`, and removes the worktree on every path. `sweep` runs the
 * probes of the scope in the checkout and never throws: a probe that cannot run is a `ProbeRun` of outcome `failed`.
 * `commitsSince` counts the commits of the checkout after `ref` (null when `ref` is not in its history or git failed).
 */
export interface HygieneChecker {
  withCheckout<T>(
    repo: string,
    ref: string | null,
    use: (checkout: Checkout) => Promise<T>,
  ): Promise<Result<T, PortError>>
  sweep(checkout: Checkout, options?: SweepOptions): Promise<SweepReport>
  commitsSince(checkout: Checkout, ref: string): Promise<number | null>
  /**
   * Runs the scripted fix of each red finding of `report` that has one (`HYGIENE_CATALOGUE` `fix`), in the checkout, then asks
   * the probes it fixed again and returns the report with their second run in it. Never throws: a fix that cannot run is a
   * `FixEntry` of outcome `failed` or `skipped`. Absent: no fix exists (a seam for tests of the decisions).
   */
  fix?(checkout: Checkout, report: SweepReport, options: FixOptions): Promise<FixedReport>
}
