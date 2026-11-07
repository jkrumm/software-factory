import type { ZodType } from 'zod'
import type { Key } from './keys.ts'
import type { PortError, Result } from './result.ts'

/** One run of an agw workflow: the object piped on stdin, the idempotency key, and the schema its output must have. */
export interface AgwCall<T> {
  workflow: string
  input: unknown
  /** the same key is the same run: a replayed call finds the run it started */
  key: Key
  output: ZodType<T>
}

/**
 * The factory's one way to ask a judgment of agw (`docs/architecture.md` §Loops and agw). The factory never calls a model;
 * a workflow does. An agent run takes as long as it takes, so the only limit is a hang guard of 30 minutes. Never called
 * inside a transaction.
 */
export interface AgwPort {
  run<T>(call: AgwCall<T>): Promise<Result<T, PortError>>
}

/** The hang guard of an agw run: no run is cut short before it, because a slow episode is not a stuck one. */
export const AGW_HANG_GUARD_MS = 30 * 60_000
