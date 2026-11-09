import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SQL } from 'bun'
import { LOCKS } from './locks.ts'

export const SCHEMA = 'factory'
export const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', '..', 'migrations')

/** `0001_schema.sql`: four digits, so no name can meet one of the old core's three-digit files in a ledger. */
const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/

export interface Migration {
  name: string
  text: string
}

/**
 * Numbers two applied migrations already share (two merges took the same one). The ledger keys on the name, so they
 * stay; renaming either would read as "applied but missing". No number is added here: a new migration takes a free one.
 */
export const SHARED_NUMBERS = new Set(['0993'])

/** The release's migrations in the order they apply; a file that is not named like one, or reuses a number, is an error, not skipped. */
export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort()
  const misnamed = names.find((name) => !MIGRATION_NAME.test(name))
  if (misnamed) throw new Error(`migration ${misnamed} is not named NNNN_words.sql`)
  const repeated = names.find((name, i) => {
    const number = name.slice(0, 4)
    return i > 0 && names[i - 1]?.startsWith(number) && !SHARED_NUMBERS.has(number)
  })
  if (repeated)
    throw new Error(`migration ${repeated} reuses the number of ${names[names.indexOf(repeated) - 1]}: take a free one`)
  return Promise.all(names.map(async (name) => ({ name, text: await Bun.file(join(dir, name)).text() })))
}

const checksum = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex')

/**
 * Applies every migration not yet in `factory.schema_migrations`, in name order, in one transaction behind a
 * transaction-level advisory lock: a second copy waits, then finds everything applied.
 *
 * The rules are enforced here, not trusted: an applied migration's text never changes (its checksum is stored), a new
 * file never sorts before an applied one, and a migration runs with an empty `search_path`, so every name it uses is
 * qualified with `factory.` or the statement fails. Changes are expand then contract: add, move the code, drop later.
 */
export async function migrate(sql: SQL, migrations: Migration[]): Promise<string[]> {
  return sql.begin(async (tx) => {
    // A migration may legitimately run past the pool's session limits; they come back with the transaction's end.
    await tx`SELECT set_config('statement_timeout', '0', true), set_config('lock_timeout', '0', true)`
    await tx`SELECT pg_advisory_xact_lock(${LOCKS.migration})`
    // CREATE SCHEMA IF NOT EXISTS still demands CREATE on the database, which the schema's owner role need not have.
    const [schema] = await tx`SELECT 1 FROM pg_namespace WHERE nspname = ${SCHEMA}`
    if (!schema) await tx.unsafe(`CREATE SCHEMA ${SCHEMA}`)
    const [ledger] = await tx`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = ${SCHEMA} AND table_name = 'schema_migrations' AND column_name = 'checksum'
      ) AS current,
      to_regclass('factory.schema_migrations') IS NOT NULL AS present`
    if (ledger?.present && !ledger.current) {
      throw new Error(
        'factory.schema_migrations has no checksum column: this is the old core schema; rename it first (factory_legacy)',
      )
    }
    if (!ledger?.present) {
      await tx.unsafe(
        `CREATE TABLE ${SCHEMA}.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
      )
    }

    const rows: { name: string; checksum: string }[] =
      await tx`SELECT name, checksum FROM factory.schema_migrations ORDER BY name`
    const applied = new Map(rows.map((row) => [row.name, row.checksum]))
    const known = new Map(migrations.map((m) => [m.name, m]))
    for (const [name, sum] of applied) {
      const migration = known.get(name)
      if (!migration) throw new Error(`migration ${name} is applied but missing from this release`)
      if (checksum(migration.text) !== sum) throw new Error(`migration ${name} was edited after it was applied`)
    }
    const last = rows.at(-1)?.name
    const pending = migrations.filter((m) => !applied.has(m.name))
    const early = pending.find((m) => last !== undefined && m.name < last)
    if (early) throw new Error(`migration ${early.name} sorts before the applied ${last}: give it a later number`)

    await tx.unsafe(`SET LOCAL search_path TO ''`)
    for (const migration of pending) {
      await tx.unsafe(migration.text)
      await tx`INSERT INTO factory.schema_migrations (name, checksum) VALUES (${migration.name}, ${checksum(migration.text)})`
    }
    return pending.map((m) => m.name)
  })
}
