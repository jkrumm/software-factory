import type { EventId, IssueId } from './ids.ts'
import type { Key } from './keys.ts'

/** Who caused an event: the owner, the owner's delegate agent (the orchestrator), a lead, the factory's own code, or one of its loops that act on judgment. */
export const ACTORS = ['owner', 'orchestrator', 'lead', 'factory', 'steward', 'judge'] as const
export type Actor = (typeof ACTORS)[number]

/** The two principals that hold the owner's rights over an Issue: the owner himself and his delegate agent. */
export type OwnerActor = Extract<Actor, 'owner' | 'orchestrator'>

/**
 * One fact about an Issue, as it is stored. Facts are stored, state is derived: the Issue is what its events made it.
 * Every domain records its facts on an Issue in this shape.
 */
export interface EventEnvelope<K extends string = string, P = unknown> {
  id: EventId
  issueId: IssueId
  /** deterministic: the same event sent twice has the same key, and the second is a no-op */
  key: Key
  kind: K
  payload: P
  actor: Actor
  at: Date
  /** the Issue version this event produced; null for an event that was refused or ignored */
  version: number | null
  /** the event that led to this one, when another event did */
  causation: EventId | null
}
