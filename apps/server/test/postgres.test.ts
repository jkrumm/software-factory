import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, type Migration, migrate } from '../src/adapters/postgres/migrate.ts'
import { acquireProcessLock, PROCESS_LOCK_WAIT_MS } from '../src/adapters/postgres/process-lock.ts'
import { connect, ping } from '../src/adapters/postgres/connection.ts'
import { LOCKS } from '../src/adapters/postgres/locks.ts'

let db: TestCluster

beforeAll(async () => {
  db = await startTestCluster()
})

afterAll(async () => {
  await db.stop()
})

const m = (name: string, text: string): Migration => ({ name, text })

/** The error a promise rejects with; fails the test when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected a rejection')
}

describe('migrate', () => {
  beforeEach(async () => {
    await db.sql`DROP SCHEMA IF EXISTS factory CASCADE`
  })

  test("the release's migrations apply once into schema factory", async () => {
    const migrations = await loadMigrations()
    expect(migrations[0]?.name).toBe('0001_schema.sql')
    expect(await migrate(db.sql, migrations)).toEqual(migrations.map((x) => x.name))
    expect(await migrate(db.sql, migrations)).toEqual([])
    const [schema] = await db.sql`SELECT obj_description('factory'::regnamespace) AS comment`
    expect(String(schema?.comment)).toContain('software-factory')
  })

  test('two copies at once: the advisory lock serializes them, each migration applies once', async () => {
    const migrations = [m('0001_a.sql', 'CREATE TABLE factory.a (id int)')]
    const [first, second] = await Promise.all([migrate(db.sql, migrations), migrate(db.sql, migrations)])
    expect([...(first ?? []), ...(second ?? [])]).toEqual(['0001_a.sql'])
  })

  test('an unqualified name fails: migrations run with an empty search_path', async () => {
    expect(await rejection(migrate(db.sql, [m('0001_a.sql', 'CREATE TABLE a (id int)')]))).toContain(
      'no schema has been selected',
    )
    const [row] = await db.sql`SELECT to_regclass('public.a') IS NULL AS absent`
    expect(row?.absent).toBe(true)
  })

  test('an applied migration that was edited refuses the start', async () => {
    await migrate(db.sql, [m('0001_a.sql', 'CREATE TABLE factory.a (id int)')])
    expect(await rejection(migrate(db.sql, [m('0001_a.sql', 'CREATE TABLE factory.a (id bigint)')]))).toContain(
      'edited after it was applied',
    )
  })

  test('an applied migration missing from the release refuses the start', async () => {
    await migrate(db.sql, [m('0001_a.sql', 'CREATE TABLE factory.a (id int)')])
    expect(await rejection(migrate(db.sql, []))).toContain('missing from this release')
  })

  test('a new migration that sorts before an applied one refuses the start', async () => {
    await migrate(db.sql, [m('0002_b.sql', 'CREATE TABLE factory.b (id int)')])
    expect(
      await rejection(
        migrate(db.sql, [
          m('0001_a.sql', 'CREATE TABLE factory.a (id int)'),
          m('0002_b.sql', 'CREATE TABLE factory.b (id int)'),
        ]),
      ),
    ).toContain('sorts before the applied')
  })

  test("the old core's ledger (no checksum column) refuses the start", async () => {
    await db.sql`CREATE SCHEMA factory`
    await db.sql`CREATE TABLE factory.schema_migrations (name text PRIMARY KEY)`
    expect(await rejection(migrate(db.sql, await loadMigrations()))).toContain('old core schema')
  })

  test('a failing migration applies nothing', async () => {
    const migrations = [m('0001_a.sql', 'CREATE TABLE factory.a (id int)'), m('0002_b.sql', 'SELECT nope')]
    expect(await rejection(migrate(db.sql, migrations))).toContain('nope')
    const [row] = await db.sql`SELECT to_regclass('factory.a') IS NULL AS absent`
    expect(row?.absent).toBe(true)
  })
})

describe('acquireProcessLock', () => {
  test('a second copy waits as long as it is told, then gets nothing', async () => {
    const first = await acquireProcessLock(db.sql, { waitMs: 0 })
    expect(first).toBeDefined()
    const started = Date.now()
    const second = await acquireProcessLock(db.sql, { waitMs: 400, retryMs: 50 })
    expect(second).toBeUndefined()
    expect(Date.now() - started).toBeGreaterThanOrEqual(400)
    await first?.release()
  })

  test('a copy that waits gets the lock once the holder lets go', async () => {
    const first = await acquireProcessLock(db.sql, { waitMs: 0 })
    setTimeout(() => void first?.release(), 200)
    const second = await acquireProcessLock(db.sql, { waitMs: 5_000, retryMs: 50 })
    expect(second).toBeDefined()
    await second?.release()
  })

  test('the watchdog reports a lock lost with its connection', async () => {
    const lost: string[] = []
    const lock = await acquireProcessLock(db.sql, { waitMs: 0, checkMs: 50, onLost: (reason) => lost.push(reason) })
    await db.sql`SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND objid = ${LOCKS.process} AND granted`
    for (let i = 0; i < 40 && !lost.length; i++) await Bun.sleep(50)
    expect(lost).toHaveLength(1)
    await lock?.release().catch(() => {})
  })

  test('the default wait is 45 s', () => {
    expect(PROCESS_LOCK_WAIT_MS).toBe(45_000)
  })
})

test('a migration that reuses another one’s number is refused, and the shipped files load', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'migrations-'))
  try {
    await writeFile(join(dir, '0001_a.sql'), 'SELECT 1')
    await writeFile(join(dir, '0001_b.sql'), 'SELECT 1')
    expect(await rejection(loadMigrations(dir))).toContain('0001_b.sql reuses the number of 0001_a.sql')
  } finally {
    await rm(dir, { recursive: true })
  }
  expect((await loadMigrations()).length).toBeGreaterThan(0)
})

test('ping is null while the database answers', async () => {
  expect(await ping(db.sql)).toBeNull()
})

describe('connect session timeouts', () => {
  test('a statement past statement_timeout fails', async () => {
    const sql = connect(db.url, { statementMs: 300 })
    try {
      expect(await rejection(sql`SELECT pg_sleep(3)`)).toContain('statement timeout')
    } finally {
      await sql.close()
    }
  })

  test('a lock wait past lock_timeout fails', async () => {
    const sql = connect(db.url, { statementMs: 10_000, lockMs: 300 })
    const holder = await db.sql.reserve()
    try {
      await holder`SELECT pg_advisory_lock(7093999)`
      expect(await rejection(sql`SELECT pg_advisory_lock(7093999)`)).toContain('lock timeout')
    } finally {
      await holder`SELECT pg_advisory_unlock(7093999)`
      await holder.release()
      await sql.close()
    }
  })

  test('migrate is exempt from the statement timeout', async () => {
    await db.sql`DROP SCHEMA IF EXISTS factory CASCADE`
    const sql = connect(db.url, { statementMs: 200 })
    try {
      await migrate(sql, [m('0001_slow.sql', 'SELECT pg_sleep(0.6); CREATE TABLE factory.slow (id int)')])
    } finally {
      await sql.close()
    }
  })
})
