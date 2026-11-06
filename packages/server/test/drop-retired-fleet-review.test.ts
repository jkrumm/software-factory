import { afterAll, beforeAll, expect, test } from 'bun:test'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { migrate, MIGRATIONS_DIR } from '../src/db.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

const MIGRATION = '035_drop_retired_fleet_review.sql'
const DROPPED_TABLES = [
  'fleet_triage_log',
  'fleet_ask_seen',
  'fleet_acts',
  'fleet_presence_acts',
  'fleet_seen',
  'fleet_windows',
  'review_outcomes',
]
const DROPPED_COLUMNS = ['review_job', 'review_tier', 'review_effort', 'deep_allowed']

let db: TestDb
let dir: string

beforeAll(async () => {
  db = await startTestDb({ migrate: false })
  dir = await mkdtemp('/tmp/factory-migrations-035-')
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
  await db.stop()
})

test('migration 035 drops the retired fleet and review stores and keeps the digest and the spawns', async () => {
  const names = (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith('.sql')).sort()
  for (const name of names.filter((n) => n < MIGRATION)) await copyFile(join(MIGRATIONS_DIR, name), join(dir, name))
  await migrate(db.sql, dir)

  const at = new Date('2026-11-06T12:00:00Z')
  await db.sql`INSERT INTO factory.spawns (key, repo, prompt, status, created_at, review_job, review_tier, review_effort, deep_allowed)
    VALUES ('k', '/r', 'p', 'queued', ${at}, 'job', 'light', 'low', true)`
  await db.sql`INSERT INTO factory.fleet_digest (key, fingerprint, answer, at) VALUES ('heading:x', 'f', '"a"', ${at})`

  await copyFile(join(MIGRATIONS_DIR, MIGRATION), join(dir, MIGRATION))
  expect(await migrate(db.sql, dir)).toEqual([MIGRATION])

  const tables = await db.sql`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'factory'`
  const present = new Set(tables.map((t: { name: string }) => t.name))
  for (const gone of DROPPED_TABLES) expect(present.has(gone)).toBe(false)
  for (const kept of [
    'fleet_digest',
    'fleet_digest_runs',
    'fleet_digest_pending',
    'fleet_digest_backoff',
    'fleet_snapshot',
    'spawns',
  ])
    expect(present.has(kept)).toBe(true)

  const columns = await db.sql`SELECT column_name AS name FROM information_schema.columns
    WHERE table_schema = 'factory' AND table_name = 'spawns'`
  const have = new Set(columns.map((c: { name: string }) => c.name))
  for (const gone of DROPPED_COLUMNS) expect(have.has(gone)).toBe(false)

  expect(await db.sql`SELECT key FROM factory.spawns`).toEqual([{ key: 'k' }])
  expect(await db.sql`SELECT key FROM factory.fleet_digest`).toEqual([{ key: 'heading:x' }])
})
