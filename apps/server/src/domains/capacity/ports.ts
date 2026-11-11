import type { IssueId } from '../../kernel/ids.ts'
import type { PortError, Result } from '../../kernel/result.ts'
import type { AccountRank, AccountReading } from './accounts.ts'
import type { Claim } from './claims.ts'
import type { MemoryReading } from './host.ts'
import type { ProcInfo } from './leadcost.ts'
import type { QueueState, QueueStates } from './queue-state.ts'
import type { SlotRow } from './slots.ts'

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
  /** replaces the stored rank of its lane */
  recordRank(rank: AccountRank): Promise<void>
  latestRank(lane: string): Promise<AccountRank | null>

  claims(): Promise<Claim[]>
  takeClaim(claim: Claim): Promise<void>
  /** gives these Issues' claims back; says which Issues held one */
  releaseClaims(issues: readonly IssueId[]): Promise<IssueId[]>
  assign(assignment: Assignment): Promise<void>
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
  /** a step's peaks, newest first (null: not measured) */
  recentPeaks(name: string, limit: number): Promise<(number | null)[]>
  /** the newest minute sample of the host: when, and the share of RAM in use */
  latestHostSample(): Promise<{ at: Date; memoryUsedPct: number | null } | null>
  /** the newest minute samples of the host, newest first */
  recentHostSamples(limit: number): Promise<HostSampleFact[]>
  /** per repo: the attempts sampled and the peak MiB of the newest ten, newest first (what `learnedLeadMib` takes) */
  leadPeaks(): Promise<LeadPeaks[]>
  /** per Issue number: the MiB its lead's tree held at its newest sample since `since` */
  leadRssSince(since: Date): Promise<Map<number, number>>
}

export interface HostSampleFact {
  at: Date
  load: number | null
  memoryUsedPct: number | null
  swapUsedPct: number | null
}

export interface LeadPeaks {
  repo: string
  attempts: number
  peaksNewestFirst: number[]
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
}

/** The machine the server runs on. Every reading may fail; admission then goes on without it. */
export interface HostReader {
  memory(): Promise<Result<MemoryReading>>
  /** the machine's RAM in MiB, for the memory that lanes reserve as a share of it */
  ramMib(): Promise<Result<number>>
  /** the 1-minute load average */
  load(): Promise<Result<number>>
}

/** The accounts and their windows, as the running core reads them (`claude-account usage --json`). */
export interface AccountSource {
  /** one poll; `at` is the poll's time, which a reading's `readAt` and `sampledAt` count from */
  read(at: Date): Promise<Result<AccountReading[]>>
}

/** The picker's order of accounts for a lane (`claude-account rank --lane <lane> --json`). */
export interface AccountRanker {
  /** one poll; `at` is the poll's time, which the rank's `readAt` is */
  read(at: Date): Promise<Result<AccountRank>>
}

export type { PortError }

/** The host's process table with each process's directory; null when it could not be read (never an error). */
export interface ProcessReader {
  read(): Promise<ProcInfo[] | null>
}
