import type { SQL } from 'bun'

/**
 * Runs `fn` in a read-only transaction whose statements may take `timeoutMs` each, so a slow query over a table another
 * component owns ends in an error the caller turns into "unmeasured" instead of holding a connection. The one place in
 * `read/` that opens a transaction (`scripts/boundaries.ts`). Inside a transaction already (a caller's) it opens a
 * savepoint, so a timeout or an error undoes only this work.
 */
export function boundedRead<T>(sql: SQL, timeoutMs: number, fn: (tx: SQL) => Promise<T>): Promise<T> {
  const run = async (tx: SQL): Promise<T> => {
    await tx`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true)`
    return fn(tx)
  }
  const outer = sql as unknown as {
    begin?: (mode: string, f: (tx: SQL) => Promise<T>) => Promise<T>
    savepoint?: (f: (tx: SQL) => Promise<T>) => Promise<T>
  }
  if (typeof outer.begin === 'function') return outer.begin('read only', run)
  if (typeof outer.savepoint === 'function') return outer.savepoint(run)
  throw new Error('boundedRead needs a pool or a transaction')
}
