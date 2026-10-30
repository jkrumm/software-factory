import { DateTime, Option, Schema } from "effect"

export const EventKind = Schema.Literals([
  "session_started",
  "turn_started",
  "turn_ended",
  "limit_stop",
  "session_ended"
])
export type EventKind = typeof EventKind.Type

export const SessionState = Schema.Literals(["starting", "working", "idle", "walled", "dead"])
export type SessionState = typeof SessionState.Type

export const NewEvent = Schema.Struct({
  key: Schema.NonEmptyString,
  session: Schema.NonEmptyString,
  kind: EventKind,
  at: Schema.DateTimeUtcFromString,
  payload: Schema.optionalKey(Schema.Unknown)
})
export type NewEvent = typeof NewEvent.Type

export const NewSpawn = Schema.Struct({
  key: Schema.NonEmptyString,
  repo: Schema.NonEmptyString,
  prompt: Schema.NonEmptyString
})
export type NewSpawn = typeof NewSpawn.Type

const Usage = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

export const NewReading = Schema.Struct({
  weeklyUsed: Usage,
  fiveHourUsed: Usage,
  resetsAt: Schema.DateTimeUtcFromString
})
export type NewReading = typeof NewReading.Type

export const SpawnStatus = Schema.Literals(["waiting", "pending", "started", "failed"])
export type SpawnStatus = typeof SpawnStatus.Type

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()("SessionNotFound", {
  id: Schema.String
}) {}

export class SpawnNotFound extends Schema.TaggedError<SpawnNotFound>()("SpawnNotFound", {
  key: Schema.String
}) {}

/**
 * State is derived from the events ordered by `at`, then by insertion (a spool replay delivers late).
 * Precedence: dead, walled, working, idle, starting.
 */
export const deriveState = (ordered: ReadonlyArray<EventKind>): SessionState => {
  if (ordered.includes("session_ended")) return "dead"
  const limit = ordered.lastIndexOf("limit_stop")
  const started = ordered.lastIndexOf("turn_started")
  const ended = ordered.lastIndexOf("turn_ended")
  if (limit > started) return "walled"
  if (started > ended) return "working"
  if (started >= 0) return "idle"
  return ordered.at(-1) === "session_started" ? "starting" : "idle"
}

export interface Reading {
  readonly account: string
  readonly weeklyUsed: number
  readonly fiveHourUsed: number
  readonly resetsAt: DateTime.Utc
}

export const hasCapacity = (reading: Reading): boolean => reading.weeklyUsed < 95 && reading.fiveHourUsed < 85

const byLeastUsed = (a: Reading, b: Reading): number =>
  a.weeklyUsed - b.weeklyUsed || a.fiveHourUsed - b.fiveHourUsed || a.account.localeCompare(b.account)

const byEarliestReset = (a: Reading, b: Reading): number =>
  DateTime.toEpochMillis(a.resetsAt) - DateTime.toEpochMillis(b.resetsAt) || a.account.localeCompare(b.account)

/** The account with capacity and the least weekly use, from the latest reading per account. */
export const pickAccount = (latest: ReadonlyArray<Reading>): Option.Option<Reading> =>
  Option.fromNullishOr(latest.filter(hasCapacity).toSorted(byLeastUsed)[0])

/** The reading whose window resets first: when a spawn without capacity may start. */
export const earliestReset = (latest: ReadonlyArray<Reading>): Option.Option<Reading> =>
  Option.fromNullishOr(latest.toSorted(byEarliestReset)[0])
