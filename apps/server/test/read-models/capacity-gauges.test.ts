import { afterAll, beforeAll, expect, test } from 'bun:test'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { readCapacityGauges } from '../../src/read/capacity-gauges.ts'

let db: TestCluster
const NOW = new Date('2026-11-18T10:00:00Z')
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000)

beforeAll(async () => {
  db = await startTestCluster()
  await migrate(db.sql, await loadMigrations())
  const { sql } = db
  for (const id of ['issue_1', 'issue_2', 'issue_3', 'issue_4'])
    await sql`INSERT INTO factory.issues (id, repo, state, version) VALUES (${id}, 'app', 'queued', 1)`
  // open intervals count, a closed one does not
  const intervals: Array<[string, string, Date | null]> = [
    ['issue_1', 'memory', null],
    ['issue_2', 'memory', null],
    ['issue_3', 'chain', null],
    ['issue_4', 'claim', at(30)],
  ]
  for (const [issue, kind, to] of intervals)
    await sql`INSERT INTO factory.queue_intervals (issue_id, project, kind, message, from_at, to_at)
      VALUES (${issue}, 'app', ${kind}, 'because', ${at(60)}, ${to})`
  // slot waits: two in the window (one split over two reasons), one before it, one in the future
  const waits: Array<[Date, string | null, number, Record<string, number>]> = [
    [at(1), '/src/alpha', 3000, { load: 2000, line: 1000 }],
    [at(4), '/src/alpha', 6000, { load: 6000 }],
    [at(4), null, 500, { slots: 500 }],
    [at(10), '/src/alpha', 99_999, { memory: 99_999 }],
    [at(-1), '/src/alpha', 99_999, { memory: 99_999 }],
  ]
  for (const [when, repo, wait, split] of waits)
    await sql`INSERT INTO factory.slot_waits (at, name, repo, outcome, wait_ms, split)
      VALUES (${when}, 'alpha unit', ${repo}, 'granted', ${wait}, ${JSON.stringify(split)}::text::jsonb)`
  const placements: Array<[Date, string, string]> = [
    [at(1), 'vps', 'free'],
    [at(2), 'vps', 'free'],
    [at(3), 'mini', 'no_room'],
    [at(20), 'mini', 'held'],
  ]
  for (const [when, host, reason] of placements)
    await sql`INSERT INTO factory.step_placements (at, name, host, reason) VALUES (${when}, 'unit', ${host}, ${reason})`
  for (const [issue, account] of [
    ['issue_1', 'me'],
    ['issue_2', 'me'],
    ['issue_3', null],
  ] as const)
    await sql`INSERT INTO factory.capacity_claims (issue_id, repo, urgent, account, taken_at)
      VALUES (${issue}, 'app', false, ${account}, ${at(5)})`
  await sql`INSERT INTO factory.host_samples (at, load, load_ceiling) VALUES (${at(10)}, 99, 1), (${at(1)}, 9, 8)`
})
afterAll(() => db.stop())

test('the figures are the state now and the last five minutes, over the tables the capacity reads use', async () => {
  const g = await readCapacityGauges(db.sql, { now: NOW, windowMs: 300_000 })
  expect(g.queue.toSorted((a, b) => a.reason.localeCompare(b.reason))).toEqual([
    { reason: 'chain', issues: 1 },
    { reason: 'memory', issues: 2 },
  ])
  expect(g.slotWaits.toSorted((a, b) => (a.reason + a.repo).localeCompare(b.reason + b.repo))).toEqual([
    { reason: 'line', repo: 'alpha', waits: 1, totalMs: 1000 },
    { reason: 'load', repo: 'alpha', waits: 2, totalMs: 8000 },
    { reason: 'slots', repo: '(unknown)', waits: 1, totalMs: 500 },
  ])
  expect(g.slotWaitP90.find((r) => r.reason === 'load')?.p90Ms).toBeCloseTo(5600, 5)
  expect(g.placements.toSorted((a, b) => (a.host + a.reason).localeCompare(b.host + b.reason))).toEqual([
    { host: 'mini', reason: 'no_room', steps: 1 },
    { host: 'vps', reason: 'free', steps: 2 },
  ])
  expect(g.seats).toEqual([{ account: 'me', used: 2 }])
  expect(g.host).toEqual({ load: 9, loadCeiling: 8 })
})

test('a host sample older than three minutes reads as no host', async () => {
  const g = await readCapacityGauges(db.sql, { now: new Date(NOW.getTime() + 10 * 60_000), windowMs: 300_000 })
  expect(g.host).toBeNull()
})
