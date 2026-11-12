import { SQL } from 'bun'

/** Session limits every pooled connection starts with, so a hung query or lock wait fails instead of wedging the tick. */
export interface SessionTimeouts {
  statementMs: number
  lockMs: number
  idleInTransactionMs: number
}

export const DEFAULT_SESSION_TIMEOUTS: SessionTimeouts = {
  statementMs: 30_000,
  lockMs: 10_000,
  idleInTransactionMs: 60_000,
}

/**
 * The pool every adapter shares. `DATABASE_URL` comes from `secrets-run`, never a tracked file. The process lock polls
 * with `pg_try_advisory_lock`, so the statement timeout never cuts its 45 s wait; `migrate` lifts both limits inside its
 * own transaction and `boundedRead` sets its own `statement_timeout`.
 */
export function connect(url: string, timeouts: Partial<SessionTimeouts> = {}): SQL {
  const { statementMs, lockMs, idleInTransactionMs } = { ...DEFAULT_SESSION_TIMEOUTS, ...timeouts }
  return new SQL(url, {
    max: 8,
    connection: {
      statement_timeout: statementMs,
      lock_timeout: lockMs,
      idle_in_transaction_session_timeout: idleInTransactionMs,
    },
  })
}
