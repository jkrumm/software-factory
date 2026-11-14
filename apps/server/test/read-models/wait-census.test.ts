import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { WaitCensusModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import type { SQL } from 'bun'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { readWaitCensus } from '../../src/read/wait-census.ts'

/**
 * The wait census counts the waits that began in the window by reason and length and marks the person waits that no
 * person's hands ended. Seeded with SQL over a real Postgres: a wait is the span from the event whose `wait.since` is its
 * own version to the next event that leaves the state or begins another wait.
 */
let db: TestCluster
let sql: SQL
const NOW = new Date('2026-11-14T12:00:00Z')
const MIN = 60_000
const HOUR = 60 * MIN
const at = (ms: number): Date => new Date(NOW.getTime() + ms)

beforeAll(async () => {
  db = await startTestCluster()
  sql = db.sql
  await migrate(sql, await loadMigrations())
})
afterAll(() => db.stop())
beforeEach(async () => {
  await sql`TRUNCATE factory.issue_events, factory.issues CASCADE`
})

let keys = 0
async function event(
  id: string,
  version: number,
  kind: string,
  when: Date,
  to: string,
  options: { actor?: string; wait?: { reason: string; since: number } } = {},
) {
  const wait = options.wait ? JSON.stringify({ ...options.wait, told: 1 }) : null
  await sql`INSERT INTO factory.issue_events
    (id, issue_id, key, kind, payload, actor, at, result, version, from_state, to_state, wait)
    VALUES (${`event_${++keys}`}, ${id}, ${`key_${keys}`}, ${kind}, '{}'::jsonb, ${options.actor ?? 'factory'}, ${when},
      'applied', ${version}, ${version === 1 ? null : 'working'}, ${to}, ${wait}::text::jsonb)`
}

/** An Issue that waited on `reason` from `from` and, when `to` is given, left the wait then at the hands of `actor`. */
async function waited(n: number, reason: string, from: Date, to: Date | null, actor = 'owner') {
  const id = `issue_${n}`
  await sql`INSERT INTO factory.issues (id, repo, state, version) VALUES (${id}, 'app', 'working', 1)`
  await event(id, 1, 'filed', at(-90 * 24 * HOUR), 'settling')
  await event(id, 2, 'deferred', from, 'waiting', { wait: { reason, since: 2 } })
  // a note while waiting keeps the wait: it does not end it
  await event(id, 3, 'noted', new Date(from.getTime() + MIN), 'waiting', { actor: 'owner', wait: { reason, since: 2 } })
  if (to) await event(id, 4, 'woken', to, 'working', { actor })
  return id
}

const census = async (days = 7) => WaitCensusModel.parse(await readWaitCensus(sql, { now: NOW, days }))
const row = (model: WaitCensusModel, reason: string) => model.byReason.find((card) => card.reason === reason)

describe('the wait census', () => {
  test('counts waits by reason with length buckets, the percentiles and who ended them', async () => {
    await waited(1, 'review', at(-30 * HOUR), at(-6 * HOUR), 'owner') // 24 h
    await waited(2, 'review', at(-30 * HOUR), at(-6 * HOUR - 30 * MIN), 'factory') // 23.5 h, a default verdict
    await waited(3, 'timer', at(-3 * HOUR), at(-2 * HOUR), 'factory') // 1 h
    await waited(4, 'timer', at(-3 * HOUR), at(-3 * HOUR + 10 * MIN), 'factory') // 10 min

    const model = await census()
    expect(model.waits).toBe(4)
    const review = row(model, 'review')
    expect(review).toMatchObject({
      person: true,
      count: 2,
      buckets: { lt30m: 0, lt2h: 0, lt24h: 1, gte24h: 1 },
      endedBy: { owner: 1, factory: 1, judge: 0, steward: 0, open: 0 },
      totalSeconds: 24 * 3600 + 23.5 * 3600,
    })
    const timer = row(model, 'timer')
    expect(timer).toMatchObject({ person: false, count: 2, buckets: { lt30m: 1, lt2h: 1, lt24h: 0, gte24h: 0 } })
    expect(timer?.p50Seconds).toBe(2100)
    expect(timer?.p90Seconds).toBe(3300)
    // every reason is listed, the dearest first, the unused ones at zero
    expect(model.byReason).toHaveLength(11)
    expect(model.byReason[0]?.reason).toBe('review')
    expect(row(model, 'errand')).toMatchObject({ count: 0, p50Seconds: null, totalSeconds: 0 })
  })

  test('a person wait the owner did not end is avoidable; a timer, a stall and an owner answer are not', async () => {
    await waited(1, 'decision', at(-5 * HOUR), at(-4 * HOUR), 'judge') // 1 h
    await waited(2, 'review', at(-5 * HOUR), at(-3 * HOUR), 'factory') // 2 h, the default verdict
    await waited(3, 'decision', at(-5 * HOUR), at(-4 * HOUR), 'owner')
    await waited(4, 'timer', at(-5 * HOUR), at(-1 * HOUR), 'factory')
    await waited(5, 'blocked', at(-5 * HOUR), at(-1 * HOUR), 'steward')
    await waited(6, 'errand', at(-5 * HOUR), null) // still going: not avoidable yet

    const model = await census()
    expect(model.avoidableSeconds).toBe(3 * 3600)
    expect(model.totalSeconds).toBe((1 + 2 + 1 + 4 + 4 + 5) * 3600)
    expect(model.avoidableShare).toBeCloseTo(3 / 17, 3)
    expect(row(model, 'decision')).toMatchObject({ avoidableCount: 1, avoidableSeconds: 3600 })
    expect(row(model, 'review')).toMatchObject({ avoidableCount: 1, avoidableSeconds: 7200 })
    expect(row(model, 'timer')?.avoidableCount).toBe(0)
    expect(row(model, 'blocked')?.avoidableCount).toBe(0)
    expect(model.longest.map((wait) => wait.issue)).toEqual([
      'issue_6',
      'issue_4',
      'issue_5',
      'issue_2',
      'issue_1',
      'issue_3',
    ])
    expect(model.longest[0]).toMatchObject({
      reason: 'errand',
      open: true,
      endedBy: 'open',
      avoidable: false,
      seconds: 5 * 3600,
    })
  })

  test('the orchestrator is the owner’s hands; a lead or the factory is not a person', async () => {
    await waited(1, 'decision', at(-5 * HOUR), at(-4 * HOUR), 'orchestrator')
    await waited(2, 'errand', at(-5 * HOUR), at(-4 * HOUR), 'lead')

    const model = await census()
    expect(row(model, 'decision')).toMatchObject({ endedBy: { owner: 1, factory: 0 }, avoidableCount: 0 })
    expect(row(model, 'errand')).toMatchObject({ endedBy: { owner: 0, factory: 1 }, avoidableCount: 1 })
  })

  test('a wait is counted by the time it began; one before the window is not', async () => {
    await waited(1, 'timer', at(-8 * 24 * HOUR), at(-7 * 24 * HOUR))
    await waited(2, 'timer', at(-2 * HOUR), at(-HOUR))

    expect((await census(7)).waits).toBe(1)
    expect((await census(10)).waits).toBe(2)
  })

  test('a wait replaced by another wait ends there; an empty window answers zeros', async () => {
    const id = 'issue_1'
    await sql`INSERT INTO factory.issues (id, repo, state, version) VALUES (${id}, 'app', 'working', 1)`
    await event(id, 1, 'filed', at(-90 * 24 * HOUR), 'settling')
    await event(id, 2, 'deferred', at(-3 * HOUR), 'waiting', { wait: { reason: 'timer', since: 2 } })
    await event(id, 3, 'deferred', at(-2 * HOUR), 'waiting', { wait: { reason: 'dependency', since: 3 } })
    const model = await census()
    expect(row(model, 'timer')).toMatchObject({ count: 1, totalSeconds: 3600 })
    expect(row(model, 'dependency')).toMatchObject({ count: 1, open: 1, totalSeconds: 2 * 3600 })

    await sql`TRUNCATE factory.issue_events, factory.issues CASCADE`
    expect(await census()).toMatchObject({ waits: 0, totalSeconds: 0, avoidableShare: null, longest: [] })
  })
})
