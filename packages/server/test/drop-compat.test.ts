import { afterAll, beforeAll, expect, test } from 'bun:test'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { migrate, MIGRATIONS_DIR } from '../src/db.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

let db: TestDb
let dir: string

beforeAll(async () => {
  db = await startTestDb({ migrate: false })
  dir = await mkdtemp('/tmp/factory-migrations-011-')
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
  await db.stop()
})

test('migration 011 drops the herdr columns, the old capacity table and the old event kind', async () => {
  const names = (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith('.sql')).sort()
  for (const name of names.filter((n) => n < '011')) await copyFile(join(MIGRATIONS_DIR, name), join(dir, name))
  await migrate(db.sql, dir)

  const at = new Date('2026-10-30T12:00:00Z')
  await db.sql`INSERT INTO factory.sessions (id, created_at, agent_status, agent_seen_at, herdr_status, herdr_seen_at)
    VALUES ('s', ${at}, 'working', ${at}, 'working', ${at})`
  // A rollback to the release before 010 wrote the old kind again, once with a key the new kind already has.
  await db.sql`INSERT INTO factory.events (key, session, kind, at) VALUES
    ('herdr_restarted:7@x', '_herdr', 'herdr_restarted', ${at}),
    ('herdr_restarted:8@x', '_herdr', 'herdr_restarted', ${at}),
    ('runner_restarted:8@x', '_runner', 'runner_restarted', ${at})`
  await db.sql`UPDATE factory.sessions SET tab = 'w8:t1'`
  await db.sql`INSERT INTO factory.witness (name, value, at) VALUES ('herdr_server', '99@x', ${at}), ('runner_server', '99@x', ${at})`

  for (const name of names.filter((n) => n.startsWith('011')))
    await copyFile(join(MIGRATIONS_DIR, name), join(dir, name))
  expect(await migrate(db.sql, dir)).toEqual(['011_drop_compat.sql'])

  expect(await db.sql`SELECT agent_status, agent_seen_at FROM factory.sessions`).toEqual([
    { agent_status: 'working', agent_seen_at: at },
  ])
  expect(await db.sql`SELECT tab FROM factory.sessions`).toEqual([{ tab: null }])
  expect(
    await db.sql`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'factory' AND table_name = 'sessions' AND column_name LIKE 'herdr%'`,
  ).toEqual([])
  expect(
    await db.sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'factory' AND table_name = 'capacity_readings'`,
  ).toEqual([])
  expect(await db.sql`SELECT name FROM factory.witness`).toEqual([{ name: 'runner_server' }])

  expect(await db.sql`SELECT key, session, kind FROM factory.events ORDER BY key`).toEqual([
    { key: 'runner_restarted:7@x', session: '_runner', kind: 'runner_restarted' },
    { key: 'runner_restarted:8@x', session: '_runner', kind: 'runner_restarted' },
  ])
  await db.sql`INSERT INTO factory.events (key, session, kind, at) VALUES ('k2', '_runner', 'runner_restarted', ${at})`
  const old = async () => {
    await db.sql`INSERT INTO factory.events (key, session, kind, at) VALUES ('k', '_herdr', 'herdr_restarted', ${at})`
  }
  // oxlint-disable-next-line typescript/await-thenable -- bun types `rejects` matchers as void; they return a promise
  await expect(old()).rejects.toThrow()
})
