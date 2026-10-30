import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SQL } from 'bun'

export const SCHEMA = 'factory'
export const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations')

/** Arbitrary constant naming the migration lock; every instance of this repo uses the same one. */
const MIGRATION_LOCK = 7_093_001

/**
 * Applies every `migrations/*.sql` not yet recorded, in filename order, inside the `factory` schema.
 * One transaction behind a transaction-level advisory lock: a second instance waits, then finds everything applied.
 */
export async function migrate(sql: SQL, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`
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

/** Names the one-process lock; distinct from the migration lock. */
export const SINGLETON_LOCK = 7_093_002

export interface Singleton {
  release(): Promise<void>
}

/**
 * Takes the session-level advisory lock that makes this the only server on the database. The lock belongs to a
 * connection, so one is reserved and kept for the life of the process; the database drops the lock when it closes.
 * Returns `undefined` when another copy holds it.
 */
export async function acquireSingleton(sql: SQL): Promise<Singleton | undefined> {
  const connection = await sql.reserve()
  const [row] = await connection`SELECT pg_try_advisory_lock(${SINGLETON_LOCK}) AS locked`
  if (!row?.locked) {
    connection.release()
    return undefined
  }
  return {
    release: async () => {
      await connection`SELECT pg_advisory_unlock(${SINGLETON_LOCK})`
      connection.release()
    },
  }
}
