import { afterAll, beforeAll, expect, test } from 'bun:test'
import { KpiModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import type { SQL } from 'bun'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { readKpis } from '../../src/read/kpis.ts'

/** The figures that count what the factory moved and what it waited for: closed per day, slot wait, minutes over the ceiling, the recommendation taken. */
let db: TestCluster
let sql: SQL
const NOW = new Date('2026-11-17T12:00:00Z')
const ago = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000)

beforeAll(async () => {
  db = await startTestCluster()
  sql = db.sql
  await migrate(sql, await loadMigrations())

  // three Issues closed in the window (one done, one dropped, one cancelled), one before it
  for (const [n, outcome, hours] of [
    [1, 'done', 30],
    [2, 'dropped', 20],
    [3, 'cancelled', 10],
    [4, 'done', 24 * 9],
  ] as const) {
    await sql`INSERT INTO factory.issues (id, repo, state, outcome, version) VALUES (${`issue_${n}`}, 'app', 'closed', ${outcome}, 2)`
    await sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, from_state, to_state, outcome)
      VALUES (${`event_${n}`}, ${`issue_${n}`}, ${`key_${n}`}, 'closed', '{}'::jsonb, 'factory', ${ago(hours)}, 'applied', 2, 'working', 'closed', ${outcome})`
  }

  // ten host minutes, four of them over the ceiling of 8; a minute with no ceiling stored is not sampled against one
  for (let m = 0; m < 10; m++)
    await sql`INSERT INTO factory.host_samples (at, load, load_ceiling)
      VALUES (${new Date(ago(5).getTime() + m * 60_000)}, ${m < 4 ? 9 : 3}, 8)`
  await sql`INSERT INTO factory.host_samples (at, load, load_ceiling) VALUES (${ago(4)}, 50, NULL)`

  // three steps that waited 1, 2 and 3 s for a slot, one a week before
  await sql`INSERT INTO factory.step_costs (at, name, duration_ms, wait_ms) VALUES
    (${ago(3)}, 'check', 10, 1000), (${ago(3)}, 'check', 10, 2000), (${ago(3)}, 'check', 10, 3000), (${ago(24 * 9)}, 'check', 10, 90000)`

  // three Decisions the owner answered (the floor of a share is three): two with the recommended option (in other case and with spaces), one with the other
  await sql`INSERT INTO factory.issues (id, repo, state, version) VALUES ('issue_5', 'app', 'working', 1)`
  for (const [id, answer] of [
    ['decision_1', ' PINO '],
    ['decision_2', 'winston'],
    ['decision_3', 'Pino'],
  ] as const)
    await sql`INSERT INTO factory.decisions
      (id, key, issue_id, repo, attempt, question, recommendation, checked, options, no_answer, asked_at, answer, settled_by, answered_at)
      VALUES (${id}, ${`key_${id}`}, 'issue_5', 'app', 1, 'Which logger?', 'pino', 'checked', '[]'::jsonb,
        '{"consequence":"x","default":null,"waitMinutes":null}'::jsonb, ${ago(6)}, ${answer}, 'owner', ${ago(2)})`
})
afterAll(() => db.stop())

const kpi = async (key: string) => {
  const model = KpiModel.parse(await readKpis(sql, { now: NOW, days: 7 }))
  const found = model.kpis.find((k) => k.key === key)
  if (!found) throw new Error(`no KPI ${key}`)
  return found
}

test('closed per day counts every outcome in the window over its days', async () => {
  expect(await kpi('issues_closed_per_day')).toMatchObject({ count: 3, n: 7, unit: 'per_day', direction: 'higher' })
  expect((await kpi('issues_closed_per_day')).value).toBeCloseTo(3 / 7, 6)
})

test('the slot wait is the median over the steps of the window, with its 90th percentile as the part', async () => {
  const k = await kpi('test_slot_wait_p50')
  expect(k).toMatchObject({ n: 3, value: 2000 })
  expect(k.parts).toEqual([{ key: 'p90', label: '90th percentile', value: 2800, unit: 'ms' }])
})

test('minutes over the ceiling are a share of the minutes sampled against one', async () => {
  expect(await kpi('minutes_over_ceiling')).toMatchObject({ n: 10, count: 4, value: 0.4, unit: 'share' })
})

test('the recommendation taken is the answers that name the recommended option, ignoring case and spaces', async () => {
  const k = await kpi('recommendation_taken')
  expect(k.value).toBeCloseTo(2 / 3, 6)
  expect(k).toMatchObject({ n: 3, count: 2, direction: 'lower' })
})

test('every KPI carries its direction, target source and decision from the catalog', async () => {
  const model = KpiModel.parse(await readKpis(sql, { now: NOW, days: 7 }))
  for (const k of model.kpis) {
    expect(k.targetSource.length, k.key).toBeGreaterThan(8)
    expect(k.decision.length, k.key).toBeGreaterThan(8)
    expect(k.numerator.length, k.key).toBeGreaterThan(8)
    expect(k.denominator.length, k.key).toBeGreaterThan(8)
    // a target is never a band, so a value better than it is never off it
    expect(['at_most', 'at_least', 'trend'], k.key).toContain(k.target.kind)
  }
})
