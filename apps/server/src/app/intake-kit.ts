import { NOT_SCREENED } from '../domains/intake/screen.ts'
import { type Received, type Triaged } from '../domains/intake/model.ts'
import {
  type Dismissal,
  type IntakeStore,
  type IntakeTopology,
  type OpenIssues,
  type ProjectSignals,
  type Runbook,
  type SignalRow,
  type SignalState,
  type TriageWorkflow,
} from '../domains/intake/ports.ts'
import { noteOf } from '../domains/intake/rules.ts'
import { type WorkStore } from '../domains/work/ports.ts'
import { type Issue } from '../domains/work/issue.ts'
import { replay } from '../domains/work/machine.ts'
import { type IssueId } from '../kernel/ids.ts'
import { type Key, key as keyOf } from '../kernel/keys.ts'
import { err, type PortError, type Result } from '../kernel/result.ts'
import { type IssueWriteError, recordIn, type WriteDeps } from './issues.ts'
import { type UnitOfWork } from './unit-of-work.ts'

export type Stores = { work: WorkStore; intake: IntakeStore }
export type IntakeWrites = UnitOfWork<Stores>

/** What a use case of intake refuses besides a failed write. */
export type IntakeRefusal = {
  kind: 'not_found' | 'not_held' | 'invalid' | 'no_repo' | 'unknown_project' | 'trust_refused'
  detail: string
}

/** Who is calling, as the token says (`api/policy.ts`); only the owner, the orchestrator, an agent and the signal token may put a signal in. */
export type RequestCaller = 'owner' | 'orchestrator' | 'agent' | 'machine' | 'signal' | 'read'

export type IntakeError = IssueWriteError | PortError | IntakeRefusal

export interface IntakeSettings {
  /** alerts on one host join an incident while its last alert is younger than this */
  incidentWindowMs: number
  /** a stateless signal's fingerprint still matches an Issue closed this recently */
  fingerprintWindowMs: number
  /** a monitor with no route that stays down this long is filed once */
  unroutedGraceMs: number
  /** where an unrouted monitor's Issue is filed when no repo can be told from its name */
  homeRepo: string | null
  /** a monitor that stays down this long with no route and no place is held for the owner */
  unroutedHeldMs: number
  /**
   * How long a request waits for the triage workflow before it files anew. A hang guard on the request, not a budget on the
   * run: the run goes on, and the same signal sent again rejoins it by its key. Below the client's 10 s transport timeout.
   */
  triageWaitMs: number
}

export const DEFAULT_INTAKE_SETTINGS: IntakeSettings = {
  incidentWindowMs: 30 * 60_000,
  fingerprintWindowMs: 24 * 60 * 60_000,
  unroutedGraceMs: 10 * 60_000,
  homeRepo: null,
  unroutedHeldMs: 6 * 3_600_000,
  triageWaitMs: 8_000,
}

export interface IntakeDeps extends WriteDeps {
  uow: IntakeWrites
  projects: ProjectSignals
  topology: IntakeTopology
  openIssues: OpenIssues
  triage: TriageWorkflow
  runbook: Runbook
  settings: IntakeSettings
}

export type Out<T> = Promise<Result<T, IntakeError>>

export const MAX_DISMISS_REASON = 500

/** What the triage workflow decided: amend an open Issue, call it already covered, or neither (file anew). */
export type Decision = { amend: IssueId | null; settled?: IssueId | null; reason?: string }

export const refuse = (kind: IntakeRefusal['kind'], detail: string): Result<never, IntakeRefusal> =>
  err({ kind, detail })

export const triaged = (
  outcome: Triaged['outcome'],
  detail: Triaged['detail'],
  issue: IssueId | null = null,
  signal: string | null = null,
  reason: string | null = null,
): Triaged => ({ outcome, detail, issue, signal, reason })

export const dropped = (detail: Triaged['detail'], reason: string): Triaged =>
  triaged('dropped', detail, null, null, reason)

/** What a replayed event answers: what it answered the first time. */
export function replayedOf(row: SignalRow): Triaged {
  const outcome = row.state === 'promoted' ? 'filed' : row.state === 'dismissed' ? 'dropped' : row.state
  return triaged(outcome, 'replayed', row.issueId, row.id)
}

export const eventKeyOf = (received: Received): Key | null =>
  received.alert ? keyOf('signal', received.signal.source, received.alert.subject, received.alert.event) : null

/** The question a lead is asked is the signal's words; an owner's are the owner's, everyone else's are data. */
export const noteText = (received: Received, lead?: string): string =>
  received.signal.trust === 'owner'
    ? [lead ?? received.signal.title, received.signal.text].filter(Boolean).join('\n')
    : noteOf(received, lead)

export const actorOf = (received: Received): 'owner' | 'factory' =>
  received.signal.trust === 'owner' ? 'owner' : 'factory'

export async function loadIssue(work: WorkStore, id: IssueId): Promise<Issue | null> {
  const history = await work.history(id)
  return history ? replay(id, history) : null
}

export const isOpen = (issue: Issue | null): issue is Issue => issue !== null && issue.state !== 'closed'

/**
 * The Issue a new alert of this host joins: the newest incident, inside the window, its Issue open and one of its alerts
 * still down. When every alert has reported up the incident is over, though its Issue may still ship or be watched: a later
 * alert is its own firing, and the triage workflow may still amend an open Issue with it (a slow-routes alert of one repo
 * joined a shipped version bump of another, 2026-11-26).
 */
export async function joinableIncident(
  s: Pick<Stores, 'intake' | 'work'>,
  groupKey: string,
  now: Date,
  windowMs: number,
): Promise<Issue | null> {
  const incident = await s.intake.latestIncident(groupKey)
  if (!incident || now.getTime() - incident.lastAlertAt.getTime() > windowMs) return null
  const alerts = (await s.intake.subjectsOfIssue(incident.issueId)).filter((row) => row.groupKey === groupKey)
  if (alerts.length > 0 && alerts.every((row) => row.upAt !== null)) return null
  const issue = await loadIssue(s.work, incident.issueId)
  return isOpen(issue) ? issue : null
}

/** Writing a signal's record and its note on an Issue: what every road of intake ends in. */
export function createLedger(deps: IntakeDeps) {
  const { clock, ids } = deps

  const note = (s: Stores, issueId: IssueId, evKey: Key, received: Received, lead?: string) =>
    recordIn(s.work, deps, {
      issueId,
      key: evKey,
      event: { kind: 'noted', payload: { text: noteText(received, lead) }, actor: actorOf(received) },
    })

  async function store(
    s: Stores,
    received: Received,
    key: Key | null,
    state: SignalState,
    issueId: IssueId | null,
    dismissal: Dismissal | null = null,
  ): Promise<string> {
    const id = ids.next('signal')
    await s.intake.insertSignal({
      id,
      key,
      received,
      receivedAt: clock.now(),
      state,
      issueId,
      dismissal,
      screening: NOT_SCREENED,
    })
    return id
  }

  return { note, store }
}

export type Ledger = ReturnType<typeof createLedger>
