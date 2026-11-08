import { SQL } from 'bun'

/** A database answer slower than this counts as no answer for `/health`. */
const PING_TIMEOUT_MS = 2_000

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

/** Null when the database answers, else why it did not. */
export async function ping(sql: SQL): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`the database did not answer within ${PING_TIMEOUT_MS} ms`), PING_TIMEOUT_MS)
  })
  const query = sql`SELECT 1`.then(
    () => null,
    (error: unknown) => `the database failed: ${error instanceof Error ? error.message : String(error)}`,
  )
  try {
    return await Promise.race([query, timeout])
  } finally {
    clearTimeout(timer)
  }
}
