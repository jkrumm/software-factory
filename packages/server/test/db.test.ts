import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { migrate, MIGRATIONS_DIR } from '../src/db.ts'
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
