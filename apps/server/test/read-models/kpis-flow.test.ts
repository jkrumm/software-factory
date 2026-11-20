import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  CAPACITY_FIGURE_KEYS,
  type FrictionModel,
  KPI_KEYS,
  KpiModel,
  RetroModel,
  type RetroCapacityFigure,
} from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import type { SQL } from 'bun'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { avoidableTouches, readKpis } from '../../src/read/kpis.ts'
import { regressionCause } from '../../src/read/kpis-flow.ts'
import { figureOf, FRICTION_MARKER_KEYS, movedOf, readRetro } from '../../src/read/retro.ts'

/**
 * The flow figures (the parts of the KPIs and the figures beside them) and the retro model over a real Postgres. One fixture, every expectation worked out by hand from it, and
 * each figure also read back with SQL written separately here (the figures "match SQL over the window").
 */
let db: TestCluster
let sql: SQL
const NOW = new Date('2026-11-07T12:00:00Z')
const ago = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000)
const H = 3_600_000
const json = (value: unknown): string => JSON.stringify(value)

let seq = 0
interface EventOptions {
  actor?: string
  to?: string
  from?: string | null
  wait?: unknown
  outcome?: string
  key?: string
  payload?: unknown
}

async function issue(id: string, state: string, version: number, outcome?: string) {
  await sql`INSERT INTO factory.issues (id, repo, state, outcome, version) VALUES (${id}, 'app', ${state}, ${outcome ?? null}, ${version})`
}

async function event(issueId: string, version: number, kind: string, at: Date, o: EventOptions = {}) {
  await sql`INSERT INTO factory.issue_events
    (id, issue_id, key, kind, payload, actor, at, result, version, from_state, to_state, wait, outcome)
    VALUES (${`event_${++seq}`}, ${issueId}, ${o.key ?? `key_${seq}`}, ${kind}, ${json(o.payload ?? {})}::text::jsonb,
      ${o.actor ?? 'factory'}, ${at}, 'applied', ${version}, ${o.from ?? null}, ${o.to ?? 'working'},
      ${o.wait === undefined ? null : json(o.wait)}::text::jsonb, ${o.outcome ?? null})`
}

beforeAll(async () => {
  db = await startTestCluster()
  sql = db.sql
  await migrate(sql, await loadMigrations())

  for (const [id, state, version, outcome] of [
    ['issue_10', 'closed', 2, 'done'],
    ['issue_1', 'closed', 7, 'done'],
    ['issue_2', 'closed', 6, 'dropped'],
    ['issue_3', 'closed', 5, 'cancelled'],
    ['issue_9', 'watching', 3, undefined],
    ['issue_40', 'working', 4, undefined],
  ] as const)
    await issue(id, state, version, outcome)

  // issue_1: queued 99 h to 90 h ago (an after edge held it from 100 h to 94 h ago), works 90 to 70 h ago with a steward
  // nudge at 85 h (answered by a lead's ask at 84.9 h) and a Decision wait from 84.9 to 82.9 h, then closes done.
  await event('issue_1', 1, 'filed', ago(100), { to: 'settling', payload: { repo: 'app', title: 't' } })
  await event('issue_1', 2, 'settled', ago(99), { to: 'queued' })
  await event('issue_1', 3, 'admitted', ago(90))
  await event('issue_1', 4, 'noted', ago(85), { actor: 'steward', key: 'noted:issue_1:steward:c1' })
  await event('issue_1', 5, 'asked', ago(84.9), {
    actor: 'lead',
    to: 'waiting',
    wait: { reason: 'decision', holds: { id: 'd', summary: 's' }, since: 5, told: 5 },
  })
  await event('issue_1', 6, 'answered', ago(82.9), { to: 'working' })
  await event('issue_1', 7, 'closed', ago(70), { actor: 'lead', to: 'closed', outcome: 'done' })
  await sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, from_state, to_state)
    VALUES ('event_edge10', 'issue_10', 'k0', 'filed', '{}'::jsonb, 'factory', ${ago(110)}, 'applied', 1, NULL, 'settling'),
      ('event_edge1', 'issue_10', 'k1', 'closed', '{}'::jsonb, 'factory', ${ago(94)}, 'applied', 2, 'working', 'closed')`
  await sql`INSERT INTO factory.planning_edges (issue_id, after_issue, created_at, satisfied_at)
    VALUES ('issue_1', 'issue_10', ${ago(100)}, ${ago(94)})`

  // issue_2: queued 69.9 to 65 h ago (no edge), works until 40 h ago with a nudge nothing followed, closes dropped.
  await event('issue_2', 1, 'filed', ago(70), { to: 'settling' })
  await event('issue_2', 2, 'settled', ago(69.9), { to: 'queued' })
  await event('issue_2', 3, 'admitted', ago(65))
  await event('issue_2', 4, 'noted', ago(60), { actor: 'steward', key: 'noted:issue_2:steward:c2' })
  await event('issue_2', 5, 'asked', ago(59), { actor: 'lead', to: 'working', key: 'late' }) // an hour later: not an answer
  await event('issue_2', 6, 'closed', ago(40), { actor: 'lead', to: 'closed', outcome: 'dropped' })

  // issue_3: queued 49.9 to 45 h ago, works 1 h, the owner cancels it.
  await event('issue_3', 1, 'filed', ago(50), { to: 'settling' })
  await event('issue_3', 2, 'settled', ago(49.9), { to: 'queued' })
  await event('issue_3', 3, 'admitted', ago(45))
  await event('issue_3', 4, 'noted', ago(44.5), { actor: 'owner', key: 'noted:issue_3:owner:c1' })
  await event('issue_3', 5, 'cancelled', ago(44), {
    actor: 'owner',
    to: 'closed',
    outcome: 'cancelled',
    key: 'cancelled:issue_3:c1',
  })

  // issue_9: shipped 200 h ago, before the window (7 days = 168 h)
  await event('issue_9', 1, 'filed', ago(210), { to: 'settling' })
  await event('issue_9', 2, 'admitted', ago(209))
  await event('issue_9', 3, 'shipped', ago(200), { to: 'watching' })

  // issue_40: a lead works, the steward nudges it, and the lead answers with `issue block` (a stalled event) ten minutes later
  await event('issue_40', 1, 'filed', ago(30), { to: 'settling' })
  await event('issue_40', 2, 'admitted', ago(30))
  await event('issue_40', 3, 'noted', ago(30), { actor: 'steward', key: 'noted:issue_40:steward:c3' })
  await event('issue_40', 4, 'stalled', new Date(ago(30).getTime() + 600_000), {
    actor: 'lead',
    to: 'waiting',
    wait: { reason: 'blocked', holds: null, since: 4, told: 4 },
  })

  // capacity: room at 93 h ago, none at 91 h ago
  await sql`INSERT INTO factory.capacity_readings (account, read_at, enabled, auth_ok, five_hour_used, weekly_used)
    VALUES ('me', ${new Date(ago(93).getTime() + 30 * 60_000)}, true, true, 10, 20),
      ('me', ${new Date(ago(91).getTime() + 10 * 60_000)}, true, true, 80, 20)`

  // signals: one filed, two amended
  await sql`INSERT INTO factory.intake_signals (id, source, kind, origin, trust, repo, fingerprint, title, text, received_at, state, issue_id)
    VALUES ('signal_a', 'agent:x', 'request', 'factory', 'agent', 'app', 'fa', 'a', 'a', ${ago(30)}, 'filed', 'issue_1'),
      ('signal_b', 'agent:x', 'request', 'factory', 'agent', 'app', 'fb', 'b', 'b', ${ago(29)}, 'amended', 'issue_1'),
      ('signal_c', 'agent:x', 'request', 'factory', 'agent', 'app', 'fc', 'c', 'c', ${ago(28)}, 'amended', 'issue_1')`

  // first watches: a pass in 60 s, a regression in 20 min whose last run failed the verify (the first run failed the CI),
  // and a regression in 10 min that is a deployed version lacking the landed commit
  await sql`INSERT INTO factory.quality_watches (key, issue_id, attempt, watch, started_at, window_ms, answer, answered_at) VALUES
    ('w1', 'issue_1', 1, 1, ${ago(80)}, 0, 'passed', ${new Date(ago(80).getTime() + 60_000)}),
    ('w2', 'issue_2', 1, 1, ${ago(38)}, 0, 'regressed', ${new Date(ago(38).getTime() + 20 * 60_000)}),
    ('w3', 'issue_3', 1, 1, ${ago(36)}, 0, 'regressed', ${new Date(ago(36).getTime() + 10 * 60_000)})`
  await sql`INSERT INTO factory.quality_checks (watch_key, n, at, outcome, checks) VALUES
    ('w2', 1, ${ago(38)}, 'red', ${json([{ name: 'ci', ok: false, detail: 'red' }])}::text::jsonb),
    ('w2', 2, ${ago(37.9)}, 'red', ${json([{ name: 'make verify', ok: false, detail: 'exit 2' }])}::text::jsonb),
    ('w3', 1, ${ago(36)}, 'red', ${json([
      { name: 'make verify', ok: true, detail: '' },
      { name: 'deployed version', ok: false, detail: 'deployed a does not hold b, where the work landed' },
    ])}::text::jsonb)`

  // forced notes delivered after 60 s, 120 s and 600 s; one not forced
  await sql`INSERT INTO factory.lead_deliveries (key, issue_id, attempt, kind, text, claimed_at, typed_at, forced) VALUES
    ('d1', 'issue_1', 1, 'note', 'n', ${ago(50)}, ${new Date(ago(50).getTime() + 60_000)}, true),
    ('d2', 'issue_1', 1, 'note', 'n', ${ago(49)}, ${new Date(ago(49).getTime() + 120_000)}, true),
    ('d3', 'issue_1', 1, 'note', 'n', ${ago(48)}, ${new Date(ago(48).getTime() + 600_000)}, true),
    ('d4', 'issue_1', 1, 'note', 'n', ${ago(47)}, ${new Date(ago(47).getTime() + 1_000)}, false)`

  // Errands: one turned away by a rule, one by the Judge, one that reached the owner
  await sql`INSERT INTO factory.errands (id, key, issue_id, attempt, summary, raised_at, turned_away_at, screen_by, reached_owner_at) VALUES
    ('errand_1', 'e1', 'issue_1', 1, 's', ${ago(20)}, ${ago(20)}, 'rule', NULL),
    ('errand_2', 'e2', 'issue_1', 1, 's', ${ago(19)}, ${ago(19)}, 'judge', NULL),
    ('errand_3', 'e3', 'issue_1', 1, 's', ${ago(18)}, NULL, NULL, ${ago(18)})`

  // a lead session of issue_1
  await sql`INSERT INTO factory.lead_hook_events (key, session, issue_id, attempt, kind, at, received_at, payload)
    VALUES ('h1', 's1', 'issue_1', 1, 'session_started', ${ago(90)}, ${ago(90)},
      ${json({ model: 'claude-sonnet-5-5', account: 'me', transcriptPath: '/x/t.jsonl' })}::text::jsonb)`
}, 60_000)
afterAll(() => db.stop())

const flow = async (days = 7) => {
  const model = KpiModel.parse(await readKpis(sql, { now: NOW, days }))
  const byKey = (key: string) => {
    const found = model.kpis.find((k) => k.key === key)
    if (!found) throw new Error(`no KPI ${key}`)
    return found
  }
  return byKey
}

const from = ago(7 * 24)
const num = async (rows: Promise<unknown[]>) => Number(((await rows)[0] as { v: unknown }).v)

describe('idle capacity and the lead’s time', () => {
  test('idle capacity counts the hours an unblocked Issue was queued and an account had room, beside the queue wait', async () => {
    const k = (await flow())('queue_wait_p90')
    // free hours: issue_1 94..91 h ago, issue_2 69..66, issue_3 49..46; only 93 h ago and 91 h ago have a reading, and only
    // the first shows room. An hour with no reading is not counted: the readings are kept a week. Two hours are under the
    // floor: the share is not a reading, so it is not beside the queue wait
    expect(k.beside.find((p) => p.key === 'idle_capacity')).toBeUndefined()
  })

  test('the cycle’s parts divide an Issue’s time into working and each wait reason, with the working share beside it', async () => {
    const k = (await flow())('cycle_p50')
    // working: issue_1 18 h, issue_2 25 h, issue_3 1 h; waiting for a decision 2 h; issue_9 watched 0 h ended before the window
    const working = k.parts.find((p) => p.key === 'working')?.value ?? 0
    expect(working).toBeCloseTo((44 + 1 / 6) * H, -3)
    expect(k.parts.find((p) => p.key === 'waiting:decision')?.value).toBeCloseTo(2 * H, -3)
    expect(k.beside.find((p) => p.key === 'working_share')?.value).toBeCloseTo((44 + 1 / 6) / (46 + 1 / 6), 6)
    const sqlWorking = await num(sql`
      WITH ev AS (SELECT to_state, at, lead(at) OVER (PARTITION BY issue_id ORDER BY version) AS nxt
        FROM factory.issue_events WHERE result = 'applied')
      SELECT sum(extract(epoch FROM nxt - at) * 1000) AS v FROM ev
      WHERE to_state = 'working' AND nxt >= ${from} AND nxt < ${NOW}`)
    expect(working).toBeCloseTo(sqlWorking, -3)
  })
})

describe('what leads and the loops cost', () => {
  test('dropped and cancelled after a lead started: only an Issue a lead was admitted to', async () => {
    const k = (await flow())('cycle_p50')
    // closed in the window after a lead was admitted: issue_1 done, issue_2 dropped, issue_3 cancelled (issue_10 had no lead)
    expect(k.beside.find((p) => p.key === 'dropped_after_lead')).toMatchObject({ value: 2 / 3, unit: 'share' })
  })

  test('Errands the screen turned away are beside the ones that reached the owner', async () => {
    const k = await flow()
    // three raised: one turned away by a rule, one by the Judge, one reached him
    expect(k('errands_reached_per_100')).toMatchObject({ count: 1 })
    expect(k('errands_reached_per_100').beside.find((p) => p.key === 'errands_turned_away')?.value).toBeCloseTo(
      2 / 3,
      6,
    )
  })

  test('first watches: the dwell, and each regression by the checks of its last run', async () => {
    const k = await flow()
    // the first-pass KPI is 1 of 3, its dwell is beside it, and its parts name why the other two regressed
    const passes = k('first_verification_passes')
    expect(passes.beside).toEqual([
      { key: 'first_watch_dwell_p50', label: 'First watch dwell, median', value: 600_000, unit: 'ms' },
    ])
    expect(passes).toMatchObject({ n: 3, count: 1 })
    expect(passes.parts.map((p) => [p.key, Math.round(p.value * 100)])).toEqual([
      ['verify', 33],
      ['not_deployed', 33],
    ])
  })

  test('the cause of a regression names the first failing check in the documented order', () => {
    expect(regressionCause(['deployed version|deployed a does not hold b', 'make verify|exit 2'])).toBe('verify')
    expect(regressionCause(['ci|red', 'make verify|x'])).toBe('ci')
    expect(regressionCause(['deployed version|no `make version` target: it is a probe'])).toBe('no_version_probe')
    expect(regressionCause(['checkout|dirty'])).toBe('checkout')
    expect(regressionCause(['probe http://x|500'])).toBe('other')
    expect(regressionCause([])).toBe('other')
  })
})

describe('owner touches', () => {
  test('a burst of one kind within a minute is one action; the orchestrator’s own actor never counts', async () => {
    const at = (offsetSeconds: number) => new Date(ago(30).getTime() + offsetSeconds * 1000)
    for (let i = 0; i < 5; i++) {
      const id = `issue_2${i}`
      await issue(id, 'closed', 2, 'cancelled')
      await event(id, 1, 'filed', ago(31), { to: 'settling' })
      await event(id, 2, 'cancelled', at(i * 5), {
        actor: 'owner',
        to: 'closed',
        outcome: 'cancelled',
        key: `cancelled:${id}:c`,
      })
    }
    await issue('issue_30', 'closed', 2, 'cancelled')
    await event('issue_30', 1, 'filed', ago(31), { to: 'settling' })
    await event('issue_30', 2, 'cancelled', ago(20), {
      actor: 'owner',
      to: 'closed',
      outcome: 'cancelled',
      key: 'cancelled:issue_30:c',
    })
    await issue('issue_31', 'closed', 2, 'cancelled')
    await event('issue_31', 1, 'filed', ago(31), { to: 'settling' })
    await event('issue_31', 2, 'cancelled', ago(25), {
      actor: 'orchestrator',
      to: 'closed',
      outcome: 'cancelled',
      key: 'cancelled:issue_31:c',
    })

    const touches = await avoidableTouches(sql, { from, to: NOW })
    // issue_3's cancel at 44 h, the burst of five at 30 h, the late one at 20 h
    expect(touches.cancelled).toBe(3)
    const raw = await num(sql`
      SELECT count(*) AS v FROM factory.issue_events WHERE kind = 'cancelled' AND actor = 'owner' AND at >= ${from} AND at < ${NOW}`)
    expect(raw).toBe(7)
  })
})

describe('the retro model', () => {
  test('moved: better, worse or flat in the direction the signal wanted', () => {
    expect(movedOf(10, 7, 'down')).toBe('better')
    expect(movedOf(10, 13, 'down')).toBe('worse')
    expect(movedOf(10, 10.4, 'down')).toBe('flat')
    expect(movedOf(0.5, 0.8, 'up')).toBe('better')
    expect(movedOf(0, 0, 'up')).toBe('flat')
  })

  test('the bundle holds the sessions, the samples and the ledger of the earlier retro signals', async () => {
    await sql`INSERT INTO factory.intake_signals (id, source, kind, origin, trust, repo, fingerprint, title, text, received_at, state, issue_id) VALUES
      ('signal_r1', 'agent:software-factory', 'request', 'factory', 'agent', 'app', 'r1', 'Shorter queue', ${'why Retro: 2026-10-30 kpi=dropped_after_lead before=0.2 direction=down'}, ${ago(300)}, 'filed', 'issue_9'),
      ('signal_r2', 'agent:software-factory', 'request', 'factory', 'agent', 'app', 'r2', 'Not shipped yet', ${'Retro: 2026-10-30 kpi=queue_capacity_share before=none direction=down'}, ${ago(300)}, 'filed', 'issue_2'),
      ('signal_r3', 'agent:software-factory', 'request', 'factory', 'agent', 'app', 'r3', 'Not a marker', 'Retro: soon', ${ago(300)}, 'filed', 'issue_2')`
    const model = RetroModel.parse(await readRetro(sql, { now: NOW, days: 7 }))
    expect(model.sessions).toEqual([
      { issue: 'issue_1', attempt: 1, model: 'claude-sonnet-5-5', account: 'me', transcriptPath: '/x/t.jsonl' },
    ])
    expect(model.kpis.kpis.map((k) => k.key)).toEqual([...KPI_KEYS])
    expect(model.samples.regressed.map((s) => s.issue).toSorted()).toEqual(['issue_2', 'issue_3'])
    expect(model.samples.slowest[0]).toMatchObject({ issue: 'issue_1', why: 'cycle' })
    expect(model.samples.dropped.map((s) => s.issue).toSorted()).toEqual(['issue_2', 'issue_3'])

    // issue_9 shipped 200 h ago, before the window: the whole window is after the ship; the dropped share went from 0.2 to 0.667
    const shipped = model.ledger.find((e) => e.signal === 'signal_r1')
    expect(shipped).toMatchObject({
      issue: 'issue_9',
      kpi: 'dropped_after_lead',
      before: 0.2,
      direction: 'down',
      measured: 'after',
      moved: 'worse',
    })
    expect(model.ledger.find((e) => e.signal === 'signal_r2')).toMatchObject({
      measured: 'not_shipped',
      moved: null,
      before: null,
    })
    expect(model.ledger.map((e) => e.signal)).toEqual(['signal_r1', 'signal_r2'])
  })

  test('a friction-count marker key reads its rate per closed Issue, so no shipped entry stays unreadable', async () => {
    await sql`INSERT INTO factory.intake_signals (id, source, kind, origin, trust, repo, fingerprint, title, text, received_at, state, issue_id) VALUES
      ('signal_f1', 'agent:software-factory', 'request', 'factory', 'agent', 'app', 'f1', 'Review every ship', ${'Retro: 2026-10-30 kpi=unreviewed_ship before=360 direction=down'}, ${ago(300)}, 'filed', 'issue_9'),
      ('signal_f2', 'agent:software-factory', 'request', 'factory', 'agent', 'app', 'f2', 'Fewer regressions', ${'Retro: 2026-10-30 kpi=regression_cause before=66 direction=down'}, ${ago(300)}, 'filed', 'issue_9')`
    const model = RetroModel.parse(await readRetro(sql, { now: NOW, days: 7 }))
    for (const id of ['signal_f1', 'signal_f2']) {
      const entry = model.ledger.find((e) => e.signal === id)
      expect(entry?.now).not.toBeNull()
      expect(entry?.measured).toBe('after')
    }
    const rate = (key: string) => model.friction.counts.find((c) => c.key === key)?.perIssue
    expect(model.ledger.find((e) => e.signal === 'signal_f1')?.now).toBe(rate('unreviewed_ship') ?? Number.NaN)
    expect(model.ledger.find((e) => e.signal === 'signal_f2')?.now).toBe(rate('regression') ?? Number.NaN)
  })

  test('every key a retro signal can carry resolves to a figure, or is listed as unreadable', () => {
    const kpi = (key: string) => ({ key, value: 1, parts: [], beside: [] })
    const kpis = { kpis: KPI_KEYS.map(kpi) } as unknown as KpiModel
    const capacity = CAPACITY_FIGURE_KEYS.map((key) => ({ key, value: 2 })) as unknown as RetroCapacityFigure[]
    const friction = {
      counts: Object.values(FRICTION_MARKER_KEYS).map((key) => ({ key, perIssue: 0.5 })),
    } as unknown as FrictionModel
    const unreadable: string[] = []
    const keys = [...KPI_KEYS, ...CAPACITY_FIGURE_KEYS, ...Object.keys(FRICTION_MARKER_KEYS)]
    for (const key of keys) if (figureOf(key, { kpis, capacity, friction }) === null) unreadable.push(key)
    expect(unreadable).toEqual([])
    expect(figureOf('no_such_key', { kpis, capacity, friction })).toBeNull()
  })

  test('a key that was a KPI of its own reads the figure that now stands beside a KPI', () => {
    const kpis = {
      kpis: [{ key: 'cycle_p50', value: 1, parts: [], beside: [{ key: 'dropped_after_lead', value: 0.25 }] }],
    } as unknown as KpiModel
    expect(figureOf('dropped_after_lead', { kpis })).toBe(0.25)
  })

  test('the read token gets no transcript path and no words of the Issues', async () => {
    const model = RetroModel.parse(await readRetro(sql, { now: NOW, days: 7, redact: true }))
    expect(model.sessions.map((s) => s.transcriptPath)).toEqual([null])
    for (const list of Object.values(model.samples)) for (const s of list) expect(s.why).toBe('')
    expect(model.ledger.every((e) => e.title === '')).toBe(true)
  })
})
