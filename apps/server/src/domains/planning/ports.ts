import type { IssueId } from '../../kernel/ids.ts'
import type { Result } from '../../kernel/result.ts'
import type { Edge } from './chain.ts'
import type { OpenIssue } from './queue.ts'
import type { RepoRead, StoredProject } from './sync.ts'

/** A repo the factory may read as a project. */
export interface RepoRef {
  /** the directory's name */
  directory: string
  /** the absolute path, after `realpath` */
  path: string
}

/** The repos on the machine and what their default branches say. Every call may fail; a failure leaves the row as it was. */
export interface ProjectSource {
  /** the git repos directly under the repo roots that have a `project.yaml`, as last fetched */
  discover(): Promise<Result<RepoRef[]>>
  /** the repo a repo text names (a name or a path inside a root), if it is one */
  resolve(repo: string): Promise<Result<RepoRef | null>>
  /** reads both files from the default branch; `fetch` asks the remote first */
  read(repo: RepoRef, options: { fetch: boolean }): Promise<Result<RepoRead>>
}

export interface PlanningStore {
  projects(): Promise<StoredProject[]>
  saveProject(project: StoredProject): Promise<void>

  edges(): Promise<Edge[]>
  /** false when the edge exists already */
  addEdge(edge: { issue: IssueId; after: IssueId; key: string; at: Date }): Promise<boolean>
  /** false when no open (unsatisfied) edge was stored */
  removeEdge(edge: { issue: IssueId; after: IssueId }): Promise<boolean>
  markSatisfied(edges: readonly { issue: IssueId; after: IssueId }[], at: Date): Promise<void>

  /** the owner's latest `prio` of each Issue that has one */
  prios(): Promise<Map<IssueId, number>>
  /** false when the key is stored already */
  recordPrio(prio: { key: string; issue: IssueId; value: number; actor: string; at: Date }): Promise<boolean>

  /** `project:row key` → the Issue it was filed as */
  filedRows(): Promise<Map<string, IssueId>>
  recordFiledRow(row: { project: string; key: string; issue: IssueId; at: Date }): Promise<void>
}

/** An open Issue before its repo is resolved to a project. */
export type OpenIssueRow = Omit<OpenIssue, 'project'> & {
  repo: string
  /** when its newest applied event happened: for a lead working without a claim, the end of the wait that gave it up */
  since: Date | null
}

/** An Issue that waits on others, as its events made it. */
export interface DependencyWait {
  issue: IssueId
  /** the version that began the wait: a wake must name it */
  since: number
  after: IssueId[]
}

/** An Issue that waits for a time, as its events made it. */
export interface TimerWait {
  issue: IssueId
  /** the version that began the wait: a wake must name it */
  since: number
  /** the time the lead deferred to, ISO */
  until: string
}

/**
 * What planning reads of the Issues, which another domain owns: read-only, implemented under `read/` on the same
 * transaction.
 */
export interface IssueReads {
  /** every Issue that is not closed, with the repo text it was filed for */
  open(): Promise<OpenIssueRow[]>
  /** of these Issues, which exist and which are closed */
  statesOf(ids: readonly IssueId[]): Promise<Map<IssueId, 'open' | 'closed'>>
  /** the Issues waiting on a dependency */
  dependencyWaits(): Promise<DependencyWait[]>
  /** the Issues waiting for a time */
  timerWaits(): Promise<TimerWait[]>
}
