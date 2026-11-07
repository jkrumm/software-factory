import type { IssueId } from '../../kernel/ids.ts'
import type { PortError, Result } from '../../kernel/result.ts'
import type { AccountReading } from './accounts.ts'
import type { Claim } from './claims.ts'
import type { MemoryReading } from './host.ts'
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

  claims(): Promise<Claim[]>
  takeClaim(claim: Claim): Promise<void>
  /** gives these Issues' claims back; says which Issues held one */
  releaseClaims(issues: readonly IssueId[]): Promise<IssueId[]>
  assign(assignment: Assignment): Promise<void>
  /** the newest assignments: the leads an account's latest sample may not show yet */
  recentAssignments(): Promise<Assignment[]>
  assignmentOf(issue: IssueId, attempt: number): Promise<Assignment | null>
  latestAssignment(issue: IssueId): Promise<Assignment | null>

  queueStates(): Promise<QueueStates>
  setQueueState(project: string | null, state: QueueState, at: Date): Promise<void>

  slots(): Promise<SlotRow[]>
  saveSlots(rows: readonly SlotRow[]): Promise<void>
}

/** The machine the server runs on. Every reading may fail; admission then goes on without it. */
export interface HostReader {
  memory(): Promise<Result<MemoryReading>>
  /** the 1-minute load average */
  load(): Promise<Result<number>>
}

/** The accounts and their windows, as the running core reads them (`claude-account usage --json`). */
export interface AccountSource {
  /** one poll; `at` is the poll's time, which a reading's `readAt` and `sampledAt` count from */
  read(at: Date): Promise<Result<AccountReading[]>>
}

export type { PortError }
