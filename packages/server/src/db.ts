import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SQL } from 'bun'
import { LOCKS } from './locks.ts'

export const SCHEMA = 'factory'
export const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations')

/**
 * Applies every `migrations/*.sql` not yet recorded, in filename order, inside the `factory` schema.
 * One transaction behind a transaction-level advisory lock: a second instance waits, then finds everything applied.
 */
export async function migrate(sql: SQL, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCKS.migration})`
    // CREATE SCHEMA IF NOT EXISTS still demands CREATE on the database, which the schema's owner role does not have.
    const [schema] = await tx`SELECT 1 FROM pg_namespace WHERE nspname = ${SCHEMA}`
    if (!schema) await tx.unsafe(`CREATE SCHEMA ${SCHEMA}`)
    await tx.unsafe(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.schema_migrations (name text PRIMARY KEY)`)
    const applied: string[] = []
    for (const name of files) {
      const [done] = await tx`SELECT 1 FROM factory.schema_migrations WHERE name = ${name}`
      if (done) continue
      await tx.unsafe(await Bun.file(join(dir, name)).text())
      await tx`INSERT INTO factory.schema_migrations (name) VALUES (${name})`
      applied.push(name)
    }
    return applied
  })
}

export interface Singleton {
  release(): Promise<void>
}

export interface SingletonOptions {
  /** called once if the lock is gone (the connection dropped or the database restarted): the server must stop */
  onLost?: (reason: string) => void
  /** how often the connection is checked */
  checkMs?: number
}

/**
 * Takes the session-level advisory lock that makes this the only server on the database. The lock belongs to a
 * connection, so one is reserved and kept for the life of the process; the database drops the lock when it closes.
 * A watchdog checks that this connection still holds it, because a dropped connection frees the lock without a sound
 * and a second copy could then start beside a server that keeps ticking. Returns `undefined` when another copy holds it.
 */
export async function acquireSingleton(sql: SQL, options: SingletonOptions = {}): Promise<Singleton | undefined> {
  const connection = await sql.reserve()
  const [row] = await connection`SELECT pg_try_advisory_lock(${LOCKS.singleton}) AS locked`
  if (!row?.locked) {
    connection.release()
    return undefined
  }

  let lost = false
  const lose = (reason: string) => {
    if (lost) return
    lost = true
    options.onLost?.(reason)
  }
  const watchdog = setInterval(async () => {
    try {
      const [held] = await connection`
        SELECT EXISTS (
          SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory' AND objid = ${LOCKS.singleton} AND pid = pg_backend_pid() AND granted
        ) AS held`
      if (!held?.held) lose('the database no longer lists the lock as held by this server')
    } catch (error) {
      lose(`the lock connection failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, options.checkMs ?? 10_000)
  watchdog.unref()

  return {
    release: async () => {
      clearInterval(watchdog)
      await connection`SELECT pg_advisory_unlock(${LOCKS.singleton})`
      connection.release()
    },
  }
}
