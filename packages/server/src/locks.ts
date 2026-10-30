/**
 * Every advisory lock key of this schema, in one place: the keys share one namespace per database, so two features
 * that pick the same number block each other (the one-process lock once starved the tick that way).
 */
export const LOCKS = {
  /** transaction-level: serializes migrations */
  migration: 7_093_001,
  /** transaction-level: serializes everything that assigns an account */
  capacity: 7_093_002,
  /** session-level: held by the one running server */
  singleton: 7_093_003,
} as const
