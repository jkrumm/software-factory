import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SQL } from 'bun'
import { acquireSingleton, migrate, MIGRATIONS_DIR } from '../src/db.ts'
import { LOCKS } from '../src/locks.ts'
import { lockCapacity } from '../src/capacity.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

let db: TestDb
let dir: string

beforeAll(async () => {
  db = await startTestDb({ migrate: false })
  dir = await mkdtemp('/tmp/factory-migrations-')
  // The sleep keeps the first runner inside its migration while the second starts, so an unguarded check would race.
  await writeFile(join(dir, '001_slow.sql'), 'CREATE TABLE factory.slow (id int); SELECT pg_sleep(0.5);')
  await writeFile(join(dir, '002_more.sql'), 'CREATE TABLE factory.more (id int);')
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
  await db.stop()
})

describe('migrate', () => {
  // finding 9
  test('concurrent runners apply each migration once and neither fails', async () => {
    const runs = await Promise.all([migrate(db.sql, dir), migrate(db.sql, dir), migrate(db.sql, dir)])
    expect(runs.map((r) => r.length).sort()).toEqual([0, 0, 2])
    const rows = await db.sql`SELECT name FROM factory.schema_migrations ORDER BY name`
    expect(rows.map((r: { name: string }) => r.name)).toEqual(['001_slow.sql', '002_more.sql'])
  })

  test('a second run applies nothing', async () => {
    expect(await migrate(db.sql, dir)).toEqual([])
  })

  test('everything lives in the factory schema', async () => {
    await migrate(db.sql)
    const rows = await db.sql`
      SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')`
    expect(new Set(rows.map((r: { schema: string }) => r.schema))).toEqual(new Set(['factory']))
    expect(rows.map((r: { name: string }) => r.name)).toEqual(
      expect.arrayContaining(['events', 'capacity_readings', 'spawns', 'schema_migrations']),
    )
  })

  test('a failing migration rolls back the whole run and records nothing', async () => {
    const bad = await mkdtemp('/tmp/factory-migrations-bad-')
    try {
      await writeFile(join(bad, '001_ok.sql'), 'CREATE TABLE factory.rolled_back (id int);')
      await writeFile(join(bad, '002_bad.sql'), 'SELECT nope FROM nowhere;')
      // oxlint-disable-next-line typescript/await-thenable -- bun types `rejects` matchers as void; they return a promise
      await expect(migrate(db.sql, bad)).rejects.toThrow()
      const [{ count }] = await db.sql`
        SELECT count(*)::int AS count FROM information_schema.tables WHERE table_name = 'rolled_back'`
      expect(count).toBe(0)
    } finally {
      await rm(bad, { recursive: true, force: true })
    }
  })

  test('the shipped migrations directory exists and is not empty', async () => {
    expect(await Bun.file(join(MIGRATIONS_DIR, '001_init.sql')).exists()).toBe(true)
  })
})

describe('one process', () => {
  test('the lock keys are all different', () => {
    const keys = Object.values(LOCKS)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('holding the one-process lock does not block the transaction locks the tick takes', async () => {
    const held = await acquireSingleton(db.sql)
    try {
      const taken = db.sql.begin(async (tx) => {
        await lockCapacity(tx)
        return 'locked'
      })
      expect(await Promise.race([taken, Bun.sleep(3000).then(() => 'blocked')])).toBe('locked')
      await migrate(db.sql, dir)
    } finally {
      await held?.release()
    }
  })

  test('a second holder of the lock is told so, and gets it once the first lets go', async () => {
    const other = new SQL({ adapter: 'postgres', path: db.path, username: 'factory', database: 'postgres', max: 2 })
    try {
      const first = await acquireSingleton(db.sql)
      expect(first).toBeDefined()
      expect(await acquireSingleton(other)).toBeUndefined()
      await first?.release()
      const second = await acquireSingleton(other)
      expect(second).toBeDefined()
      expect(await acquireSingleton(db.sql)).toBeUndefined()
      await second?.release()
    } finally {
      await other.close()
    }
  })

  test('a server whose lock connection is lost is told, so it can exit', async () => {
    const lostReasons: string[] = []
    const holder = new SQL({ adapter: 'postgres', path: db.path, username: 'factory', database: 'postgres', max: 2 })
    try {
      expect(await acquireSingleton(holder, { checkMs: 30, onLost: (r) => lostReasons.push(r) })).toBeDefined()
      await Bun.sleep(100)
      expect(lostReasons).toEqual([])
      await db.sql`
        SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND objid = ${LOCKS.singleton} AND granted`
      for (let i = 0; i < 100 && lostReasons.length === 0; i++) await Bun.sleep(20)
      expect(lostReasons).toHaveLength(1)
    } finally {
      await holder.close().catch(() => {})
    }
  })

  test('a holder whose connection dies frees the lock', async () => {
    const dying = new SQL({ adapter: 'postgres', path: db.path, username: 'factory', database: 'postgres', max: 2 })
    expect(await acquireSingleton(dying)).toBeDefined()
    await db.sql`
      SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND objid = ${LOCKS.singleton} AND granted`
    let next = await acquireSingleton(db.sql)
    for (let i = 0; i < 50 && !next; i++) {
      await Bun.sleep(20)
      next = await acquireSingleton(db.sql)
    }
    expect(next).toBeDefined()
    await next?.release()
    await dying.close().catch(() => {})
  })
})

describe('migrate as the schema owner', () => {
  // The shared database: the `factory` role owns its schema and holds no CREATE on the database.
  test('a role that owns the schema but cannot create schemas migrates', async () => {
    await db.sql.unsafe('CREATE DATABASE shared_like')
    const admin = new SQL({ adapter: 'postgres', path: db.path, username: 'factory', database: 'shared_like', max: 1 })
    try {
      await admin.unsafe(`
        CREATE ROLE schema_owner LOGIN;
        REVOKE ALL ON DATABASE shared_like FROM PUBLIC;
        GRANT CONNECT ON DATABASE shared_like TO schema_owner;
        REVOKE ALL ON SCHEMA public FROM PUBLIC;
        CREATE SCHEMA factory AUTHORIZATION schema_owner;`)
      const owner = new SQL({
        adapter: 'postgres',
        path: db.path,
        username: 'schema_owner',
        database: 'shared_like',
        max: 2,
      })
      try {
        expect((await migrate(owner)).length).toBeGreaterThan(0)
        expect(await migrate(owner)).toEqual([])
      } finally {
        await owner.close()
      }
    } finally {
      await admin.close()
    }
  })
})
