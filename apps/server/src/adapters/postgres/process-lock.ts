import type { SQL } from 'bun'
import { LOCKS } from './locks.ts'

/** How long a new server asks for the lock while the old copy is still stopping (a deploy's restart). */
export const PROCESS_LOCK_WAIT_MS = 45_000

/**
 * A watchdog query that takes longer than this has found a stalled connection. A host at a load of 200 answers a trivial
 * query in seconds; stopping the server then turns a load spike into a restart whose first tick is late too.
 */
const WATCHDOG_TIMEOUT_MS = 30_000

export interface ProcessLock {
  release(): Promise<void>
}

export interface ProcessLockOptions {
  /** how long to keep asking while another copy holds the lock; 0 asks once */
  waitMs?: number
  /** how often the lock is asked for while waiting */
  retryMs?: number
  /** called once if the lock is gone (the connection dropped, the database restarted): the server must stop */
  onLost?: (reason: string) => void
  /** how often the lock's connection is checked */
  checkMs?: number
}

/**
 * Takes the session-level advisory lock that makes this the only server on the database. The lock belongs to one
 * connection, so it is reserved for the life of the process; the database frees the lock when that connection closes.
 * A dropped connection frees it without a sound, so a watchdog checks that this connection still holds it and reports
 * a loss. Returns `undefined` when another copy still holds the lock after `waitMs`.
 */
export async function acquireProcessLock(sql: SQL, options: ProcessLockOptions = {}): Promise<ProcessLock | undefined> {
  const connection = await sql.reserve()
  const deadline = Date.now() + (options.waitMs ?? PROCESS_LOCK_WAIT_MS)
  let locked = false
  for (;;) {
    const [row] = await connection`SELECT pg_try_advisory_lock(${LOCKS.process}) AS locked`
    locked = Boolean(row?.locked)
    if (locked || Date.now() >= deadline) break
    await Bun.sleep(options.retryMs ?? 500)
  }
  if (!locked) {
    await connection.release()
    return undefined
  }

  let lost = false
  let released = false
  let checking = false
  const lose = (reason: string) => {
    if (lost || released) return
    lost = true
    options.onLost?.(reason)
  }
  const check = async () => {
    // A check that does not come back means a stalled connection: that is a lost lock too, not a reason to wait.
    const stalled = new Promise<'stalled'>((resolve) =>
      setTimeout(() => resolve('stalled'), WATCHDOG_TIMEOUT_MS).unref(),
    )
    const query = connection`
      SELECT EXISTS (
        SELECT 1 FROM pg_locks
        WHERE locktype = 'advisory' AND objid = ${LOCKS.process} AND pid = pg_backend_pid() AND granted
      ) AS held`
    query.catch(() => {})
    const outcome = await Promise.race([query, stalled])
    if (outcome === 'stalled') return lose(`the lock connection did not answer within ${WATCHDOG_TIMEOUT_MS} ms`)
    if (!outcome[0]?.held) lose('the database no longer lists the lock as held by this server')
  }
  const watchdog = setInterval(() => {
    if (checking || released) return
    checking = true
    check()
      .catch((error: unknown) =>
        lose(`the lock connection failed: ${error instanceof Error ? error.message : String(error)}`),
      )
      .finally(() => {
        checking = false
      })
  }, options.checkMs ?? 10_000)
  watchdog.unref()

  return {
    release: async () => {
      released = true
      clearInterval(watchdog)
      await connection`SELECT pg_advisory_unlock(${LOCKS.process})`
      await connection.release()
    },
  }
}
