import type { CapacityStore } from '../domains/capacity/ports.ts'
import type { IssueReads, PlanningStore } from '../domains/planning/ports.ts'
import type { WorkStore } from '../domains/work/ports.ts'
import type { Clock } from '../kernel/clock.ts'
import type { IdSource, IssueId } from '../kernel/ids.ts'
import type { UnitOfWork } from './unit-of-work.ts'

/** The stores planning and capacity write through, composed in `main.ts` beside the others. */
export interface PlanningStores {
  work: WorkStore
  planning: PlanningStore
  capacity: CapacityStore
  /** read-only SQL on the work tables */
  reads: IssueReads
}

export type PlanningUow = UnitOfWork<PlanningStores>

export interface PlanningDeps {
  uow: PlanningUow
  clock: Clock
  ids: IdSource
}

/** Why a planning verb said no. Each names what it found. */
export type PlanningError =
  | { kind: 'unknown_issue'; issue: IssueId }
  | { kind: 'issue_closed'; issue: IssueId }
  | { kind: 'wrong_state'; issue: IssueId; detail: string }
  | { kind: 'cycle'; path: IssueId[] }
  | { kind: 'unknown_project'; project: string }
  | { kind: 'version_conflict'; issue: IssueId }
  | { kind: 'refused'; detail: string }
