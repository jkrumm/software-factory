import { afterAll, beforeAll, expect, test } from 'bun:test'
import { LoopYieldModel, type RetroWasteSource } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { createApp } from '../../src/api/app.ts'
import { seedFinding } from '../seed-ledger.ts'
import { readLoopYield } from '../../src/read/loop-yield.ts'
import { readClosedSince, readRetroOutcomes } from '../../src/read/retro-outcomes.ts'
import { WAITS } from '../../src/domains/work/issue.ts'
import { OWNER_REASONS, readWaste, STALL_REASONS, wasteOf } from '../../src/read/retro-waste.ts'

/** What the loops yielded, the sources of waste and the retro's outcomes, over a real Postgres, restated in plain rows. */
let db: TestCluster
const NOW = new Date('2026-11-17T12:00:00Z')
const HOUR = 3_600_000
const ago = (hours: number): Date => new Date(NOW.getTime() - hours * HOUR)
const TOKENS = {
  owner: 'owner-token-0123456789',
  agent: 'agent-token-0123456789',
  machine: 'door-token-0123456789',
  read: 'read-token-0123456789',
}

let n = 0
/** An Issue filed `filedAgo` hours ago, closed `closedAfter` hours later (null: open) with an outcome. Returns its id. */
async function issue(filedAgo: number, closedAfter: number | null, outcome?: string): Promise<string> {
  const id = `issue_${++n}`
  await db.sql`INSERT INTO factory.issues (id, repo, state, outcome, version)
    VALUES (${id}, 'app', ${closedAfter === null ? 'queued' : 'closed'}, ${outcome ?? null}, ${closedAfter === null ? 1 : 2})`
  await db.sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, to_state)
    VALUES (${`ev_f_${n}`}, ${id}, ${`k_f_${n}`}, 'filed', '{}'::jsonb, 'factory', ${ago(filedAgo)}, 'applied', 1, 'settling')`
  if (closedAfter !== null)
    await db.sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, from_state, to_state)
      VALUES (${`ev_c_${n}`}, ${id}, ${`k_c_${n}`}, 'closed', '{}'::jsonb, 'factory', ${ago(filedAgo - closedAfter)}, 'applied', 2, 'working', 'closed')`
  return id
}

const finding = (
  id: string,
  loop: string,
  cls: string,
  over: { figure?: number; verdict?: string; filedAgo?: number } = {},
) =>
  db.sql`INSERT INTO factory.loop_findings (issue_id, loop, repo, class, key, figure, verdict, filed_at)
    VALUES (${id}, ${loop}, 'app', ${cls}, ${`${cls}:${id}`}, ${over.figure ?? null}, ${over.verdict ?? null}, ${ago(over.filedAgo ?? 0)})`

const signal = (id: string, issueId: string, text = 'words') =>
  db.sql`INSERT INTO factory.intake_signals (id, source, kind, origin, trust, repo, fingerprint, title, text, received_at, state, issue_id)
    VALUES (${id}, 'agent:app', 'request', 'factory', 'agent', 'app', ${`fp-${id}`}, 'T', ${text}, ${ago(2)}, 'filed', ${issueId})`

beforeAll(async () => {
  db = await startTestCluster()
  await migrate(db.sql, await loadMigrations())
  // friction: three Issues in the last week (done after 2 h, dropped after 4 h, open), one 10 days ago, done after 6 h
  await finding(await issue(24, 2, 'done'), 'friction', 'stall', { figure: 12, verdict: 'moved' })
  await finding(await issue(30, 4, 'dropped'), 'friction', 'stall')
  await finding(await issue(5, null), 'friction', 'touch')
  await finding(await issue(240, 6, 'done'), 'friction', 'refusal')
  await db.sql`INSERT INTO factory.friction_passes (id, at, window_from, window_to, issues, filed, over_budget, failed) VALUES
    ('fp1', ${ago(30)}, ${ago(198)}, ${ago(30)}, 10, '[{"key":"stall","count":2,"title":"t"},{"key":"touch","count":3,"title":"t"}]', '[]', '[]'),
    ('fp2', ${ago(5)}, ${ago(173)}, ${ago(5)}, 10, '[{"key":"touch","count":3,"title":"t"}]', '[]', '[]'),
    ('fp3', ${ago(300)}, ${ago(468)}, ${ago(300)}, 10, '[{"key":"x","count":3,"title":"t"}]', '[]', '[]')`
  // the store writes its arrays as a jsonb string: a pass recorded that way counts as well
  await db.sql`INSERT INTO factory.friction_passes (id, at, window_from, window_to, issues, filed, over_budget, failed)
    VALUES ('fp4', ${ago(2)}, ${ago(170)}, ${ago(2)}, 10, ${JSON.stringify([{ key: 'a', count: 3, title: 't' }])}::jsonb, '[]', '[]')`
  // hygiene: one healed Issue
  await finding(await issue(48, 1, 'healed'), 'hygiene', 'links')
  await db.sql`INSERT INTO factory.hygiene_passes (id, repo, at, ref, report, judgment, filed, over_budget, failed)
    VALUES ('hp1', 'app', ${ago(48)}, 'abc', '{}', '{}', '[{"key":"links:a","title":"t"}]', '[]', '[]')`
  // selfwatch: one Issue, done, its figure not moved
  await finding(await issue(10, 3, 'done'), 'selfwatch', 'migration_clash', {
    figure: 3,
    verdict: 'flat',
    filedAgo: 10,
  })
  // throughput: one finding whose Issue is open
  const th = await issue(20, null)
  await seedFinding(db.sql, {
    id: th,
    project: 'app',
    kpi: 'slot_minutes_per_issue',
    before: 10,
    target: 5,
    unit: 'min',
    costMinutes: 60,
    filedAt: ago(20),
    status: 'open',
  })
})
afterAll(() => db.stop())

const byLoop = (model: LoopYieldModel, loop: string) => model.loops.find((l) => l.loop === loop)?.windows

test('friction over 7 and 30 days: passes, signals, Issues by outcome, median time to close, top classes', async () => {
  const model = LoopYieldModel.parse(await readLoopYield(db.sql, { now: NOW }))
  const [week, month] = byLoop(model, 'friction') ?? []
  expect(week).toEqual({
    days: 7,
    passes: 3,
    signals: 4,
    issues: 3,
    done: 1,
    moved: 1,
    movedShare: 1,
    healed: 0,
    dropped: 1,
    cancelled: 0,
    open: 1,
    medianCloseSeconds: 3 * 3600,
    classes: [
      { class: 'stall', issues: 2, noise: 1 },
      { class: 'touch', issues: 1, noise: 0 },
    ],
  })
  expect(month).toMatchObject({
    days: 30,
    passes: 4,
    signals: 5,
    issues: 4,
    done: 2,
    moved: 1,
    movedShare: 0.5,
    open: 1,
    medianCloseSeconds: 4 * 3600,
  })
  expect(month?.classes.map((c) => c.class)).toEqual(['stall', 'refusal', 'touch'])
})

test('hygiene counts a healed Issue; selfwatch and throughput read the same ledger; the moved share counts done Issues only', async () => {
  const model = LoopYieldModel.parse(await readLoopYield(db.sql, { now: NOW }))
  expect(byLoop(model, 'hygiene')?.[0]).toMatchObject({ passes: 1, signals: 1, issues: 1, healed: 1, done: 0 })
  expect(byLoop(model, 'selfwatch')?.[0]).toMatchObject({
    passes: null,
    signals: 1,
    issues: 1,
    done: 1,
    moved: 0,
    movedShare: 0,
    classes: [{ class: 'migration_clash', issues: 1, noise: 0 }],
  })
  expect(byLoop(model, 'throughput')?.[0]).toMatchObject({
    passes: null,
    signals: 1,
    issues: 1,
    open: 1,
    movedShare: null,
    medianCloseSeconds: null,
    classes: [{ class: 'slot_minutes_per_issue', issues: 1, noise: 0 }],
  })
})

test('GET /v1/loop-yield answers the owner, the agent and the read token, and nobody without a token', async () => {
  const app = createApp({
    tokens: TOKENS,
    health: { read: () => Promise.reject(new Error('unused')) },
    log: () => {},
    readModels: { sql: db.sql, now: () => NOW },
  })
  const get = (token?: string) =>
    app.handle(
      new Request('http://localhost/v1/loop-yield', { headers: token ? { authorization: `Bearer ${token}` } : {} }),
    )
  expect((await get()).status).toBe(401)
  expect((await get(TOKENS.machine)).status).toBe(403)
  for (const token of [TOKENS.owner, TOKENS.agent, TOKENS.read]) {
    const response = await get(token)
    expect(response.status).toBe(200)
    expect(LoopYieldModel.parse(await response.json()).loops.map((l) => l.loop)).toEqual([
      'friction',
      'hygiene',
      'selfwatch',
      'throughput',
    ])
  }
})

test('the sources of waste in hours, largest first, each restated from its rows', async () => {
  const w = { from: ago(24), to: NOW }
  // queue: 4 h of `slots` and 2 h of `memory`, one still open for 1 h (clipped to the window end)
  const q = await issue(23, null)
  await db.sql`INSERT INTO factory.queue_intervals (issue_id, project, kind, message, from_at, to_at) VALUES
    (${q}, 'app', 'slots', 'm', ${ago(10)}, ${ago(6)}), (${q}, 'app', 'memory', 'm', ${ago(6)}, ${ago(4)}),
    (${q}, 'app', 'slots', 'm', ${ago(1)}, NULL)`
  // slot wait: one wait of 30 min on load, one of 90 min on slots
  await db.sql`INSERT INTO factory.slot_waits (at, name, outcome, wait_ms, split) VALUES
    (${ago(3)}, 'check', 'granted', 1800000, '{"load":1800000}'), (${ago(2)}, 'check', 'granted', 5400000, '{"slots":5400000}')`
  // stalls: the Issue waited 3 h for `blocked`, then 2 h for `decision` (the owner's), the last 1 h open for `wall`
  const s = await issue(23, null)
  const wait = (version: number, at: Date, reason: string) =>
    db.sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, from_state, to_state, wait)
      VALUES (${`ev_w_${s}_${version}`}, ${s}, ${`k_w_${s}_${version}`}, 'waited', '{}'::jsonb, 'factory', ${at}, 'applied', ${version}, 'working', 'waiting', jsonb_build_object('reason', ${reason}::text))`
  await wait(2, ago(20), 'blocked')
  await db.sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, from_state, to_state)
    VALUES ('ev_w_back1', ${s}, 'k_w_back1', 'woken', '{}'::jsonb, 'factory', ${ago(17)}, 'applied', 3, 'waiting', 'working')`
  await wait(4, ago(17), 'decision')
  await db.sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, from_state, to_state)
    VALUES ('ev_w_back2', ${s}, 'k_w_back2', 'woken', '{}'::jsonb, 'factory', ${ago(15)}, 'applied', 5, 'waiting', 'working')`
  await wait(6, ago(1), 'wall')
  // refused ship: 2 h until the lead's next call
  await db.sql`INSERT INTO factory.quality_ships (id, issue_id, attempt, event_key, at, result, detail, reported) VALUES
    ('sh1', ${s}, 1, 'e1', ${ago(12)}, 'refused', 'no review', '[]'), ('sh2', ${s}, 1, 'e2', ${ago(10)}, 'accepted', NULL, '[]')`

  const waste = await readWaste(db.sql, w)
  const of = (source: RetroWasteSource['source']) => waste.find((x) => x.source === source)
  expect(waste.map((x) => x.source)).toEqual(['queue', 'stalls', 'owner_waits', 'refused_ships', 'slot_wait'])
  expect(of('queue')).toEqual({ source: 'queue', hours: 7, events: 3, largest: 'slots (5 h)' })
  expect(of('slot_wait')).toEqual({ source: 'slot_wait', hours: 2, events: 2, largest: 'slots (1.5 h)' })
  expect(of('stalls')).toEqual({ source: 'stalls', hours: 4, events: 2, largest: 'blocked (3 h)' })
  expect(of('owner_waits')).toEqual({ source: 'owner_waits', hours: 2, events: 1, largest: 'decision (2 h)' })
  expect(of('refused_ships')).toEqual({ source: 'refused_ships', hours: 2, events: 1, largest: null })
})

test('wasteOf names the part with most hours and rounds to a tenth', () => {
  expect(
    wasteOf('queue', [
      { part: 'a', hours: 1.24, events: 1 },
      { part: 'b', hours: 2.26, events: 2 },
    ]),
  ).toEqual({ source: 'queue', hours: 3.5, events: 3, largest: 'b (2.3 h)' })
  expect(wasteOf('stalls', [])).toEqual({ source: 'stalls', hours: 0, events: 0, largest: null })
})

test('the retro’s outcomes count each signal once; Issues closed since a pass count applied closes only', async () => {
  const mark = 'Retro: 2026-11-16 kpi=cycle_p50 before=10 direction=down'
  const shipped = await issue(30, 5, 'done')
  await db.sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, to_state)
    VALUES ('ev_ship', ${shipped}, 'k_ship', 'shipped', '{}'::jsonb, 'factory', ${ago(26)}, 'applied', 3, 'watching')`
  await signal('signal_r1', shipped, mark)
  await signal('signal_r2', await issue(30, 5, 'done'), mark)
  await signal('signal_r3', await issue(30, 5, 'dropped'), mark)
  await signal('signal_r4', await issue(30, null), mark)
  // shipped and still being watched: one signal, counted as shipped only
  const watched = await issue(30, null)
  await db.sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, to_state)
    VALUES ('ev_ship2', ${watched}, 'k_ship2', 'shipped', '{}'::jsonb, 'factory', ${ago(26)}, 'applied', 3, 'watching')`
  await signal('signal_r6', watched, mark)
  // a throughput improvement ends in the same marker and is not a retro signal
  const improvement = await issue(30, null)
  await signal('signal_t1', improvement, mark)
  await seedFinding(db.sql, {
    id: improvement,
    project: 'app',
    kpi: 'queued_minutes',
    before: 10,
    target: 5,
    unit: 'min',
    costMinutes: 60,
    filedAt: ago(30),
    status: 'open',
    signalId: 'signal_t1',
  })
  await db.sql`INSERT INTO factory.intake_signals (id, source, kind, origin, trust, repo, fingerprint, title, text, received_at, state)
    VALUES ('signal_r5', 'agent:app', 'request', 'factory', 'agent', 'app', 'fp-r5', 'T', ${mark}, ${ago(2)}, 'held')`
  expect(await readRetroOutcomes(db.sql, { now: NOW, days: 7 })).toEqual({
    days: 7,
    signals: 6,
    shipped: 2,
    done: 1,
    dropped: 1,
    open: 1,
  })
  const closed =
    await db.sql`SELECT count(*) AS n FROM factory.issue_events WHERE to_state = 'closed' AND result = 'applied' AND at > ${ago(26)}`
  expect(await readClosedSince(db.sql, { since: ago(26), now: NOW })).toBe(Number(closed[0].n))
  expect(await readClosedSince(db.sql, { since: NOW, now: NOW })).toBe(0)
})

test('the stall and owner reasons the waste read uses are the work domain’s', () => {
  const entries = Object.entries(WAITS)
  expect(STALL_REASONS).toEqual(entries.filter(([, w]) => w.stall).map(([reason]) => reason))
  // a pause is the owner's choice, not waste: it is the one person wait the retro does not count
  expect(OWNER_REASONS).toEqual(
    entries.filter(([reason, w]) => w.exit === 'person' && reason !== 'paused').map(([reason]) => reason),
  )
})
