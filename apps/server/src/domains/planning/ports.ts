import type { IssueId } from '../../kernel/ids.ts'
import type { Result } from '../../kernel/result.ts'
import type { Edge } from './chain.ts'
import type { OpenIssue } from './queue.ts'
import type { OwnerWaitKind, ReplanTrigger } from './replan.ts'
import type { RepoRead, StoredProject } from './sync.ts'
import type { CallLoop, CallOutcome, CallRow } from './calls.ts'
import type { QueueApplied, QueueIssue } from './queue-edges.ts'
import type { SpecPrecedent, TriageCandidate } from '@software-factory/contract'
import type { HeldEdge } from './edge-need.ts'
import type { EdgeNeed } from '../../kernel/edge-need.ts'

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
  /** whether a stored repo is still a repo on disk: a directory with its own git directory, so a deleted checkout or a linked worktree is not */
  present(path: string): Promise<boolean>
  /** reads both files from the default branch; `fetch` asks the remote first */
  read(repo: RepoRef, options: { fetch: boolean }): Promise<Result<RepoRead>>
}

export interface PlanningStore {
  projects(): Promise<StoredProject[]>
  saveProject(project: StoredProject): Promise<void>
  /** drops a project's row; the plan rows it filed stay recorded, so the repo coming back files none twice */
  removeProject(name: string): Promise<void>

  edges(): Promise<Edge[]>
  /** false when the edge exists already */
  addEdge(edge: {
    issue: IssueId
    after: IssueId
    key: string
    at: Date
    inferredBy?: string | undefined
  }): Promise<boolean>
  /**
   * Keeps what an open edge the factory added carries (who inferred it, when it was added) with the reason it is taken
   * back, before `removeEdge` drops it; false when the edge is not an open stored edge somebody inferred.
   */
  logEdgeRemoval(removal: {
    issue: IssueId
    after: IssueId
    kind: 'disjoint' | 'owner_wait'
    reason: string
    at: Date
  }): Promise<boolean>
  /** false when no open (unsatisfied) edge was stored */
  removeEdge(edge: { issue: IssueId; after: IssueId }): Promise<boolean>
  markSatisfied(edges: readonly { issue: IssueId; after: IssueId }[], at: Date): Promise<void>
  /**
   * What one admission look found of the Issues their edges hold: for each unsatisfied edge of a `ready` Issue (it would
   * have been admitted without its edges) `ready_since` is set to `at` unless it is set already, and for each of a `held`
   * Issue (something else would have refused it too) it is cleared. A satisfied edge is never touched: its value is final.
   */
  noteReadiness(at: Date, look: { ready: readonly IssueId[]; held: readonly IssueId[] }): Promise<void>

  /** the owner's latest `prio` of each Issue that has one */
  prios(): Promise<Map<IssueId, number>>
  /** the place of each Issue in the newest order the queue model answered for its repo (0 first); an Issue it did not place is absent */
  queueOrder(): Promise<Map<IssueId, number>>
  /** false when the key is stored already */
  recordPrio(prio: { key: string; issue: IssueId; value: number; actor: string; at: Date }): Promise<boolean>

  /** `project:row key` → the Issue it was filed as */
  filedRows(): Promise<Map<string, IssueId>>
  recordFiledRow(row: { project: string; key: string; issue: IssueId; at: Date }): Promise<void>

  /** the project's Replan whose Issue is not closed, if any */
  openReplan(project: string): Promise<IssueId | null>
  recordReplan(replan: {
    issue: IssueId
    project: string
    trigger: ReplanTrigger
    ask: string | null
    at: Date
    /** a stalled Replan: the head it was filed for and what waited behind it then */
    head?: { issue: string; issues: readonly string[]; rows: readonly string[] } | undefined
  }): Promise<void>
  /** the project an Issue is the Replan of, or null when it is not a Replan */
  replanOf(issue: IssueId): Promise<{ project: string } | null>
  /** whether the Issue's latest Spec has a `looks_good` or `with_notes` verdict on its latest revision */
  specApproved(issue: IssueId): Promise<boolean>
}

/** An open Issue before its repo is resolved to a project. */
export type OpenIssueRow = Omit<OpenIssue, 'project'> & {
  repo: string
  /** the resource it was filed in; null: none */
  lane: string | null
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

/** An Issue that waits for a time, as its events made it: a lead's deferral, or the owner's pause that gave a time. */
export interface TimerWait {
  issue: IssueId
  /** the version that began the wait: a wake must name it */
  since: number
  /** the time it waits until, ISO */
  until: string
}

/** A timed wait with open Issues held behind it (a chain head), as the long-wait read lists it. */
export interface LongWaitRow {
  issue: string
  repo: string
  title: string
  since: Date
  until: string
  held: number
  /** the Issues counted in `held`, each with the open Issues it waits on directly */
  heldIssues: { issue: string; after: string[] }[]
}

/**
 * A chain head that waits on the owner (a Decision, a Spec under his review, an Errand) with work behind it, as the
 * owner-wait read lists it: its oldest owner wait, and the open Issues and plan rows behind it with what each waits on.
 */
export interface OwnerWaitRow {
  issue: string
  repo: string
  title: string
  since: Date
  owner: { kind: OwnerWaitKind; id: string; title: string }
  heldIssues: { issue: string; after: string[] }[]
  /** `project:key` of a plan row not yet filed */
  heldRows: { row: string; after: string[] }[]
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
  /** of these Issues, how each closed: `done`, `healed`, `dropped` or `cancelled` (an Issue that is not closed is absent) */
  outcomesOf(ids: readonly IssueId[]): Promise<Map<IssueId, string>>
  /** of these Issues, when each closed (an Issue that is not closed is absent) */
  closedAtOf(ids: readonly IssueId[]): Promise<Map<IssueId, Date>>
  /** of these Issues, the repo text each was filed for and whether it is open (an unknown Issue is absent) */
  repoStatesOf(ids: readonly IssueId[]): Promise<Map<IssueId, { repo: string; state: 'open' | 'closed' }>>
  /** the Issues waiting on a dependency */
  dependencyWaits(): Promise<DependencyWait[]>
  /** the Issues waiting for a time */
  timerWaits(): Promise<TimerWait[]>
  /** the timed waits of at least `thresholdMs` that other open Issues wait behind */
  longWaits(thresholdMs: number): Promise<LongWaitRow[]>
  /** the Issues that have waited on the owner for at least `thresholdMs` with open Issues or plan rows behind them */
  ownerWaits(thresholdMs: number, now: Date): Promise<OwnerWaitRow[]>
}

/** An Issue that is still `settling`, with what triage needs to know of it. */
export interface SettlingRow {
  issue: IssueId
  repo: string
  title: string
  kind: 'feature' | 'bug' | 'chore' | 'docs' | 'incident'
  origin: string
  filedAt: Date
  fromAlert: boolean
  /** the filer stated its edges: triage adds none */
  statedEdges: boolean
  text: string
  /** the owner's `prio` of it, 0 when he ranked none */
  prio: number
}

/** A working or watching Issue that holds its repo's claim and waits (an open `after` edge) on Issues queued for want of one. */
export interface ClaimHolder {
  issue: IssueId
  state: 'working' | 'watching'
  /** the queued Issues of its own repo it is after */
  blockers: IssueId[]
}

/** A lead whose note is refused again and again because it waits for a claim in its repo. */
export interface ClaimRefusal {
  issue: IssueId
  repo: string
  /** the first refusal of the claim in the run of refusals the open note has met */
  since: Date
  /** how many times the note was refused for the claim */
  refusals: number
}

/** The agw calls the steward, triage and queue loops made, inside one transaction, so none is made twice, and what the queue loop did with an answer. */
export interface CallStore {
  /** the rounds of one subject of a scope (an Issue, or a repo for the queue loop), oldest first; every subject's rounds when `subject` is left out */
  calls(loop: CallLoop, scope: string, subject?: string): Promise<CallRow[]>
  /** false when the round is claimed already (another pass came first) */
  claimCall(
    row: Pick<CallRow, 'key' | 'loop' | 'scope' | 'subject' | 'round' | 'claimedAt' | 'leaseUntil'>,
  ): Promise<boolean>
  /** takes a call whose lease lapsed back for this pass; false when another pass did first */
  retakeCall(key: string, claimedAt: Date, leaseUntil: Date): Promise<boolean>
  /** at boot: no call of an earlier process is still running, so every open call's lease lapses now */
  lapseOpen(now: Date): Promise<number>
  finishCall(
    key: string,
    result: { outcome: CallOutcome; answer: unknown; detail: string | null; at: Date },
  ): Promise<void>
  /** what was done with a queue call's answer: the edges applied and refused, and the queue's shape after them */
  recordQueueApplied(key: string, result: QueueApplied): Promise<void>
}

/** Read-only SQL on other domains' tables for the steward, triage and queue loops (`docs/architecture.md`: cross-domain SQL lives in `read/`). */
export interface PlanningLoopReads {
  /** open `note_lead` effects whose runs were refused for a claim (`waits for a claim in`), oldest first */
  claimRefusals(limit: number): Promise<ClaimRefusal[]>
  /** Issues waiting for a stall (`wall`, `unreported`, `blocked`, `lead_gone`, `regressed`), oldest first */
  stalled(limit: number): Promise<IssueId[]>
  /** Issues in `working`, oldest first: the steward reads each lead's session for one gone quiet */
  working(limit: number): Promise<IssueId[]>
  /** Issues still settling, oldest first */
  settling(limit: number): Promise<SettlingRow[]>
  /** the ids of the repo's Issues that are not closed, oldest first */
  openIssueIds(repo: string): Promise<IssueId[]>
  /** the Issues of the repo that are not closed, other than `excluding` */
  openIssues(repo: string, excluding: IssueId, limit: number): Promise<TriageCandidate[]>
  /** every open Issue that is not settling, with its priority and open blockers, for the queue loop */
  queueIssues(): Promise<QueueIssue[]>
  /** the edges the factory added that still hold a queued Issue behind an open blocker (never a stated edge), for the sweep */
  heldEdges(): Promise<HeldEdge[]>
  /** the edges the queue loop took back: pairs it must not add again */
  removedEdges(): Promise<{ issue: IssueId; after: IssueId }[]>
  /** whether the edges the factory added were needed, per source, over the edges added in the window */
  edgeNeed(window: { from: Date; to: Date }): Promise<EdgeNeed[]>
  /** working or watching Issues with an open edge to one of `queued` (still queued, same repo): the claim deadlock */
  claimHolders(queued: readonly IssueId[], limit: number): Promise<ClaimHolder[]>
  /** the owner's newest needed-me marks on Specs, newest first: triage's precedents for the `spec` flag */
  specPrecedents(limit: number): Promise<SpecPrecedent[]>
}
