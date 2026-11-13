import type { IssueId } from '../../kernel/ids.ts'
import type { Key } from '../../kernel/keys.ts'
import type { AcceptanceEvidence, CheckRecord, CiEvidence, CommitsEvidence, ReviewEvidence } from './evidence.ts'
import type { Outcome, Ran } from './watch.ts'

/** A ship the gate looked at. */
export interface ShipRecord {
  id: string
  issueId: IssueId
  attempt: number
  /** the key of the `shipped` event the call stands for */
  eventKey: Key
  at: Date
  result: 'accepted' | 'refused'
  /** the verb's error when refused */
  detail: string | null
  reported: readonly string[]
}

export type StoredEvidence =
  | { id: string; kind: 'commits'; payload: CommitsEvidence }
  | { id: string; kind: 'review'; payload: ReviewEvidence }
  | { id: string; kind: 'acceptance'; payload: AcceptanceEvidence }
  | { id: string; kind: 'ci'; payload: CiEvidence }

export type WatchAnswer = 'passed' | 'regressed' | 'ended'

export interface WatchRecord {
  key: Key
  issueId: IssueId
  attempt: number
  watch: number
  startedAt: Date
  windowMs: number
  answer: WatchAnswer | null
}

/** A watch a check holds, with the runs it has had. */
export interface OpenWatch extends WatchRecord {
  ran: Ran[]
}

export interface UndisposedAnnotation {
  id: string
  artifact: string
  revision: number
  quote: string
}

export interface QualityView {
  ships: (Omit<ShipRecord, 'issueId'> & { evidence: StoredEvidence[] })[]
  watches: (WatchRecord & { checks: { n: number; at: Date; outcome: Outcome; checks: CheckRecord[] }[] })[]
}

/** The quality domain's tables, inside one transaction. A database failure throws; the unit of work turns it into a `PortError`. */
export interface QualityStore {
  /** whether this call's ship was accepted already: a repeat gets the first answer without asking git */
  shipAccepted(eventKey: Key): Promise<boolean>
  /** whether a Spec was submitted for the Issue (any attempt): what a flagged Issue's ship is held to */
  specSubmitted(issueId: IssueId): Promise<boolean>
  /** the owner's annotations on the Issue's Specs and Concepts that its lead has not answered with a disposition, oldest first */
  undisposedAnnotations(issueId: IssueId): Promise<UndisposedAnnotation[]>
  /** a ship, and for an accepted one its evidence, keyed by the ship; a copy that came first is left as it is */
  recordShip(ship: ShipRecord, evidence: readonly StoredEvidence[]): Promise<void>
  /** the newest accepted ship of the attempt: what its watch checks the deployed version against */
  lastShip(issueId: IssueId, attempt: number): Promise<{ at: Date; commits: CommitsEvidence | null } | null>
  /**
   * The checks of the newest finished run (green or red, never blocked) of any other Issue's watch in the repo before
   * `before`: what verify said of the repo before this ship. Null when there was none.
   */
  baselineChecks(input: { repo: string; before: Date; exceptIssue: IssueId }): Promise<CheckRecord[] | null>
  /** opens a watch; false when it was opened already (the same effect run again) */
  openWatch(watch: WatchRecord): Promise<boolean>
  /** open watches no check holds at `now`; the caller works out which are due */
  openWatches(now: Date): Promise<OpenWatch[]>
  /** holds the watch until `until`; false when another check holds it */
  claimWatch(key: Key, now: Date, until: Date): Promise<boolean>
  releaseWatch(key: Key): Promise<void>
  /** a run of verify, as it ended */
  recordCheck(input: {
    watch: Key
    issueId: IssueId
    attempt: number
    at: Date
    outcome: Outcome
    checks: CheckRecord[]
  }): Promise<void>
  answerWatch(key: Key, answer: WatchAnswer, at: Date): Promise<void>
  view(issueId: IssueId): Promise<QualityView>
}
