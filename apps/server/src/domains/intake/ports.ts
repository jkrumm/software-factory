import type { Signal } from '@software-factory/contract'
import type { IssueId } from '../../kernel/ids.ts'
import type { PortError, Result } from '../../kernel/result.ts'
import type { HealRule, OpenIssue, Received, RepoSignals, Triaged } from './model.ts'
import type { Topology } from './rules.ts'

export type SignalState = 'held' | 'filed' | 'amended' | 'incident' | 'promoted'

/** A stored signal: the envelope and its alert detail, and what became of it. */
export interface SignalRow {
  id: string
  /** deterministic for a source's own events; absent for a person's, whose replay is the fingerprint match */
  key: string | null
  received: Received
  receivedAt: Date
  state: SignalState
  issueId: IssueId | null
}

/** One filed Issue seen from the source's side: an episode of a subject, or a stateless match by fingerprint. */
export interface SubjectRow {
  id: number
  source: string
  subject: string
  fingerprint: string | null
  issueId: IssueId
  /** the host or dependency the alert sat on, when it did */
  groupKey: string | null
  filedAt: Date
  lastSeen: Date
  repeats: number
  /** the last `up` of this subject; null while it is down */
  upAt: Date | null
  /** a GitHub issue to answer when its Issue closes */
  writeback: boolean
  /** `label` or `author`, for GitHub */
  admitted: string | null
}

export interface IncidentRow {
  issueId: IssueId
  groupKey: string
  openedAt: Date
  lastAlertAt: Date
}

/** A `down` waiting out its grace before it files, with the runbook's results so far. */
export interface PendingRow {
  source: string
  subject: string
  repo: string
  received: Received
  rule: HealRule
  openedAt: Date
  dueAt: Date
  attempts: number
  results: unknown[]
}

export interface DoorRouteRow {
  source: string
  monitor: string
  repo: string
  quiet: number
  lastQuietAt: Date | null
  lastEvent: string | null
}

export interface UnroutedRow {
  source: string
  monitor: string
  count: number
  lastSeen: Date
  lastTitle: string
  lastEvent: string
  status: 'down' | 'up' | null
  downSince: Date | null
  group: boolean
  filedAt: Date | null
  filedIssue: IssueId | null
}

export interface DoorSourceRow {
  source: string
  firstSeen: Date
  lastAccepted: Date | null
  refused: number
  refusedSince: Date | null
  lastRefused: Date | null
}

export interface WritebackRow {
  issueId: IssueId
  source: string
  subject: string
  admitted: string | null
}

/**
 * Intake's tables, inside one transaction (`docs/architecture.md`: each domain owns its tables). A database failure
 * throws and aborts the transaction; the unit of work turns it into a `PortError`.
 */
export interface IntakeStore {
  /** serializes work on one name for the rest of the transaction */
  lock(name: string): Promise<void>
  seen(key: string): Promise<boolean>
  remember(keys: readonly string[], now: Date): Promise<void>

  /** false when the key is stored already */
  insertSignal(row: SignalRow): Promise<boolean>
  signal(id: string): Promise<SignalRow | null>
  signalByKey(key: string): Promise<SignalRow | null>
  setSignal(id: string, patch: { state: SignalState; issueId: IssueId | null; repo?: string | null }): Promise<void>
  signals(state: SignalState | null, limit: number): Promise<SignalRow[]>

  latestSubject(source: string, subject: string): Promise<SubjectRow | null>
  /** the newest subject of the source with this fingerprint */
  latestByFingerprint(source: string, fingerprint: string): Promise<SubjectRow | null>
  subjectsOfIssue(issueId: IssueId): Promise<SubjectRow[]>
  /** the newest row of every subject of the source whose name starts with `prefix` */
  latestSubjects(source: string, prefix: string): Promise<SubjectRow[]>
  insertSubject(row: Omit<SubjectRow, 'id'>): Promise<void>
  touchSubject(id: number, patch: { at: Date; upAt: Date | null; repeat?: boolean }): Promise<void>

  latestIncident(groupKey: string): Promise<IncidentRow | null>
  insertIncident(row: IncidentRow): Promise<void>
  touchIncident(issueId: IssueId, at: Date): Promise<void>

  pendingOf(source: string, subject: string): Promise<PendingRow | null>
  pendingSubjects(source: string, prefix: string): Promise<{ subject: string; openedAt: Date }[]>
  insertPending(row: PendingRow): Promise<void>
  deletePending(source: string, subject: string): Promise<PendingRow | null>
  /** the subjects whose grace is due, oldest first */
  duePending(now: Date, limit: number): Promise<{ source: string; subject: string }[]>
  /** the row, locked for this transaction and skipped when another holds it, only if it is due */
  claimPending(source: string, subject: string, now: Date): Promise<PendingRow | null>
  leasePending(source: string, subject: string, patch: { attempts: number; dueAt: Date }): Promise<void>
  recordPendingRun(source: string, subject: string, entry: unknown, dueAt: Date): Promise<void>

  routeFor(source: string, monitor: string): Promise<DoorRouteRow | null>
  routes(): Promise<DoorRouteRow[]>
  setRoute(source: string, monitor: string, repo: string): Promise<DoorRouteRow>
  removeRoute(source: string, monitor: string): Promise<DoorRouteRow | null>
  countQuiet(source: string, monitor: string, event: string, now: Date): Promise<boolean>

  noteUnrouted(row: {
    source: string
    monitor: string
    title: string
    event: string
    status: 'down' | 'up'
    group: boolean
    now: Date
  }): Promise<void>
  unrouted(limit: number): Promise<UnroutedRow[]>
  dueUnrouted(now: Date, graceMs: number, limit: number): Promise<UnroutedRow[]>
  markUnroutedFiled(source: string, monitor: string, event: string, issueId: IssueId, now: Date): Promise<void>

  doorSources(): Promise<DoorSourceRow[]>
  doorStarted(sources: readonly string[], now: Date): Promise<void>
  doorRefused(source: string, now: Date): Promise<void>
  doorAccepted(source: string, now: Date): Promise<void>

  /** GitHub subjects whose Issue the source has not answered yet */
  unwrittenBack(limit: number): Promise<WritebackRow[]>
  recordWriteback(issueId: IssueId, result: string, now: Date): Promise<void>
}

/** Which repos are projects and what each hears; each `project.yaml`, read by the package that owns projects. */
export interface ProjectSignals {
  find(repo: string): Promise<Result<RepoSignals | null>>
  /** every project with automatic sources to poll, not paused */
  polled(): Promise<Result<RepoSignals[]>>
}

/** Which host each repo's alerts sit on: the projects' `signals:` and `config/infra.json`'s hosts. */
export interface IntakeTopology {
  load(): Promise<Result<Topology>>
}

/** The Issues of a repo that are not closed, to match a person's signal against. Reads another domain's tables. */
export interface OpenIssues {
  inRepo(repo: string): Promise<Result<OpenIssue[]>>
}

/** What the triage workflow decides when the deterministic match is unsure: amend one of the candidates, or file anew. */
export interface TriageWorkflow {
  amendOrNew(input: { signal: Signal; candidates: readonly OpenIssue[] }): Promise<Result<{ amend: IssueId | null }>>
}

export type RunbookRun = { ran: false; reason: string } | { ran: true; exit: number; tail: string }

/** A heal rule's runbook, run outside any transaction: `make restart` in the project's repo. */
export interface Runbook {
  run(input: { repo: string; runbook: 'make restart' }): Promise<Result<RunbookRun>>
}

/** What a poller needs from the server: hand over a signal, ask which of its subjects are open. */
export interface IntakeSink {
  receive(received: Received): Promise<Result<Triaged, PortError>>
  /**
   * Every subject of `source` whose name starts with `prefix` that intake has filed or holds pending: whether its Issue
   * is still open (a `down` waiting to settle is open) and when its Issue was filed.
   */
  subjects(source: string, prefix: string): Promise<Result<SubjectState[], PortError>>
  /** GitHub Issues that closed and were not answered yet */
  pendingWritebacks(limit: number): Promise<Result<Writeback[], PortError>>
  wroteBack(issueId: IssueId, result: string): Promise<Result<void, PortError>>
}

export interface SubjectState {
  subject: string
  open: boolean
  /** when the newest Issue of the subject was filed; the pending `down`'s opening when nothing was filed yet */
  since: Date
}

export interface Writeback {
  issueId: IssueId
  /** `<owner>/<repo>#<n>` */
  subject: string
  outcome: string
  admitted: string | null
  /** the first line of the close reason, if the lead gave one */
  summary: string | null
}
