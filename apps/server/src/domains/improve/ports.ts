import type { PortError, Result } from '../../kernel/result.ts'
import type {
  CapacityMinute,
  ClassCpuWindow,
  HostMinute,
  MigrationSnapshot,
  ProcessMinute,
  PsRow,
  QueueReasonCount,
  SelfwatchChange,
  SelfwatchRow,
  SlotMinute,
  WaitFact,
} from './selfwatch-model.ts'
import type { DigestIssue, DigestRecord, LatestDigest } from './digest.ts'
import type { LoopName } from '@software-factory/contract'
import type { ClosedFinding, Judged, LedgerLoop } from './ledger.ts'
import type { FindingRow, LedgerChange } from './throughput.ts'
import type { FinderIssue, FindingLoop } from './finders.ts'

/** One friction pass (a day or 200 closed Issues) as recorded (`migrations/0950_friction.sql`). */
export interface FrictionPassRecord {
  id: string
  at: Date
  windowFrom: Date
  windowTo: Date
  issues: number
  filed: { key: string; count: number; title: string }[]
  /** left out by the cap or by a muted finder */
  overBudget: { key: string; count: number }[]
  failed: { key: string; reason: string }[]
}

/** What the capacity layer holds at one minute (all null when it could not be read). */
export interface CapacityFacts {
  /** the leads running: claims held */
  leads: number | null
  /** the Issues queued */
  queued: number | null
  /** the leads the enabled accounts may hold */
  seats: number | null
  /** the load ceiling in force */
  loadCeiling: number | null
}

/** One reading of the host (`migrations/1002_host_samples.sql`); a figure that could not be read is null. */
export interface HostReading {
  load: number | null
  memoryUsedPct: number | null
  swapUsedPct: number | null
  swapoutMbPer300s: number | null
  /** the same as amounts, in bytes (`migrations/1044_host_bytes.sql`): the RAM, the memory in use, the swap in use and its size */
  ramBytes: number | null
  memoryUsedBytes: number | null
  swapUsedBytes: number | null
  swapTotalBytes: number | null
}

/** The host signals the class snapshot reads beside the processes (`migrations/1022_host_classes.sql`); null when not read. */
export interface HostSignals {
  /** `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical */
  pressureLevel: number | null
  /** `kern.memorystatus_level`: the share of RAM the kernel counts as available, percent; null when unread */
  kernelFreePct: number | null
  compressorMib: number | null
  processes: number | null
  cpuIdlePct: number | null
  /** the header's user and system CPU shares, percent of all cores */
  cpuUserPct: number | null
  cpuSysPct: number | null
  vmFreeGib: number | null
  /** the CPU the host loop's helper processes took since the last snapshot */
  collectorCpuMs: number | null
}

/** One minute as stored: the reading, the capacity facts (`migrations/1010_lead_samples.sql`) and the host signals. */
export type HostSampleRecord = HostReading & CapacityFacts & HostSignals

/** One row of `host_class_samples`: a class, repo, tenant, Issue and step summed over the minute. */
export interface ClassSampleRow {
  class: string
  repo: string | null
  tenant: string | null
  issue: number | null
  step: string | null
  footprintMib: number
  cpuMs: number | null
  procs: number
}

/** One notable process of the minute (`host_process_samples`): its program name only, never its command line. */
export interface ProcessSampleRow {
  pid: number
  ppid: number
  name: string
  class: string
  repo: string | null
  tenant: string | null
  issue: number | null
  footprintMib: number
  cpuMs: number | null
  why: 'top' | 'large' | 'growth'
  grownMib: number | null
}

/** What one lead's process tree cost at a sample, by its worktree. */
export interface LeadSampleRow {
  worktree: string
  repo: string
  issue: number | null
  attempt: number | null
  rssMib: number
  /** the physical footprint; null when `top` could not be read (`migrations/1021_lead_footprint.sql`) */
  footprintMib: number | null
  procs: number
}

/** One worktree's measured size (the checkout with its build output). */
export interface WorktreeSizeRow {
  worktree: string
  repo: string
  issue: number | null
  attempt: number | null
  mib: number
}

/** An attempt's worktree, from `lead_attempts`. */
export interface AttemptWorktree {
  path: string
  repo: string
  issue: number | null
  attempt: number | null
}

/** Reads the host. It never fails: a figure it cannot read is null in the record. */
export interface HostSampler {
  sample(): Promise<HostReading>
}

/** What the host itself says for an overload incident's evidence (called outside any transaction; every call has a process timeout). */
export interface OverloadHost {
  /** every process with its scheduling priority, read from `ps -axo pid=,pri=,pcpu=,rss=,command=` */
  processes(): Promise<Result<PsRow[], PortError>>
  /** the last `count` lines of `deploys.log`; none when it cannot be read */
  deployLines(count: number): Promise<string[]>
}

/** One finished CI run: how long it took, where it ran, how it ended and whether it passed only on a rerun. */
export interface CiRunTime {
  kind: 'default' | 'pr'
  minutes: number
  conclusion: 'success' | 'failure'
  /** passed on a rerun: a run attempt above 1 that ended green */
  flaky: boolean
}

/** The finished workflow runs of a repo created since a date (called outside any transaction); an error names why GitHub could not be read. */
export type CiTimes = (
  repo: string,
  since: Date,
) => Promise<Result<{ runs: CiRunTime[]; truncated: boolean }, PortError>>

/** One finished workflow run as the CI ledger keeps it (`factory.ci_runs`): queued at, started at and finished at. */
export interface CiLedgerRun {
  runId: number
  workflow: string
  event: string
  headBranch: string | null
  headSha: string
  runAttempt: number
  queuedAt: Date
  startedAt: Date
  finishedAt: Date
  conclusion: string
}

/** The finished workflow runs of a repo created since a date, whatever their conclusion (called outside any transaction). */
export type CiLedgerRuns = (repo: string, since: Date) => Promise<Result<CiLedgerRun[], PortError>>

/** Whether a branch has a workflow run that is queued or in progress (called outside any transaction). */
export interface CiLive {
  running(repo: string, branch: string): Promise<Result<boolean, PortError>>
}

/**
 * The migration files of a repo at its default branch and on the refs that can still merge: every branch that is not a
 * lead's and the lead branches of the `scope` Issues (called outside any transaction).
 */
export interface MigrationFiles {
  read(repo: string, scope: { openIssues: readonly number[] }): Promise<Result<MigrationSnapshot, PortError>>
}

/** The tables of the loops that watch the factory itself, inside one transaction: digests, host samples, the CI ledger, friction passes, loop passes and the findings ledger. */
export interface ImproveStore {
  /** the newest stored digest of each project, by project name */
  latestDigests(): Promise<Map<string, LatestDigest>>
  /** a new row: digests are facts, the newest one is read */
  recordDigest(record: DigestRecord): Promise<void>
  /** one sample at `at` with the lead rows of that minute; a second one at the same instant is ignored */
  recordHostSample(at: Date, sample: HostSampleRecord, leads: readonly LeadSampleRow[]): Promise<void>
  /** drops the samples older than `before`; how many */
  pruneHostSamples(before: Date): Promise<number>
  /** drops the lead samples older than `before`; how many */
  pruneLeadSamples(before: Date): Promise<number>
  /** stores each worktree's size, keeping the largest it ever measured (`migrations/1055_worktree_sizes.sql`) */
  recordWorktreeSizes(at: Date, sizes: readonly WorktreeSizeRow[]): Promise<void>
  pruneWorktreeSizes(before: Date): Promise<number>
  /** drops the test results older than `before`; how many */
  pruneTestResults(before: Date): Promise<number>
  /** the class rows and the notable processes of the minute at `at`; a process already stored at `at` is ignored */
  recordClassSnapshot(
    at: Date,
    classes: readonly ClassSampleRow[],
    processes: readonly ProcessSampleRow[],
  ): Promise<void>
  /** rolls every complete hour before `now`'s hour that has no rollup yet into `host_class_hours`; how many rows */
  rollUpClassHours(now: Date): Promise<number>
  /** drops the class and process rows older than `before`; how many */
  pruneClassSamples(before: Date): Promise<number>
  /** drops the hourly rollups older than `before`; how many */
  pruneClassHours(before: Date): Promise<number>
  /** when the newest run of the repo in the ledger finished, null for a repo with none */
  newestCiRun(repo: string): Promise<Date | null>
  /** stores the runs, a run already stored (same repo and run id) is overwritten; how many rows */
  recordCiRuns(repo: string, runs: readonly CiLedgerRun[]): Promise<number>
  /** drops the runs that finished before `before`; how many */
  pruneCiRuns(before: Date): Promise<number>
  /** the worktrees of the attempts that are live or ended since `since` */
  attemptWorktrees(since: Date): Promise<AttemptWorktree[]>
  /** when the newest friction pass ran; null before the first */
  lastFrictionPassAt(): Promise<Date | null>
  recordFrictionPass(pass: FrictionPassRecord): Promise<void>
  /** when each loop's pass last ended (`migrations/1000_loop_passes.sql`) */
  passes(): Promise<Map<LoopName, Date>>
  /** never moves a loop's time backwards */
  recordPass(name: LoopName, at: Date): Promise<void>
  /** the Issue a loop's finding opened, with the figure it was filed against (`migrations/0993_finding_classes.sql`, `1061_loop_ledger.sql`); a repeat is a no-op */
  recordFinding(row: {
    issue: string
    loop: LedgerLoop
    repo: string
    class: string
    key: string
    signal: string | null
    filedAt: Date
    figure: number | null
  }): Promise<void>
  /** the verdicts of closed findings: the figure read again and what it did; an Issue that has one is left */
  recordVerdicts(rows: readonly Judged[], at: Date): Promise<void>
  /** every subject the self-watch loop remembers: its newest row of `loop_findings` */
  selfwatchRows(): Promise<SelfwatchRow[]>
  /** the pass's changes in one transaction: filed rows upserted whole, seen rows touched, absent rows cleared */
  applySelfwatch(change: SelfwatchChange): Promise<void>
  /** the throughput loop's findings, oldest first (`loop_findings`, `migrations/1061_loop_ledger.sql`) */
  throughputFindings(): Promise<FindingRow[]>
  recordThroughputFinding(row: FindingRow): Promise<void>
  applyThroughputLedger(changes: readonly LedgerChange[]): Promise<void>
}

/** Read-only SQL on other domains' tables for the loops that watch the factory itself (`docs/architecture.md`: cross-domain SQL lives in `read/`). */
export interface ImproveReads {
  /** every Issue not closed and every one closed at or after `since`, with its open `after` edges (the digest loop and its read) */
  digestIssues(since: Date): Promise<DigestIssue[]>
  /** the Issues each finder of one loop filed (in every repo), with their closure and outcome, by finder */
  classIssues(loop: FindingLoop): Promise<Record<string, FinderIssue[]>>
  /** the Issues each Issue-opening loop's class filed (not the throughput loop's, which ranks by cost) */
  allClassIssues(): Promise<{ loop: FindingLoop; class: string; issues: FinderIssue[] }[]>
  /** the loop's findings whose Issue closed that have no verdict yet, and the newest closed one of each key; `repo` narrows to one repo */
  closedFindings(loop: LedgerLoop, repo?: string): Promise<ClosedFinding[]>
  /** the timer and dependency waits of the repo's Issues, with the times their exit is judged from (self-watch) */
  openWaits(repo: string): Promise<WaitFact[]>
  /** the notable processes of the host's minutes since `since`, oldest first (self-watch: runaway growth) */
  processMinutes(since: Date): Promise<ProcessMinute[]>
  /** the host's minute samples since `since`, oldest first (self-watch: swap growth, the process count) */
  hostMinutes(since: Date): Promise<HostMinute[]>
  /** the host's minute samples with their capacity facts since `since`, oldest first (self-watch: load, gates passed) */
  capacityMinutes(since: Date): Promise<CapacityMinute[]>
  /** the leads admitted since `since` (an Issue's applied `admitted` events), oldest first (self-watch: gates passed) */
  admissions(since: Date): Promise<{ at: Date; issue: string; load: number | null }[]>
  /** the test slots' minutes since `since`, oldest first (self-watch: the slot line) */
  slotMinutes(since: Date): Promise<SlotMinute[]>
  /** the queued Issues by the reason they stay queued, from the open queue intervals (the incident's evidence) */
  queueReasons(): Promise<QueueReasonCount[]>
  /** the CPU each class and repo took in the host minutes since `since` (the incident's evidence: whose work the load is) */
  classCpu(since: Date): Promise<ClassCpuWindow>
}
