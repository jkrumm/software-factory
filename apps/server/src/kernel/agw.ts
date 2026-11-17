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
 * a workflow does. An agent run takes as long as it takes: there is no wall-clock ceiling, only an idle watchdog
 * (`AGW_IDLE_MS`). Never called inside a transaction.
 */
export interface AgwPort {
  run<T>(call: AgwCall<T>): Promise<Result<T, PortError>>
}

/**
 * The idle watchdog of an agw call (`rules/agent-limits.md`): the `agw` process it waits on prints nothing and does not
 * exit for this long. `agw` itself ends a pending wait every 110 s with an envelope, so a healthy run, however long, keeps
 * resetting it; only a wedged process is ended. A call that keeps answering runs as long as the work takes.
 */
export const AGW_IDLE_MS = 10 * 60_000

/**
 * How long a claimed agw call is left before another pass may take the claim over. It is a lease, not a limit on the run:
 * a retaken call carries the same idempotency key, so agw hands back the run it already started and a long run is joined,
 * never doubled.
 */
export const AGW_CALL_LEASE_MS = 35 * 60_000
