import { afterAll, beforeAll, expect, test } from 'bun:test'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { readHealthLines } from '../../src/read/lines.ts'

/** `read health` says the MacBook return probe is off while an Errand with a MacBook command waits, and only then. */
const NOW = new Date('2026-11-15T09:00:00.000Z')
let db: TestCluster

beforeAll(async () => {
  db = await startTestCluster()
  await db.sql`DROP SCHEMA IF EXISTS factory CASCADE`
  await migrate(db.sql, await loadMigrations())
})
afterAll(() => db.stop())

const lines = async (macbookProbe: boolean) =>
  (
    await readHealthLines(db.sql, {
      now: NOW,
      accounts: [],
      sources: { doorLines: async () => [], loops: () => [], blockedStreak: 3, mainCheckouts: () => [], macbookProbe },
    })
  ).filter((line) => line.kind === 'macbook-probe')

test('no line while no Errand with a MacBook command is open, with the probe off or on', async () => {
  expect(await lines(false)).toEqual([])
  await db.sql`
    INSERT INTO factory.errands (id, key, summary, raised_at, reached_owner_at, source, command, host)
    VALUES ('errand_plain', 'k-plain', 'a portal step', ${NOW}, ${NOW}, 'test', NULL, 'portal')`
  expect(await lines(false)).toEqual([])
})

test('a line while the probe is off and a MacBook Errand is open; none with the probe on or once it is done', async () => {
  await db.sql`
    INSERT INTO factory.errands (id, key, summary, raised_at, reached_owner_at, source, command, host)
    VALUES ('errand_mac', 'k-mac', 'reseal the cache', ${NOW}, ${NOW}, 'test', 'make secrets-seed', 'macbook')`
  expect(await lines(true)).toEqual([])
  const off = await lines(false)
  expect(off).toHaveLength(1)
  expect(off[0]?.text).toContain('FACTORY_ASK_HUMAN_HOST')
  expect(off[0]?.text).toContain('1 Errand with a MacBook command')
  await db.sql`UPDATE factory.errands SET done_at = ${NOW} WHERE id = 'errand_mac'`
  expect(await lines(false)).toEqual([])
})
