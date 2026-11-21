import type { AccountMode, AccountModeBody, AccountRow, AccountsView } from '@software-factory/contract'
import type { IssueId } from '../../kernel/ids.ts'
import type { Result } from '../../kernel/result.ts'
import type { AccountReading } from './accounts.ts'
import type { Claim } from './claims.ts'
import type { SnapshotProc } from './classes.ts'
import type { MemoryReading } from './host.ts'
import type { AttemptPeak, ProcInfo } from './leadcost.ts'
import type { QueueState, QueueStates } from './queue-state.ts'
import type { PressureBaseline } from '../../kernel/remote-pressure.ts'
import type { RemoteReading } from './remote.ts'
import type { BenchEvent } from '../../kernel/remote-bench.ts'
import type { AimState, LeadAim } from './slot-aim.ts'
import type { SlotRow, StepHost, WaitKind } from './slots.ts'
import type { OpenWait, WaitPlan } from './waits.ts'

/** A lead's account, chosen when it was admitted. Package 4's `start_lead` reads the account of its attempt. */
export interface Assignment {
  issue: IssueId
  attempt: number
  account: string
  repo: string
  assignedAt: Date
}

/**
 * The capacity tables, inside one transaction. A database failure throws and aborts the transaction; the unit of work
 * turns it into a `PortError`.
 */
export interface CapacityStore {
  /** serializes everything that assigns a claim or an account, to the end of the transaction */
  lock(): Promise<void>

  recordReadings(readings: readonly AccountReading[]): Promise<void>
  /** the newest reading of every account that ever had one */
  latestReadings(): Promise<AccountReading[]>

  claims(): Promise<Claim[]>
  takeClaim(claim: Claim): Promise<void>
  /** gives these Issues' claims back; says which Issues held one */
  releaseClaims(issues: readonly IssueId[]): Promise<IssueId[]>
  assign(assignment: Assignment): Promise<void>
  /**
   * Moves an attempt to another account: its assignment (stamped `at`, so the account counts as loaded until its next
   * sample) and, when it holds one, its claim. Says whether the attempt had an assignment.
   */
  reassign(issue: IssueId, attempt: number, account: string, at: Date): Promise<boolean>
  /** the newest assignments: the leads an account's latest sample may not show yet */
  recentAssignments(): Promise<Assignment[]>
  assignmentOf(issue: IssueId, attempt: number): Promise<Assignment | null>
  latestAssignment(issue: IssueId): Promise<Assignment | null>
  /** the newest assignment of each of these Issues, however old (`recentAssignments` is the newest rows only) */
  latestAssignments(issues: readonly IssueId[]): Promise<Assignment[]>

  queueStates(): Promise<QueueStates>
  setQueueState(project: string | null, state: QueueState, at: Date): Promise<void>
  /** drops a project's state; the global one stays */
  removeQueueState(project: string): Promise<void>

  slots(): Promise<SlotRow[]>
  saveSlots(rows: readonly SlotRow[]): Promise<void>
  /** appends one finished step to the cost ledger */
  recordStepCost(cost: StepCostRow): Promise<void>
  /** appends one finished wait for a slot */
  recordSlotWait(wait: SlotWaitRow): Promise<void>
  /** appends one finished `factory merge-lock` call: its wait and its hold */
  recordMergeWindow(window: MergeWindowRow): Promise<void>
  /**
   * a step's runs, newest first (its peak, cores and run time), of the runs that did not end under host pressure (a pressure level
   * above normal or a swapout rate above `swapoutCeilingMb` in the host sample around the end). `legacy` adds the rows a
   * worktree's own step name left in that repo before steps were stored under the project's name (`factory-<n>-<a>` and
   * the same words after it).
   */
  recentRuns(
    name: string,
    limit: number,
    swapoutCeilingMb: number,
    legacy?: { repo: string; words: string },
  ): Promise<StepRun[]>
  /** the step's disagreements (a run on the mini that found a red off the mini green) and its green runs off the mini since `since`, any order */
  benchEvents(name: string, since: Date): Promise<BenchEvent[]>
  /** how many runs of the step (by its stored name) found the named test red off the mini and green on it */
  disagreementsOfTest(name: string, test: string): Promise<number>
  /** appends one reading of the step host's pressure: how many step containers ran at the time (`remote_samples`) */
  recordRemoteSample(sample: RemoteSampleRow): Promise<void>
  /** the samples taken with no step running over the last `BASELINE_WINDOW_MS`; null: none. Older samples are dropped. */
  pressureBaseline(now: Date): Promise<PressureBaseline | null>
  /** appends where a step its project declared remote was placed, and why it stayed on the mini */
  recordPlacement(placement: PlacementRow): Promise<void>
  /** the median run of every step that ended since `since`, in ms; null when none did */
  stepMedianMs(since: Date): Promise<number | null>
  /** the same for every step of a repo (its absolute path): each name, the worktree names of old rows read as `project`'s, with its newest peaks, of the runs since `since` */
  projectPeaks(
    repo: string,
    project: string,
    since: Date,
    limit: number,
    swapoutCeilingMb: number,
  ): Promise<Map<string, (number | null)[]>>
  /** the newest minute sample of the host: when, and the share of RAM in use */
  latestHostSample(): Promise<{ at: Date; memoryUsedPct: number | null; kernelFreePct: number | null } | null>
  /** the newest minute samples of the host, newest first */
  recentHostSamples(limit: number): Promise<HostSampleFact[]>
  /**
   * per repo (project name): the attempts sampled since its relearn point and the peaks of the newest twenty, newest first
   * (what `learnLeadCost` takes). A peak counts the samples of the attempt's last six hours only; `now` decides which
   * attempts have ended.
   */
  leadPeaks(now: Date): Promise<LeadPeaks[]>
  /** per repo (project name): the largest measured size of the newest twenty attempts' worktrees, newest first (what `learnedWorktreeMib` takes) */
  worktreeSizes(): Promise<WorktreeSizes[]>
  /** every repo's relearn point: samples before it are not learned from */
  relearns(): Promise<Relearn[]>
  /** stores the repo's relearn point (replacing an earlier one) */
  setRelearn(relearn: Relearn): Promise<void>
  /** per Issue number: the MiB its lead's tree held at its newest sample since `since` */
  leadRssSince(since: Date): Promise<Map<number, number>>
  /** the open queue intervals: one per Issue that is queued for a reason as of the last recorded look */
  openWaits(): Promise<OpenWait[]>
  /** closes and opens queue intervals at `at` (`planWaits`), and drops the closed ones that ended before `keepSince` */
  applyWaits(at: Date, plan: WaitPlan, keepSince: Date): Promise<void>
  /** the aimed slot count and the minute since which the host has been quiet; null before the first minute */
  slotAim(): Promise<AimState | null>
  saveSlotAim(state: AimState, at: Date): Promise<void>
  /** the count of leads the host takes (the lead aim) and the minute since which it has been quiet; null before the first minute */
  leadAim(): Promise<LeadAim | null>
  saveLeadAim(state: LeadAim): Promise<void>
  /** one minute of the aim beside the live rule (shadow) */
  recordSlotShadow(row: SlotShadowRow): Promise<void>
  pruneSlotShadow(before: Date): Promise<number>
}

/** One minute of the slot aim beside the live rule: what each allowed, who held and waited, the reading the aim moved on. */
export interface SlotShadowRow {
  at: Date
  liveSlots: number
  liveMax: number
  aimSlots: number
  holders: number
  waiters: number
  pressureLevel: number | null
  swapUsedPct: number | null
  swapoutMbPer300s: number | null
  swapGrowing: boolean
  load: number | null
  reason: string
  /** the lead aim's count that minute and the leads running; null: not recorded */
  leadAim: number | null
  leadsRunning: number | null
}

export interface HostSampleFact {
  at: Date
  load: number | null
  memoryUsedPct: number | null
  /** the kernel's own free share (`kern.memorystatus_level`), percent; null or absent: not read, the factory's own sum stands */
  kernelFreePct?: number | null
  swapUsedPct: number | null
  /** that minute's swapouts, scaled to 300 s */
  swapoutMbPer300s: number | null
  /** the process count of that minute's `top` header; null: not read */
  processes: number | null
  /** `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical */
  pressureLevel: number | null
}

/** What a repo's attempts' worktrees measured: the largest size of each, newest first. */
export interface WorktreeSizes {
  repo: string
  /** the attempts measured (all of them, not only the newest twenty) */
  attempts: number
  sizesMibNewestFirst: number[]
}

export interface LeadPeaks {
  repo: string
  /** the attempts sampled since the repo's relearn point (all of them, not only the newest twenty) */
  attempts: number
  peaksNewestFirst: AttemptPeak[]
}

/** The time before which a repo's lead samples are not learned from, and who set it when. */
export interface Relearn {
  repo: string
  at: Date
  setAt: Date
  setBy: string
}

/** What one run of a step took, as the grant learns from it. */
export interface StepRun {
  /** null: not measured */
  peakRssMib: number | null
  /** the cores it used: its CPU seconds over its run's seconds; null: not measured */
  cores: number | null
  durationMs: number
  /** where it ran: its run time is learned per host, its peak and cores across hosts */
  host: StepHost
}

/** One row of the cost ledger (`factory.step_costs`). */
export interface StepCostRow {
  at: Date
  name: string
  repo: string | null
  peakRssMib: number | null
  cpuSeconds: number | null
  durationMs: number
  waitMs: number
  exitCode: number | null
  /** the directory the step ran in: a lead's steps run inside its worktree */
  cwd: string | null
  /** the commit the step ran on, and whether the tree had uncommitted changes (null: not read) */
  commit?: string | undefined
  dirty?: boolean | undefined
  /** the test results the step wrote as JUnit (`factory.test_results`), stored beside the cost */
  tests?: readonly TestResultRow[] | undefined
  /** where it ran; absent: the mini */
  host?: StepHost | undefined
  /** off the mini: the git tree it ran on */
  tree?: string | undefined
  /** a run on the mini that found a red off the mini green */
  disagreed?: boolean | undefined
  /** with `disagreed`: what the red run off the mini failed on */
  disagreement?: Disagreement | undefined
}

/** What a red run off the mini failed on: the failing tests, else the last lines of its output. */
export interface Disagreement {
  tests: readonly { name: string; durationMs: number; timeoutMs: number | null }[]
  tail: string | null
}

/** One reading of the step host's production pressure (`factory.remote_samples`). */
export interface RemoteSampleRow {
  at: Date
  memoryPressure: number | null
  ioPressure: number | null
  stepsRunning: number
}

/** Why a step its project declared remote ran where it did: `vps`, or on the mini for `free` (a slot was free), `no_room`, `not_sooner` or `held`. */
export type PlacementReason = 'vps' | 'free' | 'no_room' | 'not_sooner' | 'held'

export interface PlacementRow {
  at: Date
  name: string
  host: StepHost
  reason: PlacementReason
}

/** One test result of a step: a suite, a test, its status and how long it took. */
export interface TestResultRow {
  suite: string
  name: string
  status: 'pass' | 'fail' | 'skip'
  durationMs: number
}

/** One finished wait for a test slot (`factory.slot_waits`): how long, and the split of it by what it waited for. */
export interface SlotWaitRow {
  at: Date
  name: string
  repo: string | null
  cwd: string | null
  outcome: 'granted' | 'gave_up'
  waitMs: number
  split: Readonly<Partial<Record<WaitKind, number>>>
  /** the host it was granted on; null: it gave up, or the mini before hosts were recorded */
  host?: StepHost | null | undefined
}

/** One row of the merge-window ledger (`factory.merge_windows`). */
export interface MergeWindowRow {
  project: string
  cwd: string | null
  requestedAt: Date
  /** null when the call never got the window */
  acquiredAt: Date | null
  releasedAt: Date
  exitCode: number | null
}

/** The machine the server runs on. Every reading may fail; admission then goes on without it. */
/** What the VPS's newest probe said: its reading, the project copies on it and the step containers running there. */
export interface RemoteProbeAnswer {
  reading: RemoteReading
  /** `factory-steps/<project>/<slot>` directories on the VPS */
  copies: readonly string[]
  /** step containers: their slot id and start (epoch ms; 0 when unlabelled) */
  steps: readonly { id: string; startedMs: number }[]
}

/**
 * The VPS that runs steps off the mini. `latest` returns the newest answer at once (null before the first) and starts a new
 * probe in the background when that one is old, so the placement never waits on the VPS; `live` names the slot ids that
 * hold a VPS slot, and a step container of any other id is removed.
 */
export interface RemoteHostProbe {
  /** `live` null: the slots were not read yet in this process, so no container is removed */
  latest(live: ReadonlySet<string> | null): RemoteProbeAnswer | null
}

export interface HostReader {
  memory(): Promise<Result<MemoryReading>>
  /** the machine's RAM in MiB, for the memory that lanes reserve as a share of it */
  ramMib(): Promise<Result<number>>
  /** the 1-minute load average */
  load(): Promise<Result<number>>
  /** how long the host has been up, in ms (`kern.boottime`); the boot grace counts from it */
  uptimeMs(): Promise<Result<number>>
  /** the free and the total disk of the volume the worktrees live on, in MiB; absent: no disk reading, and no lead is kept out for disk */
  disk?(): Promise<Result<{ freeMib: number; totalMib: number }>>
}

/** Measures what a worktree takes on disk, the checkout and its build output together; null when it could not be read. */
export interface WorktreeSizer {
  sizeMib(path: string): Promise<number | null>
}

/** What `packages/accounts` says of one account: `claude-account status --json` as the contract names it, before the factory adds its allowance. */
export type AccountStatusRow = Omit<
  AccountRow,
  | 'seats'
  | 'leads'
  | 'account'
  | 'fiveHourUsed'
  | 'weeklyUsed'
  | 'fiveHourResetsAt'
  | 'weeklyResetsAt'
  | 'exhaustedUntil'
  | 'fresh'
  | 'rank'
  | 'rankReason'
>
export type AccountsStatus = Omit<AccountsView, 'accounts'> & { accounts: AccountStatusRow[] }

/**
 * The accounts' read model and its one write, in this process (`packages/accounts`): the status of every account and the
 * mode override. Nothing here keeps a rule of its own; the package decides what state an account is in.
 */
export interface AccountDesk {
  /** the status at `at`; `history` false skips the forecast and the reset ledger (what a poll that needs only the lanes asks) */
  status(at: Date, options?: { history?: boolean }): Result<AccountsStatus>
  /** sets a mode override; a request the package refuses (an unknown account, a past time) is `refused` */
  setMode(account: string, body: AccountModeBody, at: Date): Result<AccountMode>
  /** clears the override; the registry's mode applies again */
  clearMode(account: string, at: Date): Result<AccountMode>
}

/** The accounts and their windows with the package's verdict for the bulk lane, read in-process (`packages/accounts`). */
export interface AccountSource {
  /** one poll; `at` is the poll's time, which a reading's `readAt` and `sampledAt` count from */
  read(at: Date): Promise<Result<AccountReading[]>>
}

/** The host's process table with each process's directory; null when it could not be read (never an error). */
export interface ProcessReader {
  read(): Promise<ProcInfo[] | null>
}

/** One minute's class snapshot as read: the processes and the host signals beside them (a figure not read is null). */
export interface HostSnapshotReading {
  /** null when `ps`, `launchctl` or `lsof` could not be read: the classes would be wrong, the signals still hold */
  procs: SnapshotProc[] | null
  /** the process count of `top`'s header */
  processes: number | null
  cpuIdlePct: number | null
  /** the header's user and system CPU shares, percent of all cores */
  cpuUserPct: number | null
  cpuSysPct: number | null
  /** `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical */
  pressureLevel: number | null
  /** `kern.memorystatus_level`: the share of RAM the kernel counts as available, percent; null when unread */
  kernelFreePct: number | null
  compressorMib: number | null
  vmFreeGib: number | null
  /** the CPU the readings' helper processes took since the last snapshot */
  collectorCpuMs: number
}

/** Reads the class snapshot; null when `top` could not be read (never an error). */
export interface HostSnapshotReader {
  read(): Promise<HostSnapshotReading | null>
}
