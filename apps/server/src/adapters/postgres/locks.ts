/**
 * Every advisory lock key of the factory, in one place: the keys share one namespace per database, so two features that
 * pick the same number block each other (the old core's one-process lock once starved its tick that way). The values are
 * the old core's: a new core and an old one on the same database exclude each other instead of both running.
 */
export const LOCKS = {
  /** transaction-level: serializes migrations */
  migration: 7_093_001,
  /** transaction-level: serializes everything that assigns a claim or an account (capacity) */
  capacity: 7_093_002,
  /** session-level: held by the one running server */
  process: 7_093_003,
} as const
