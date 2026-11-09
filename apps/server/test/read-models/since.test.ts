import { afterAll, beforeAll, expect, test } from 'bun:test'
import { NeedsModel, SinceModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { postgresUnitOfWork } from '../../src/adapters/postgres/unit-of-work.ts'
import { postgresVisitStore } from '../../src/adapters/postgres/visit-store.ts'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { createApp } from '../../src/api/app.ts'

/** `GET /v1/since`: every count equals the stored facts, and the visit marker moves by the 24 h / 30 min rule, for the owner only. */
const TOKENS = {
  owner: 'owner-token-0123456789',
  agent: 'agent-token-0123456789',
  machine: 'door-token-0123456789',
  read: 'read-token-0123456789',
}
const T0 = new Date('2026-11-09T12:00:00Z')
const min = (n: number) => new Date(T0.getTime() + n * 60_000)
const ago = (hours: number) => new Date(T0.getTime() - hours * 3_600_000)

let db: TestCluster
let app: ReturnType<typeof createApp>
let clock = T0
let keys = 0

const get = async (path: string, token: string) => {
  const response = await app.handle(
    new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${token}` } }),
  )
  expect(response.status).toBe(200)
  return response.json()
}
const since = async (token = TOKENS.owner) => SinceModel.parse(await get('/v1/since', token))

async function issue(id: string, repo: string, title: string, origin: string, filedAt: Date) {
  await db.sql`INSERT INTO factory.issues (id, repo, state, version) VALUES (${id}, ${repo}, 'queued', 1)`
  await event(id, 1, 'filed', filedAt, { payload: { repo, title, kind: 'feature', origin }, to: 'settling' })
}

async function event(
  issueId: string,
  version: number,
  kind: string,
  at: Date,
  o: { payload?: unknown; outcome?: string; to?: string } = {},
) {
  await db.sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, to_state, outcome)
    VALUES (${`event_${++keys}`}, ${issueId}, ${`key_${keys}`}, ${kind}, ${JSON.stringify(o.payload ?? {})}::text::jsonb, 'factory', ${at},
      'applied', ${version}, ${o.to ?? 'queued'}, ${o.outcome ?? null})`
}

beforeAll(async () => {
  db = await startTestCluster()
  await migrate(db.sql, await loadMigrations())
  const visits = postgresUnitOfWork(db.sql, (tx) => ({ visits: postgresVisitStore(tx) }))
  app = createApp({
    tokens: TOKENS,
    health: { read: () => Promise.reject(new Error('unused')) },
    log: () => {},
    readModels: { sql: db.sql, visits, now: () => clock },
  })
  await db.sql`INSERT INTO factory.planning_projects (name, repo, source, project, plan)
    VALUES ('open-app', '/src/open-app', 'file', '{}'::jsonb, '{"version":1,"rows":[]}'::jsonb)`

  // before the window: not counted
  await issue('issue_1', 'open-app', 'Old news', 'you', ago(48))
  await event('issue_1', 2, 'watch_passed', ago(30), { payload: { watch: 1 } })
  // inside the window (T0 - 24 h)
  await issue('issue_2', 'open-app', 'Ship the thing', 'github', ago(10))
  await event('issue_2', 2, 'watch_passed', ago(5), { payload: { watch: 1 } })
  await issue('issue_3', 'work-app', 'SECRET payroll export', 'application', ago(9))
  await event('issue_3', 2, 'watch_passed', ago(4), { payload: { watch: 1 } })
  await event('issue_3', 3, 'regressed', ago(3), { payload: { watch: 1, detail: 'broke' } })
  await event('issue_3', 4, 'regressed', ago(2), { payload: { watch: 1, detail: 'broke again' } })
  await issue('issue_4', 'open-app', 'Drop me', 'you', ago(8))
  await event('issue_4', 2, 'closed', ago(6), {
    payload: { attempt: null, outcome: 'dropped', reason: 'x' },
    outcome: 'dropped',
    to: 'closed',
  })
  await issue('issue_5', 'open-app', 'Done one', 'feedback', ago(7))
  await event('issue_5', 2, 'closed', ago(6), {
    payload: { attempt: null, outcome: 'done', reason: 'x' },
    outcome: 'done',
    to: 'closed',
  })
  // more shipped Issues than the cap
  for (let n = 10; n < 20; n++) {
    await issue(`issue_${n}`, 'open-app', `Batch ${n}`, 'infrastructure', ago(20))
    await event(`issue_${n}`, 2, 'watch_passed', ago(20 - (n - 9) / 2), { payload: { watch: 1 } })
  }
  await db.sql`INSERT INTO factory.intake_incidents (issue_id, group_key, opened_at, last_alert_at) VALUES ('issue_2', 'host', ${ago(2)}, ${ago(1)})`
  // Decisions: two by the judge on one Issue (once), one by the owner
  const decision = (id: string, issueId: string, by: string, answeredAt: Date) =>
    db.sql`INSERT INTO factory.decisions (id, key, issue_id, repo, attempt, question, recommendation, checked, options, no_answer, asked_at, answer, settled_by, answered_at)
      VALUES (${id}, ${id}, ${issueId}, 'open-app', 1, ${`Question of ${id.slice(-1)}`}, 'r', 'c', '[]'::jsonb, '{}'::jsonb, ${ago(30)}, 'yes', ${by}, ${answeredAt})`
  await decision('decision_a', 'issue_2', 'judge', ago(5))
  await decision('decision_b', 'issue_2', 'judge', ago(4))
  await decision('decision_c', 'issue_4', 'owner', ago(4))
  await decision('decision_d', 'issue_1', 'judge', ago(40))
  // screen: a judge-dismissed signal (no Issue), an owner-dismissed one, a turned-away Errand
  const signal = (id: string, by: string, at: Date, state = 'dismissed') =>
    db.sql`INSERT INTO factory.intake_signals (id, source, kind, origin, trust, repo, fingerprint, title, text, received_at, state, dismissed_reason, dismissed_by, dismissed_at)
      VALUES (${id}, 'kuma', 'alert', 'infrastructure', 'machine', 'open-app', ${id}, ${'Judged signal'}, 't', ${ago(30)}, ${state}, 'noise', ${by}, ${at})`
  await signal('signal_a', 'judge', ago(3))
  await signal('signal_b', 'owner', ago(3))
  await db.sql`INSERT INTO factory.errands (id, key, issue_id, attempt, summary, raised_at, turned_away_at)
    VALUES ('errand_a', 'ea', 'issue_2', 1, 'Screened errand', ${ago(5)}, ${ago(2)})`
  // a held signal for the needs additions
  await db.sql`INSERT INTO factory.intake_signals (id, source, kind, origin, trust, repo, fingerprint, title, text, link, received_at, state)
    VALUES ('signal_h', 'hyperdx', 'alert', 'application', 'machine', 'open-app', 'h', 'Held', 't', 'https://example.com/a', ${ago(1)}, 'held'),
      ('signal_w', 'hyperdx', 'alert', 'application', 'machine', 'work-app', 'w', 'Held work', 't', 'https://example.com/w', ${ago(1)}, 'held')`
})
afterAll(() => db.stop())

test('counts equal the stored facts, items are newest first and capped at 8', async () => {
  clock = T0
  const band = await since()
  expect(band.since).toBe(ago(24).toISOString())
  const c = band.categories
  const [{ n: shipped }] =
    await db.sql`SELECT count(DISTINCT issue_id)::int AS n FROM factory.issue_events WHERE kind = 'watch_passed' AND result = 'applied' AND at > ${ago(24)}`
  const [{ n: failed }] =
    await db.sql`SELECT count(DISTINCT issue_id)::int AS n FROM factory.issue_events WHERE kind = 'regressed' AND result = 'applied' AND at > ${ago(24)}`
  const [{ n: dropped }] =
    await db.sql`SELECT count(DISTINCT issue_id)::int AS n FROM factory.issue_events WHERE kind = 'closed' AND outcome = 'dropped' AND result = 'applied' AND at > ${ago(24)}`
  const [{ n: judge }] =
    await db.sql`SELECT count(DISTINCT issue_id)::int AS n FROM factory.decisions WHERE settled_by = 'judge' AND answered_at > ${ago(24)}`
  const [{ n: signals }] =
    await db.sql`SELECT count(*)::int AS n FROM factory.intake_signals WHERE dismissed_by = 'judge' AND dismissed_at > ${ago(24)}`
  const [{ n: errands }] =
    await db.sql`SELECT count(*)::int AS n FROM factory.errands WHERE turned_away_at > ${ago(24)}`
  const [{ n: filed }] =
    await db.sql`SELECT count(DISTINCT issue_id)::int AS n FROM factory.issue_events WHERE kind = 'filed' AND result = 'applied' AND at > ${ago(24)}`
  const [{ n: incidents }] =
    await db.sql`SELECT count(*)::int AS n FROM factory.intake_incidents WHERE opened_at > ${ago(24)}`
  expect(c.shipped.count).toBe(shipped)
  expect(c.shipped.count).toBe(12)
  expect(c.shipped.items).toHaveLength(8)
  expect(c.shipped.items[0]).toMatchObject({ issue: 'issue_3', title: 'SECRET payroll export', repo: 'work-app' })
  const redacted = await since(TOKENS.read)
  expect(redacted.categories.shipped.items[0]?.title).toBe('Work in a private repository')
  expect(redacted.categories.shipped.items[1]?.title).toBe('Ship the thing')
  expect(redacted.categories.shipped.count).toBe(12)
  expect(c.shipped.items.map((i) => i.at)).toEqual([...c.shipped.items.map((i) => i.at)].sort().reverse())
  expect(c.failed.count).toBe(failed)
  expect(c.failed.count).toBe(1)
  expect(c.dropped).toMatchObject({ count: dropped, items: [{ issue: 'issue_4' }] })
  expect(c.dropped.count).toBe(1)
  expect(c.judge.count).toBe(judge)
  expect(c.judge).toMatchObject({ count: 1, items: [{ issue: 'issue_2', title: 'Question of b' }] })
  expect(c.screen.count).toBe(signals + errands)
  expect(c.screen.count).toBe(2)
  expect(c.screen.items.find((i) => i.issue === null)?.title).toBe('Judged signal')
  expect(c.filed.count).toBe(filed)
  expect(c.filed.byOrigin.reduce((sum, o) => sum + o.count, 0)).toBe(filed)
  expect(c.filed.byOrigin).toContainEqual({ origin: 'infrastructure', count: 10 })
  expect(c.incidents).toMatchObject({ count: incidents, items: [{ issue: 'issue_2', title: 'Ship the thing' }] })
})

test('the visit marker: 30 minutes keep the band, 31 start a new one, a non-owner never moves it', async () => {
  const [{ n }] = await db.sql`SELECT count(*)::int AS n FROM factory.console_visit`
  expect(n).toBe(1) // the first call of the previous test created it
  clock = min(20)
  expect((await since()).since).toBe(ago(24).toISOString())
  // seen_at is now T0+20; a read by others at T0+80 does not move it
  clock = min(80)
  for (const token of [TOKENS.agent, TOKENS.read]) expect((await since(token)).since).toBe(ago(24).toISOString())
  const [row] = await db.sql`SELECT seen_at FROM factory.console_visit`
  expect(row.seen_at.toISOString()).toBe(min(20).toISOString())
  // 31 minutes after the owner's last read (T0+20): a new visit begins at the old seen_at
  clock = min(51)
  expect((await since()).since).toBe(min(20).toISOString())
  clock = min(60)
  expect((await since()).since).toBe(min(20).toISOString())
  // and a reader without the marker sees that start without writing
  clock = min(200)
  expect((await since(TOKENS.agent)).since).toBe(min(20).toISOString())
  const [after] = await db.sql`SELECT seen_at, since_at FROM factory.console_visit`
  expect([after.seen_at.toISOString(), after.since_at.toISOString()]).toEqual([
    min(60).toISOString(),
    min(20).toISOString(),
  ])
})

test('the needs carry origin, source and link', async () => {
  clock = min(61)
  const needs = NeedsModel.parse(await get('/v1/needs', TOKENS.owner))
  expect(needs.items.find((i) => i.id === 'signal_h')).toMatchObject({
    origin: 'application',
    source: 'the application',
    sourceLink: 'https://example.com/a',
  })
  const hidden = NeedsModel.parse(await get('/v1/needs', TOKENS.read))
  expect(hidden.items.find((i) => i.id === 'signal_w')).toMatchObject({
    origin: 'application',
    redacted: true,
    sourceLink: null,
  })
  expect(hidden.items.find((i) => i.id === 'signal_h')?.sourceLink).toBe('https://example.com/a')
})
