import type { EventEnvelope } from '../../kernel/events.ts'
import type { IssueId } from '../../kernel/ids.ts'
import type { Key } from '../../kernel/keys.ts'
import type { PortError, Result } from '../../kernel/result.ts'
import type { Effect, EffectKind, EffectOf } from './effects.ts'
import type { EventKind } from './events.ts'
import type { Issue, State } from './issue.ts'
import type { AppliedRecord, Transition } from './machine.ts'

/** An event as `issue_events` holds it: applied, refused or ignored, every one a fact. */
export interface StoredEvent extends EventEnvelope<EventKind> {
  result: 'applied' | 'refused' | 'ignored'
  /** why it was refused or ignored */
  detail: string | null
  /** the state it found; null for `filed` */
  from: State | null
  /** what it did, when applied */
  transition: Transition | null
}

/** An effect a runner holds: run it, then record how it ended. */
export type ClaimedEffect = Effect & { issueId: IssueId; failures: number }

export type EffectRun = { at: Date; ok: true } | { at: Date; ok: false; error: PortError; retryAt: Date }

/**
 * The work domain's tables, inside one transaction. A database failure throws and aborts the transaction; the unit of
 * work turns it into a `PortError`.
 */
export interface WorkStore {
  /** the next Issue's id, `issue_<n>`, from the Issue number sequence */
  nextIssueId(): Promise<IssueId>
  eventByKey(key: Key): Promise<StoredEvent | null>
  /** the Issue's applied events in version order; null when there is no such Issue */
  history(id: IssueId): Promise<AppliedRecord[] | null>
  insertIssue(issue: Issue): Promise<void>
  /** writes the Issue's state and version where the row is still at `expected`; false when another write came first */
  updateIssue(issue: Issue, expected: number): Promise<boolean>
  /** false when the key is stored already: a copy of this event came first */
  appendEvent(event: StoredEvent): Promise<boolean>
  /** into the outbox, in order; an effect whose key is planned already is left as it is */
  planEffects(event: StoredEvent, effects: readonly Effect[]): Promise<void>
  /** cancels the Issue's open effects but those of the kinds kept */
  cancelOpenEffects(issueId: IssueId, keep: readonly EffectKind[], at: Date): Promise<void>
  /** each Issue's oldest open effect that is due and free, held until `until` */
  claimEffects(input: { now: Date; until: Date; limit: number }): Promise<ClaimedEffect[]>
  recordRun(key: Key, run: EffectRun): Promise<void>
  /** gives claimed effects back, unrun and uncounted: the next pass may take them at once instead of after the lease */
  releaseEffects(keys: readonly Key[]): Promise<void>
}

/**
 * The ports the effects run through, one per kind. A port finds its own work by the effect's key, so a call repeated
 * after a crash does nothing twice. Packages 2 to 7 bring the real ones; until then the outbox runs against fakes.
 */
export type EffectPorts = {
  [K in EffectKind]: (effect: EffectOf<K> & { issueId: IssueId }) => Promise<Result<void>>
}
