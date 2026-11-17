import { afterAll, beforeAll, expect, test } from 'bun:test'
import { FrictionModel, KpiModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import type { SQL } from 'bun'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { readFixCommits } from '../../src/read/fix-commits.ts'
import { readFriction } from '../../src/read/friction.ts'
import { readKpis } from '../../src/read/kpis.ts'

/**
 * What the Improve page rests on: a KPI with no figure says why instead of reading zero, fix commits are the number
 * `/v1/fix-commits` returns, the queue wait is split by what held it, and a friction count carries the window before.
 */
let db: TestCluster
let sql: SQL
const NOW = new Date('2026-11-07T12:00:00Z')
const ago = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000)
const DAY = 24

const issue = (id: string) =>
  sql`INSERT INTO factory.issues (id, repo, state, version) VALUES (${id}, 'app', 'queued', 1)`

const interval = (id: string, kind: string, from: number, to: number) =>
  sql`INSERT INTO factory.queue_intervals (issue_id, project, kind, message, from_at, to_at)
    VALUES (${id}, 'app', ${kind}, ${kind}, ${ago(from)}, ${ago(to)})`

const refused = (id: string, n: number, at: Date) =>
  sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, detail)
    VALUES (${`event_refused_${n}`}, ${id}, ${`refused_${n}`}, 'shipped', '{}'::jsonb, 'lead', ${at}, 'refused', 'no acceptance')`

beforeAll(async () => {
  db = await startTestCluster()
  sql = db.sql
  await migrate(sql, await loadMigrations())
  for (const id of ['issue_1', 'issue_2', 'issue_3']) await issue(id)

  // fix commits: three in the last seven days, two in the week before
  const fixes = [1, 2, 5].map((d) => d * DAY - 10).concat([8 * DAY, 10 * DAY])
  let n = 0
  for (const hours of fixes)
    await sql`INSERT INTO factory.fix_commits (repo, sha, committed_at, subject, scope, class, by, reason)
      VALUES ('app', ${`sha${++n}`}, ${ago(hours)}, 'fix: x', NULL, 'tooling', 'rule', 'r')`

  // the queue: 6 h behind an after edge, 2 h on capacity, 1 h behind a stopped line, all inside the window
  await interval('issue_1', 'chain', 30, 24)
  await interval('issue_2', 'cap', 20, 18)
  await interval('issue_3', 'line', 10, 9)

  // friction: two refusals in the last week, five in the week before
  await refused('issue_1', 1, ago(24))
  await refused('issue_1', 2, ago(48))
  for (const k of [3, 4, 5, 6, 7]) await refused('issue_1', k, ago(8 * DAY + k))
})

afterAll(async () => {
  await db.stop()
})

test('fix commits are the number the fix-commits read returns, and not measured until one is stored', async () => {
  const model = KpiModel.parse(await readKpis(sql, { now: NOW, days: 7 }))
  const fixes = model.kpis.find((k) => k.key === 'fix_commits')
  const read = await readFixCommits(sql, { now: NOW })
  expect(read.weeks[0]?.total).toBe(3)
  expect(fixes).toMatchObject({ measured: true, value: 3, n: 3, count: 3, unit: 'count', reason: null })
  // the week before is the history's second to last reading, and the week the read calls second
  expect(fixes?.history.at(-2)).toEqual({ value: read.weeks[1]?.total ?? null, n: read.weeks[1]?.total ?? 0 })
  const thirty = KpiModel.parse(await readKpis(sql, { now: NOW, days: 28 }))
  expect(thirty.kpis.find((k) => k.key === 'fix_commits')?.value).toBe(5 / 4)
})

test('a week with no fix commit is a measured zero, as the fix-commits read says', async () => {
  const later = new Date(NOW.getTime() + 30 * DAY * 3_600_000)
  const model = KpiModel.parse(await readKpis(sql, { now: later, days: 7 }))
  expect((await readFixCommits(sql, { now: later })).weeks[0]?.total).toBe(0)
  expect(model.kpis.find((k) => k.key === 'fix_commits')).toMatchObject({
    measured: true,
    value: 0,
    n: 0,
    reason: null,
  })
})

test('the queue wait is split by what held it, the largest first, and nothing is made up', async () => {
  const model = KpiModel.parse(await readKpis(sql, { now: NOW, days: 7 }))
  const wait = model.kpis.find((k) => k.key === 'queue_wait_p50')
  const H = 3_600_000
  expect(wait?.parts.map((p) => [p.key, Math.round(p.value / H)])).toEqual([
    ['chain', 6],
    ['capacity', 2],
    ['production_red', 1],
  ])
  // no admission happened, so the median itself has no figure, with its reason
  expect(wait).toMatchObject({ value: null, measured: false })
  expect(wait?.reason).toBe('Nothing was counted in the window')
})

test('a ratio over nothing and a share under the floor read as not measured, never zero', async () => {
  const model = KpiModel.parse(await readKpis(sql, { now: NOW, days: 7 }))
  for (const key of ['worth_asking', 'specs_not_needed', 'first_verification_passes', 'cycle_p50']) {
    const kpi = model.kpis.find((k) => k.key === key)
    expect(kpi, key).toMatchObject({ value: null, measured: false })
    expect(kpi?.reason, key).toContain('counted')
  }
  for (const kpi of model.kpis) if (kpi.value === null) expect(kpi.measured, kpi.key).toBe(false)
})

test('a friction count carries the same count over the window before, and none where that window is not comparable', async () => {
  const friction = FrictionModel.parse(await readFriction(sql, { now: NOW, days: 7, compare: true }))
  const row = friction.counts.find((c) => c.key === 'refusal:total')
  expect(row).toMatchObject({ count: 2, previous: 5 })
  expect(friction.counts.every((c) => c.previous !== null)).toBe(true)

  // an import ends the old core's history: a window that reaches back before it is shorter than the one it would be read against
  await sql`INSERT INTO factory.import_issues (issue_id, legacy_id, imported_at, last_event, carried_version)
    VALUES ('issue_2', 2, ${ago(3 * DAY)}, 0, 1)`
  const cut = FrictionModel.parse(await readFriction(sql, { now: NOW, days: 7, compare: true }))
  expect(cut.since).not.toBeNull()
  expect(cut.counts.every((c) => c.previous === null)).toBe(true)
})
