import { afterAll, beforeAll, expect, test } from 'bun:test'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { migrate, MIGRATIONS_DIR } from '../src/db.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

let db: TestDb
let dir: string

beforeAll(async () => {
  db = await startTestDb({ migrate: false })
  dir = await mkdtemp('/tmp/factory-migrations-010-')
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
  await db.stop()
})

test('migration 010 renames what the previous release wrote and keeps the old columns for a rollback', async () => {
  const names = (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith('.sql')).sort()
  const before = names.filter((n) => n < '010')
  for (const name of before) await copyFile(join(MIGRATIONS_DIR, name), join(dir, name))
  await migrate(db.sql, dir)

  // What the previous release left behind.
  const at = new Date('2026-10-30T12:00:00Z')
  await db.sql`INSERT INTO factory.sessions (id, created_at, herdr_status, herdr_seen_at) VALUES ('s', ${at}, 'working', ${at})`
  await db.sql`INSERT INTO factory.events (key, session, kind, at, payload)
    VALUES ('herdr_restarted:99@x', '_herdr', 'herdr_restarted', ${at}, ${{ to: '99@x' }})`
  await db.sql`INSERT INTO factory.witness (name, value, at) VALUES ('herdr_server', '99@Mon Oct 12 10:00:00 2026', ${at})`

  for (const name of names.filter((n) => n >= '010')) await copyFile(join(MIGRATIONS_DIR, name), join(dir, name))
  expect(await migrate(db.sql, dir)).toEqual(['010_runner_vocabulary.sql'])

  expect(await db.sql`SELECT agent_status, agent_seen_at, herdr_status FROM factory.sessions`).toEqual([
    { agent_status: 'working', agent_seen_at: at, herdr_status: 'working' },
  ])
  expect(await db.sql`SELECT key, session, kind, payload FROM factory.events`).toEqual([
    { key: 'runner_restarted:99@x', session: '_runner', kind: 'runner_restarted', payload: { to: '99@x' } },
  ])
  // Copied, not moved: the old row is what a rollback reads.
  expect(await db.sql`SELECT name, value FROM factory.witness ORDER BY name`).toEqual([
    { name: 'herdr_server', value: '99@Mon Oct 12 10:00:00 2026' },
    { name: 'runner_server', value: '99@Mon Oct 12 10:00:00 2026' },
  ])
  // Both kinds are still allowed: the previous release writes the old one if it is rolled back to.
  await db.sql`INSERT INTO factory.events (key, session, kind, at) VALUES ('k', '_herdr', 'herdr_restarted', ${at})`
  await db.sql`INSERT INTO factory.events (key, session, kind, at) VALUES ('k2', '_runner', 'runner_restarted', ${at})`
})
