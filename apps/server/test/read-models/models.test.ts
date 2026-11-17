import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  ChainModel,
  FlowModel,
  FlowTrendSeries,
  FrictionModel,
  HISTORY_WINDOWS,
  KpiModel,
  NeedsModel,
  openOfWork,
  type WorkCounts,
} from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import type { SQL } from 'bun'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { readChain } from '../../src/read/chain.ts'
import { DIGEST_WINDOW_MS, countsOf } from '../../src/kernel/digest-scope.ts'
import { readFlow } from '../../src/read/flow.ts'
import { readFlowTrend } from '../../src/read/flow-trend.ts'
import { loopReads } from '../../src/read/loops.ts'
import { readFriction } from '../../src/read/friction.ts'
import { readFrictionEvidence } from '../../src/read/friction-evidence.ts'
import { pointsCache, readKpis } from '../../src/read/kpis.ts'
import { needsModel, readNeeds } from '../../src/read/needs.ts'

/** The read models over a real Postgres, seeded with SQL: the empty database, a fixture, the `usage` schema absent and present. */
let db: TestCluster
let sql: SQL
const NOW = new Date('2026-11-07T12:00:00Z')
const ago = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000)
const json = (value: unknown): string => JSON.stringify(value)

beforeAll(async () => {
  db = await startTestCluster()
  sql = db.sql
  await migrate(sql, await loadMigrations())
})
afterAll(() => db.stop())

let keys = 0
interface EventOptions {
  actor?: string
  result?: 'applied' | 'refused' | 'ignored'
  from?: string | null
  to?: string
  wait?: unknown
  detail?: string
  payload?: unknown
  outcome?: string
  key?: string
}

async function issue(id: string, repo: string, state: string, version: number, wait?: string, outcome?: string) {
  await sql`INSERT INTO factory.issues (id, repo, state, wait_reason, outcome, version)
    VALUES (${id}, ${repo}, ${state}, ${wait ?? null}, ${outcome ?? null}, ${version})`
}

async function event(issueId: string, version: number | null, kind: string, at: Date, o: EventOptions = {}) {
  const result = o.result ?? 'applied'
  await sql`INSERT INTO factory.issue_events
    (id, issue_id, key, kind, payload, actor, at, result, detail, version, from_state, to_state, wait, outcome)
    VALUES (${`event_${++keys}`}, ${issueId}, ${o.key ?? `key_${keys}`}, ${kind}, ${json(o.payload ?? {})}::text::jsonb,
      ${o.actor ?? 'factory'}, ${at}, ${result}, ${o.detail ?? null}, ${result === 'applied' ? version : null},
      ${o.from ?? null}, ${result === 'applied' ? (o.to ?? 'queued') : null},
      ${o.wait === undefined ? null : json(o.wait)}::text::jsonb, ${o.outcome ?? null})`
}

const filed = (id: string, repo: string, title: string, at: Date, origin = 'you') =>
  event(id, 1, 'filed', at, { payload: { repo, title, kind: 'feature', origin }, to: 'settling' })

describe('the empty database', () => {
  test('every model answers with zero counts, never an error', async () => {
    const needs = NeedsModel.parse(needsModel(await readNeeds(sql, NOW), { redact: false }))
    expect(needs.items).toEqual([])
    expect(needs.counts).toEqual({ decision: 0, review: 0, errand: 0, held_signal: 0, long_wait: 0 })

    const flow = FlowModel.parse(await readFlow(sql, { now: NOW }))
    expect(Object.values(flow.states).map((c) => c.count)).toEqual([0, 0, 0, 0, 0])
    expect(flow.closedRecently).toEqual([])
    expect(flow.trend.at).toHaveLength(8)
    expect(Object.values(flow.trend.states).flat()).toEqual(Array(40).fill(0))
    expect(flow.trend.shipped).toEqual(Array(7).fill(0))
    expect(flow.trend.shippedBefore).toBe(0)
    expect(flow.trend.shippedHourly).toEqual(Array(168).fill(0))
    expect(flow.trend.shippedDaily30).toEqual(Array(30).fill(0))
    expect(flow.perProject).toEqual([])
    expect(flow.queueStates).toEqual({ global: 'run', projects: {} })

    const chain = ChainModel.parse(await readChain(sql, NOW))
    expect(chain).toMatchObject({ nodes: [], edges: [], blocking: {} })

    const kpis = KpiModel.parse(await readKpis(sql, { now: NOW, days: 7 }))
    expect(kpis.kpis.map((k) => k.key)).toHaveLength(26)
    // a count per day is a real zero when nothing closed; every other figure has nothing to divide and is null
    for (const kpi of kpis.kpis) expect(kpi.value).toBe(kpi.key === 'closed_per_day' ? 0 : null)
    expect(kpis.kpis.find((k) => k.key === 'cost')).toMatchObject({ measured: false, n: 0 })

    const friction = FrictionModel.parse(await readFriction(sql, { now: NOW, days: 7 }))
    expect(friction.issues).toBe(0)
    expect(friction.counts.length).toBeGreaterThan(10)
    for (const count of friction.counts) expect(count).toMatchObject({ count: 0, perIssue: null })
  })
})

async function seed() {
  await sql`INSERT INTO factory.planning_projects (name, repo, source, project, plan) VALUES
    ('app', '/src/app', 'file', '{}'::jsonb, ${json({
      version: 1,
      rows: [
        { key: 'docs', title: 'Docs sweep', facts: {}, kind: 'docs', after: ['other'] },
        { key: 'other', title: 'Other', facts: {}, not_before: '2020-01-02T03:04:05' },
        { key: 'filed-one', title: 'Filed one', facts: {} },
        { key: 'ship', title: 'Ship it', facts: {}, after: ['filed-one'], after_days: 3 },
      ],
    })}::text::jsonb),
    ('work-app', '/src/work-app', 'defaults', '{}'::jsonb, NULL)`

  // issue_1: filed, settled, admitted, closed done; cycle 24 h, queue wait 2 h
  await issue('issue_1', 'app', 'closed', 4, undefined, 'done')
  await filed('issue_1', 'app', 'First change', ago(72))
  await event('issue_1', 2, 'settled', ago(71.9), { from: 'settling', to: 'queued' })
  await event('issue_1', 3, 'admitted', ago(70), { from: 'queued', to: 'working' })
  await event('issue_1', 4, 'closed', ago(48), { from: 'working', to: 'closed', outcome: 'done', actor: 'lead' })

  // issue_2: waits on Decision decision_1; the owner noted it; a refused close
  await issue('issue_2', 'app', 'waiting', 5, 'decision')
  await filed('issue_2', 'app', 'Pick the logging library for issue_2', ago(60))
  await event('issue_2', 2, 'settled', ago(59.9), { from: 'settling', to: 'queued' })
  await event('issue_2', 3, 'admitted', ago(58), { from: 'queued', to: 'working' })
  await event('issue_2', 4, 'asked', ago(30), {
    from: 'working',
    to: 'waiting',
    actor: 'lead',
    wait: { reason: 'decision', holds: { id: 'decision_1', summary: 'which logger' }, since: 4, told: 4 },
  })
  await event('issue_2', 5, 'noted', ago(10), {
    from: 'waiting',
    to: 'waiting',
    actor: 'owner',
    key: 'noted:issue_2:owner:call_1',
  })
  await event('issue_2', null, 'closed', ago(5), { result: 'refused', detail: 'not working', actor: 'lead' })

  // issue_3 (work repo): a Concept under review
  await issue('issue_3', 'work-app', 'waiting', 4, 'review')
  await filed('issue_3', 'work-app', 'Caching for the work app', ago(20))
  await event('issue_3', 2, 'settled', ago(19.9), { from: 'settling', to: 'queued' })
  await event('issue_3', 3, 'admitted', ago(19), { from: 'queued', to: 'working' })
  await event('issue_3', 4, 'submitted', ago(3), {
    from: 'working',
    to: 'waiting',
    actor: 'lead',
    wait: { reason: 'review', holds: { id: 'artifact_1', summary: 'A concept for caching' }, since: 4, told: 4 },
  })

  // issue_4 (work repo): an Errand
  await issue('issue_4', 'work-app', 'waiting', 4, 'errand')
  await filed('issue_4', 'work-app', 'Rotate the key', ago(6))
  await event('issue_4', 2, 'settled', ago(5.9), { from: 'settling', to: 'queued' })
  await event('issue_4', 3, 'admitted', ago(5), { from: 'queued', to: 'working' })
  await event('issue_4', 4, 'errand_raised', ago(2), {
    from: 'working',
    to: 'waiting',
    actor: 'lead',
    wait: { reason: 'errand', holds: { id: 'errand_1', summary: 'Rotate the key' }, since: 4, told: 4 },
  })

  // issue_5: queued behind issue_2
  await issue('issue_5', 'app', 'queued', 2)
  await filed('issue_5', 'app', 'Second change', ago(4), 'feedback')
  await event('issue_5', 2, 'settled', ago(3.9), { from: 'settling', to: 'queued', payload: { kind: 'bug' } })
  await sql`INSERT INTO factory.planning_edges (issue_id, after_issue, created_at) VALUES ('issue_5', 'issue_2', ${ago(3.9)})`

  // issue_6: working; its lead was lost once and admitted again
  await issue('issue_6', 'app', 'working', 5)
  await filed('issue_6', 'app', 'Third change', ago(2))
  await event('issue_6', 2, 'settled', ago(1.95), { from: 'settling', to: 'queued' })
  await event('issue_6', 3, 'admitted', ago(1.5), { from: 'queued', to: 'working' })
  await event('issue_6', 4, 'lead_gone', ago(1.2), { from: 'working', to: 'queued' })
  await event('issue_6', 5, 'admitted', ago(1), { from: 'queued', to: 'working' })

  // issue_7: stalled on the account's window, with a note nobody typed
  await issue('issue_7', 'app', 'waiting', 5, 'wall')
  await filed('issue_7', 'app', 'Fourth change', ago(8))
  await event('issue_7', 2, 'settled', ago(7.9), { from: 'settling', to: 'queued' })
  await event('issue_7', 3, 'admitted', ago(7), { from: 'queued', to: 'working' })
  await event('issue_7', 4, 'stalled', ago(1), {
    from: 'working',
    to: 'waiting',
    wait: { reason: 'wall', detail: 'full', since: 4, told: 3 },
  })
  // a note while it already waits keeps the wait's reason: it is no second stall
  await event('issue_7', 5, 'noted', ago(0.9), {
    from: 'waiting',
    to: 'waiting',
    wait: { reason: 'wall', detail: 'full', since: 4, told: 3 },
  })
  await sql`INSERT INTO factory.lead_deliveries (key, issue_id, attempt, kind, text, claimed_at)
    VALUES ('note_1', 'issue_7', 1, 'note', 'wake up', ${ago(2)})`

  // issue_8 (work repo): settling
  await issue('issue_8', 'work-app', 'settling', 1)
  await filed('issue_8', 'work-app', 'Fifth change', ago(0.5))

  // issue_9: cancelled by the owner 5 hours ago
  await issue('issue_9', 'app', 'closed', 2, undefined, 'cancelled')
  await filed('issue_9', 'app', 'Sixth change', ago(12), 'infrastructure')
  await event('issue_9', 2, 'cancelled', ago(5), {
    from: 'settling',
    to: 'closed',
    outcome: 'cancelled',
    actor: 'owner',
  })

  // the checkpoints
  const decision = async (
    id: string,
    issueId: string,
    asked: Date,
    settled?: { by: string; at: Date; worth?: boolean },
  ) => {
    await sql`INSERT INTO factory.decisions
      (id, key, issue_id, repo, attempt, question, recommendation, checked, options, no_answer, asked_at, answer, settled_by, answered_at, worth_asking)
      VALUES (${id}, ${`key_${id}`}, ${issueId}, 'app', 1, ${`Which logger for ${issueId}?`}, 'Use pino', 'checked', '[]'::jsonb,
        ${json({ consequence: 'x', default: settled ? null : 'pino', waitMinutes: settled ? null : 2880 })}::text::jsonb, ${asked},
        ${settled ? 'pino' : null}, ${settled?.by ?? null}, ${settled?.at ?? null}, ${settled?.worth ?? null})`
  }
  await decision('decision_1', 'issue_2', ago(30))
  await sql`INSERT INTO factory.decision_steps (decision_id, step, outcome, at) VALUES ('decision_1', 'owner', 'open', ${ago(30)})`
  await decision('decision_2', 'issue_1', ago(40), { by: 'owner', at: ago(24), worth: false })
  await decision('decision_3', 'issue_1', ago(41), { by: 'owner', at: ago(20), worth: true })
  await decision('decision_4', 'issue_1', ago(31), { by: 'judge', at: ago(30) })
  await sql`INSERT INTO factory.artifacts (id, key, issue_id, kind, title, format, author, created_at)
    VALUES ('artifact_1', 'key_artifact_1', 'issue_3', 'concept', 'Concept for issue_3 caching', 'markdown', 'lead', ${ago(3)})`
  await sql`INSERT INTO factory.errands (id, key, issue_id, attempt, summary, detail, raised_at, reached_owner_at)
    VALUES ('errand_1', 'key_errand_1', 'issue_4', 1, 'Rotate the key', 'In the portal', ${ago(2)}, ${ago(2)})`
  await sql`INSERT INTO factory.intake_signals (id, source, kind, origin, trust, repo, fingerprint, title, text, received_at, state) VALUES
    ('signal_1', 'feedback', 'feedback', 'feedback', 'outside', 'work-app', 'f1', 'Odd report', 'secret words', ${ago(48)}, 'held'),
    ('signal_2', 'github', 'request', 'github', 'outside', 'app', 'f2', 'Public report', 'public words', ${ago(1)}, 'held')`

  // quality
  await sql`INSERT INTO factory.quality_ships (id, issue_id, attempt, event_key, at, result, detail, reported)
    VALUES ('ship_1', 'issue_1', 1, 'ship_key_1', ${ago(47)}, 'refused', 'a commit is older than the attempt', '[]'::jsonb)`
  await sql`INSERT INTO factory.quality_evidence (id, issue_id, attempt, source_key, kind, at, payload) VALUES
    ('ev_1', 'issue_1', 1, 'ship_key_1', 'review', ${ago(47)}, '{"status":"covered"}'::jsonb),
    ('ev_2', 'issue_2', 1, 'ship_key_2', 'review', ${ago(10)}, '{"status":"missing","reason":"none"}'::jsonb),
    ('ev_3', 'issue_1', 1, 'ship_key_1', 'acceptance', ${ago(47)}, '{"statements":[{"status":"met","text":"x"}]}'::jsonb),
    ('ev_4', 'issue_2', 1, 'ship_key_2', 'acceptance', ${ago(10)}, '{"statements":[]}'::jsonb)`
  await sql`INSERT INTO factory.quality_watches (key, issue_id, attempt, watch, started_at, window_ms, answer, answered_at) VALUES
    ('watch_1', 'issue_1', 1, 1, ${ago(48)}, 1000, 'passed', ${ago(47)}),
    ('watch_2', 'issue_2', 1, 1, ${ago(11)}, 1000, 'regressed', ${ago(10)})`

  await sql`INSERT INTO factory.planning_filed_rows (project, row_key, issue_id, filed_at) VALUES ('app', 'filed-one', 'issue_1', ${ago(72)})`
  await sql`INSERT INTO factory.capacity_queue_states (project, state, set_at) VALUES ('', 'drain', ${ago(1)}), ('app', 'pace', ${ago(1)})`
}

describe('the fixture', () => {
  beforeAll(seed)

  test('needs: what reached the owner, newest first within a kind, the default time, stale, plain words', async () => {
    const scoped = await readNeeds(sql, NOW)
    const owner = NeedsModel.parse(needsModel(scoped, { redact: false }))
    expect(owner.counts).toEqual({ decision: 1, review: 1, errand: 1, held_signal: 2, long_wait: 0 })
    expect(owner.items.map((i) => [i.kind, i.id])).toEqual([
      ['decision', 'decision_1'],
      ['review', 'artifact_1'],
      ['errand', 'errand_1'],
      ['held_signal', 'signal_2'],
      ['held_signal', 'signal_1'],
    ])
    const [decision, review] = owner.items
    expect(decision).toMatchObject({
      issue: 'issue_2',
      repo: 'app',
      stale: true,
      ageMs: 30 * 3_600_000,
      defaultAt: ago(30 - 48).toISOString(),
      link: { type: 'decision', id: 'decision_1' },
      artifact: null,
    })
    expect(decision?.title).toBe('Which logger for an Issue?')
    expect(review).toMatchObject({ issue: 'issue_3', stale: false, since: ago(3).toISOString(), defaultAt: null })
    expect(review?.title).toBe('Concept for an Issue caching')
    for (const item of owner.items) {
      expect(item.title).not.toMatch(/(issue|decision|errand|signal)_\w+/)
      expect(item.summary).not.toMatch(/(issue|decision|errand|signal)_\w+/)
    }
  })

  test('needs under the read token: work-repo words are replaced, the project’s own text stays', async () => {
    const read = NeedsModel.parse(needsModel(await readNeeds(sql, NOW), { redact: true }))
    expect(read.items.filter((i) => i.redacted).map((i) => i.id)).toEqual(['artifact_1', 'errand_1', 'signal_1'])
    expect(read.items.find((i) => i.id === 'errand_1')?.title).not.toContain('Rotate')
    expect(read.items.find((i) => i.id === 'decision_1')?.title).toContain('Which logger')
    expect(read.items.find((i) => i.id === 'signal_2')?.summary).toBe('public words')
  })

  test('flow: the Issues by state with since and reasons, closed in the last day, per project, queue states', async () => {
    const reason = { kind: 'chain' as const, message: 'waits for issue_2', opensAt: null }
    const flow = FlowModel.parse(await readFlow(sql, { now: NOW, queue: new Map([['issue_5', reason]]) }))
    expect(Object.entries(flow.states).map(([state, c]) => [state, c.count])).toEqual([
      ['settling', 1],
      ['queued', 1],
      ['working', 1],
      ['waiting', 4],
      ['watching', 0],
    ])
    expect(flow.states.queued.issues[0]).toMatchObject({
      id: 'issue_5',
      repo: 'app',
      title: 'Second change',
      origin: 'feedback',
      kind: 'bug',
      since: ago(3.9).toISOString(),
      queue: reason,
    })
    // longest in its state first
    expect(flow.states.waiting.issues.map((i) => [i.id, i.waitReason])).toEqual([
      ['issue_2', 'decision'],
      ['issue_3', 'review'],
      ['issue_4', 'errand'],
      ['issue_7', 'wall'],
    ])
    expect(flow.closedRecently.map((c) => [c.id, c.outcome])).toEqual([['issue_9', 'cancelled']])
    expect(flow.closedRecently[0]?.origin).toBe('infrastructure')
    // the settled kind wins over the filed one; without a settled kind the filed one stands
    expect(flow.closedRecently[0]?.kind).toBe('feature')
    expect(flow.states.working.issues[0]?.kind).toBe('feature')
    // kind is a shape: a work repo's Issue keeps it
    expect(flow.states.waiting.issues.find((i) => i.id === 'issue_4')?.kind).toBe('feature')
    // origin is a shape: a work repo's Issue keeps it
    expect(flow.states.waiting.issues.find((i) => i.id === 'issue_4')?.origin).toBe('you')
    // the five words add up to the open Issues, per project and in all
    expect(flow.perProject.map((p) => [p.repo, p.open, openOfWork(p.work)])).toEqual([
      ['app', 4, 4],
      ['work-app', 3, 3],
    ])
    expect(openOfWork(flow.work)).toBe(7)
    expect(flow.work).toMatchObject({ running: 1, paused: 4, held: 2 })
    expect(flow.queueStates).toEqual({ global: 'drain', projects: { app: 'pace' } })
  })

  test('chain: open Issues and unfiled rows, edges with closed, what blocks each queued node', async () => {
    const chain = ChainModel.parse(await readChain(sql, NOW))
    expect(chain.nodes.map((n) => [n.id, n.kind, n.state]).sort()).toEqual(
      [
        ['issue_1', 'issue', 'closed'],
        ['issue_2', 'issue', 'waiting'],
        ['issue_3', 'issue', 'waiting'],
        ['issue_4', 'issue', 'waiting'],
        ['issue_5', 'issue', 'queued'],
        ['issue_6', 'issue', 'working'],
        ['issue_7', 'issue', 'waiting'],
        ['issue_8', 'issue', 'settling'],
        ['row:app:docs', 'row', 'waiting'],
        ['row:app:other', 'row', 'filable'],
        ['row:app:ship', 'row', 'waiting'],
      ].sort(),
    )
    expect(chain.edges.map((e) => `${e.from}>${e.to}:${e.closed}`).sort()).toEqual([
      'issue_5>issue_2:false',
      'row:app:docs>row:app:other:false',
      'row:app:ship>issue_1:true',
    ])
    expect(chain.blocking).toEqual({ issue_5: ['issue_2'] })
    const byId = (id: string) => chain.nodes.find((n) => n.id === id)
    expect(byId('row:app:other')).toMatchObject({
      issueKind: 'feature',
      since: null,
      waitReason: null,
      notBefore: '2020-01-02T03:04:05.000Z',
    })
    expect(byId('row:app:docs')).toMatchObject({ issueKind: 'docs', notBefore: null })
    // issue_1 closed 48 h ago and the row waits 3 days after it
    expect(byId('row:app:ship')).toMatchObject({ notBefore: ago(-24).toISOString() })
    expect(byId('issue_2')).toMatchObject({ waitReason: 'decision', notBefore: null, since: expect.any(String) })
    expect(byId('issue_5')).toMatchObject({ issueKind: 'bug', since: ago(3.9).toISOString(), waitReason: null })
    expect(byId('issue_1')?.issueKind).toBe('feature')
  })

  test('chain: a row that needs its blocker shipped stays waiting behind a cancelled one, and a plain row is filable', async () => {
    const [{ plan }] = await sql`SELECT plan FROM factory.planning_projects WHERE name = 'app'`
    const original = typeof plan === 'string' ? JSON.parse(plan) : plan
    const withHeld = {
      ...original,
      rows: [
        ...original.rows,
        { key: 'gone', issue: 9 },
        { key: 'needs-gone', title: 'Needs it', facts: {}, after: ['gone'], after_needs: 'shipped' },
        { key: 'any-gone', title: 'Any close', facts: {}, after: ['gone'] },
      ],
    }
    await sql`UPDATE factory.planning_projects SET plan = ${json(withHeld)}::text::jsonb WHERE name = 'app'`
    try {
      const chain = ChainModel.parse(await readChain(sql, NOW))
      const state = (id: string) => chain.nodes.find((n) => n.id === id)?.state
      expect(state('row:app:needs-gone')).toBe('waiting')
      expect(state('row:app:any-gone')).toBe('filable')
    } finally {
      await sql`UPDATE factory.planning_projects SET plan = ${json(original)}::text::jsonb WHERE name = 'app'`
    }
  })

  test('kpis over 7 days: each definition’s count, with the usage schema absent', async () => {
    const model = KpiModel.parse(await readKpis(sql, { now: NOW, days: 7 }))
    const by = Object.fromEntries(model.kpis.map((k) => [k.key, k]))
    // nine Issues were filed in the window
    expect(by.avoidable_touches).toMatchObject({ n: 9, count: 3, value: 3 / 9, measured: true })
    expect(by.asks).toMatchObject({ n: 9, count: 3 })
    // two samples are under the floor of three: a share of two is a coin, so there is no figure, and it says why
    // (the owner's two answers were 'pino' to the recommendation 'Use pino': neither names it as an option label)
    expect(by.recommendation_taken).toMatchObject({ n: 2, count: 0, value: null, measured: false })
    expect(by.recommendation_taken?.reason).toBe('Only 2 counted in the window; at least 3 are needed for a figure')
    expect(by.first_verification_passes).toMatchObject({ n: 2, count: 1, value: null, measured: false })
    expect(by.refusals).toMatchObject({ n: 9, count: 2 })
    expect(by.cycle_p50).toMatchObject({ n: 2, value: null, measured: false })
    expect(by.queue_wait_p90).toMatchObject({ n: 7, value: 7_200_000 })
    expect(by.fix_commits).toMatchObject({ measured: false, value: null, n: 0 })
    expect(by.fix_commits?.reason).toContain('No fix commit is stored yet')
    expect(by.cost).toMatchObject({ measured: false, value: null })
    expect(by.cost?.reason).toBe('The usage schema is not in this database')
    expect(by.window_points).toMatchObject({ measured: false, value: null })
    // no KPI that has no figure is a zero, and every one without a figure says why
    for (const kpi of model.kpis) {
      if (kpi.measured) expect(kpi.reason).toBeNull()
      else expect(kpi.reason?.length ?? 0).toBeGreaterThan(10)
      if (kpi.value === null) expect(kpi.measured).toBe(false)
    }
    for (const kpi of model.kpis) expect(kpi.definition.length).toBeGreaterThan(20)

    // a window that starts after the fixture sees none of it
    const later = new Date(NOW.getTime() + 10 * 24 * 3_600_000)
    const narrow = KpiModel.parse(await readKpis(sql, { now: later, days: 1 }))
    expect(narrow.kpis.find((k) => k.key === 'recommendation_taken')).toMatchObject({ n: 0, value: null })
  })

  test('kpis: Errands that reached the owner per 100 Issues, and what they needed', async () => {
    // the fixture's one Errand reached him 2 hours ago with no need stored; three more with one, one before the window
    await sql`INSERT INTO factory.errands (id, key, issue_id, attempt, summary, raised_at, reached_owner_at, need) VALUES
      ('errand_k1', 'key_k1', 'issue_4', 1, 'a', ${ago(3)}, ${ago(3)}, 'secret'),
      ('errand_k2', 'key_k2', 'issue_4', 1, 'b', ${ago(4)}, ${ago(4)}, 'hands'),
      ('errand_k3', 'key_k3', 'issue_4', 1, 'c', ${ago(5)}, ${ago(5)}, 'place'),
      ('errand_k4', 'key_k4', 'issue_4', 1, 'd', ${ago(400)}, ${ago(400)}, 'secret')`
    try {
      const model = KpiModel.parse(await readKpis(sql, { now: NOW, days: 7 }))
      const kpi = model.kpis.find((k) => k.key === 'errands_reached_per_100')
      // four reached him in the window over nine Issues filed
      expect(kpi).toMatchObject({ n: 9, count: 4, measured: true, unit: 'per_100_issues' })
      expect(kpi?.value).toBeCloseTo((4 / 9) * 100, 6)
      const parts = Object.fromEntries((kpi?.parts ?? []).map((part) => [part.key, part.value]))
      expect(parts).toEqual({ secret_or_hands: 2 / 4, secret: 1 / 4, hands: 1 / 4, place: 1 / 4, approval: 0 })
    } finally {
      await sql`DELETE FROM factory.errands WHERE id LIKE 'errand_k%'`
    }
  })

  test('kpis: the history holds the windows before, each the same figures over its own window', async () => {
    // two Issues filed in the window before the current 7 days (hours 168 to 336 ago); cleaned up after
    await issue('issue_91', 'app', 'working', 3)
    await filed('issue_91', 'app', 'Earlier one', ago(200))
    await event('issue_91', 2, 'settled', ago(199.9), { from: 'settling', to: 'queued' })
    await event('issue_91', 3, 'admitted', ago(198), { from: 'queued', to: 'working' })
    await event('issue_91', 4, 'noted', ago(190), { actor: 'owner', key: 'noted:issue_91:owner:call_p' })
    await event('issue_91', null, 'closed', ago(180), { result: 'refused', detail: 'not working', actor: 'lead' })
    await issue('issue_92', 'app', 'working', 3)
    await filed('issue_92', 'app', 'Earlier two', ago(250))
    await event('issue_92', 2, 'settled', ago(249.9), { from: 'settling', to: 'queued' })
    await event('issue_92', 3, 'admitted', ago(247), { from: 'queued', to: 'working' })
    await issue('issue_93', 'app', 'working', 3)
    // one Issue 30 days back (the second window of six): the windows that skip usage must still report n 0 for cost and points
    await issue('issue_94', 'app', 'working', 1)
    await filed('issue_94', 'app', 'Long ago', ago(720))
    await sql`INSERT INTO factory.decisions
      (id, key, issue_id, repo, attempt, question, recommendation, checked, options, no_answer, asked_at, answer, settled_by, answered_at, worth_asking)
      VALUES ('decision_p', 'key_decision_p', 'issue_91', 'app', 1, 'Which?', 'Use pino', 'checked', '[]'::jsonb,
        '{"consequence":"x","default":null,"waitMinutes":null}'::jsonb, ${ago(220)}, 'pino', 'owner', ${ago(215)}, true)`
    await sql`INSERT INTO factory.quality_watches (key, issue_id, attempt, watch, started_at, window_ms, answer, answered_at) VALUES
      ('watch_p1', 'issue_91', 1, 1, ${ago(201)}, 1000, 'passed', ${ago(200)}),
      ('watch_p2', 'issue_92', 1, 1, ${ago(191)}, 1000, 'regressed', ${ago(190)}),
      ('watch_p3', 'issue_93', 1, 1, ${ago(186)}, 1000, 'passed', ${ago(185)})`
    try {
      const model = KpiModel.parse(await readKpis(sql, { now: NOW, days: 7 }))
      const by = Object.fromEntries(model.kpis.map((k) => [k.key, k]))
      const week = 7 * 24 * 3_600_000

      // the windows are contiguous, half-open, and the last is the current window
      expect(model.windows).toHaveLength(HISTORY_WINDOWS)
      expect(model.windows.at(-1)).toEqual(model.window)
      for (const [i, w] of model.windows.entries()) {
        expect(Date.parse(w.to) - Date.parse(w.from)).toBe(week)
        if (i > 0) expect(w.from).toBe(model.windows[i - 1]?.to ?? '')
      }

      for (const kpi of model.kpis) {
        expect(kpi.history).toHaveLength(HISTORY_WINDOWS)
        expect(kpi.history.at(-1)).toEqual({ value: kpi.value, n: kpi.n })
      }
      for (const key of ['cost', 'window_points', 'fix_commits']) {
        expect(by[key]?.history.slice(0, 4)).toEqual(Array(4).fill({ value: null, n: 0 }))
      }
      // the Issue 30 days back counts in asks (its real n) but not in cost or points, which that window does not read
      expect(by.asks?.history.slice(0, 4).map((p) => p.n)).toEqual([0, 1, 0, 0])

      // the window before: two Issues filed, one owner note, one refusal, one Decision raised and answered by the owner,
      // three first watches with two passes, admissions after waits of 2 h and 3 h
      const before = (key: string) => by[key]?.history.at(-2)
      expect(before('avoidable_touches')).toEqual({ value: 1 / 2, n: 2 })
      expect(before('asks')).toEqual({ value: 1 / 2, n: 2 })
      expect(before('refusals')).toEqual({ value: 1 / 2, n: 2 })
      expect(before('first_verification_passes')).toEqual({ value: 2 / 3, n: 3 })
      expect(before('queue_wait_p90')).toEqual({ value: null, n: 2 })
      expect(before('cycle_p50')).toEqual({ value: null, n: 0 })
      // the current window is unchanged by them
      expect(by.avoidable_touches).toMatchObject({ n: 9, count: 3 })

      // the same window read directly gives the same figures as the history entry
      const shifted = KpiModel.parse(await readKpis(sql, { now: new Date(NOW.getTime() - week), days: 7 }))
      for (const key of ['avoidable_touches', 'asks', 'refusals', 'first_verification_passes', 'queue_wait_p90']) {
        const direct = shifted.kpis.find((k) => k.key === key)
        expect(before(key)).toEqual({ value: direct?.value ?? null, n: direct?.n ?? -1 })
      }
    } finally {
      await sql`DELETE FROM factory.quality_watches WHERE key LIKE 'watch_p%'`
      await sql`DELETE FROM factory.decisions WHERE id = 'decision_p'`
      await sql`DELETE FROM factory.issue_events WHERE issue_id IN ('issue_91', 'issue_92', 'issue_93', 'issue_94')`
      await sql`DELETE FROM factory.issues WHERE id IN ('issue_91', 'issue_92', 'issue_93', 'issue_94')`
    }
  })

  test('kpis: cost and window points join the usage schema, never copy it; a missing view leaves points unmeasured', async () => {
    await sql`CREATE SCHEMA usage`
    await sql`CREATE TABLE usage.sessions (id bigint PRIMARY KEY, source_session_id text, issue_id text)`
    await sql`CREATE TABLE usage.records_unique (session_id bigint, cost_usd numeric)`
    await sql`INSERT INTO usage.sessions VALUES (1, 'claude-a', '2'), (2, 'abc:agent-x', NULL), (3, 'other', '999')`
    await sql`INSERT INTO usage.records_unique VALUES (1, 3.0), (1, 1.0), (2, 2.0), (3, 100.0)`
    await sql`INSERT INTO factory.lead_hook_events (key, session, issue_id, attempt, kind, at, received_at, payload)
      VALUES ('hook_1', 'lead-3', 'issue_3', 1, 'session_started', ${ago(19)}, ${ago(19)}, '{"claudeSessionId":"abc"}'::jsonb)`

    const noShares = KpiModel.parse(await readKpis(sql, { now: NOW, days: 7 }))
    expect(noShares.kpis.find((k) => k.key === 'cost')).toMatchObject({ measured: true, value: 6 / 9, n: 9 })
    expect(noShares.kpis.find((k) => k.key === 'window_points')).toMatchObject({ measured: false, value: null })

    await sql`CREATE TABLE usage.session_window_share (account text, session_id bigint, five_hour_pct float8, seven_day_pct float8)`
    await sql`INSERT INTO usage.session_window_share VALUES ('a', 1, 1.5, 4), ('a', 2, 0.5, 1), ('a', 3, 50, 50)`
    const full = KpiModel.parse(await readKpis(sql, { now: NOW, days: 7 }))
    expect(full.kpis.find((k) => k.key === 'window_points')).toMatchObject({ measured: true, value: 2 / 9 })

    await sql`ALTER TABLE usage.records_unique RENAME COLUMN cost_usd TO price`
    const broken = KpiModel.parse(await readKpis(sql, { now: NOW, days: 7 }))
    expect(broken.kpis.find((k) => k.key === 'cost')).toMatchObject({ measured: false, value: null })
    await sql`DROP SCHEMA usage CASCADE`
  })

  test('kpis: the cost KPI groups by seat; a usage side with no seat columns keeps the cost and drops the parts', async () => {
    await sql`CREATE SCHEMA usage`
    await sql`CREATE TABLE usage.sessions (id bigint PRIMARY KEY, source_session_id text, issue_id text)`
    await sql`CREATE TABLE usage.records_unique (session_id bigint, cost_usd numeric, tool text, model text, effort text)`
    await sql`INSERT INTO usage.sessions VALUES (1, 'claude-a', '2'), (2, 'abc:agent-x', NULL), (3, 'other', '999')`
    await sql`INSERT INTO usage.records_unique VALUES
      (1, 3.0, 'lead', 'claude-sonnet-5-5', 'high'), (1, 1.0, 'lead', 'claude-sonnet-5-5', 'high'),
      (2, 2.0, 'worker', 'claude-haiku-5-5', NULL), (3, 100.0, 'lead', 'claude-opus-5-5', 'max')`
    await sql`INSERT INTO factory.lead_hook_events (key, session, issue_id, attempt, kind, at, received_at, payload)
      VALUES ('hook_seat', 'lead-3', 'issue_3', 1, 'session_started', ${ago(19)}, ${ago(19)}, '{"claudeSessionId":"abc"}'::jsonb)`
    try {
      const cost = KpiModel.parse(await readKpis(sql, { now: NOW, days: 7 })).kpis.find((k) => k.key === 'cost')
      expect(cost).toMatchObject({ measured: true, value: 6 / 9 })
      expect(cost?.parts).toEqual([
        { key: 'lead · claude-sonnet-5-5 · high', label: 'lead · claude-sonnet-5-5 · high', value: 4 / 9, unit: 'usd' },
        {
          key: 'worker · claude-haiku-5-5 · none',
          label: 'worker · claude-haiku-5-5 · none',
          value: 2 / 9,
          unit: 'usd',
        },
      ])
      await sql`ALTER TABLE usage.records_unique DROP COLUMN effort`
      const bare = KpiModel.parse(await readKpis(sql, { now: NOW, days: 7 })).kpis.find((k) => k.key === 'cost')
      expect(bare).toMatchObject({ measured: true, value: 6 / 9, parts: [] })
    } finally {
      await sql`DROP SCHEMA usage CASCADE`
      await sql`DELETE FROM factory.lead_hook_events WHERE key = 'hook_seat'`
    }
  })

  test('kpis: a usage statement past the timeout leaves its figure unmeasured and frees the connection; points are reused', async () => {
    await sql`CREATE SCHEMA usage`
    try {
      await sql`CREATE TABLE usage.sessions (id bigint PRIMARY KEY, source_session_id text, issue_id text)`
      await sql`CREATE TABLE usage.records_unique (session_id bigint, cost_usd numeric)`
      await sql`INSERT INTO usage.sessions VALUES (1, 'claude-a', '2')`
      await sql`INSERT INTO usage.records_unique VALUES (1, 3.0)`
      await sql`CREATE TABLE usage.share_rows (account text, session_id bigint, five_hour_pct float8)`
      await sql`INSERT INTO usage.share_rows VALUES ('a', 1, 1.5)`
      // the view is slow: it sleeps once per row it returns
      await sql`CREATE VIEW usage.session_window_share AS SELECT account, session_id, five_hour_pct, (pg_sleep(1) IS NULL) AS slept FROM usage.share_rows`

      const slow = KpiModel.parse(
        await readKpis(sql, { now: NOW, days: 7, usageTimeoutMs: 200, pointsCache: pointsCache() }),
      )
      expect(slow.kpis.find((k) => k.key === 'cost')).toMatchObject({ measured: true, value: 3 / 9 })
      expect(slow.kpis.find((k) => k.key === 'window_points')).toMatchObject({ measured: false, value: null })

      const cache = pointsCache()
      const first = KpiModel.parse(
        await readKpis(sql, { now: NOW, days: 7, usageTimeoutMs: 5_000, pointsCache: cache }),
      )
      expect(first.kpis.find((k) => k.key === 'window_points')).toMatchObject({ measured: true, value: 1.5 / 9 })
      await sql`UPDATE usage.share_rows SET five_hour_pct = 9`
      const again = KpiModel.parse(
        await readKpis(sql, { now: NOW, days: 7, usageTimeoutMs: 5_000, pointsCache: cache }),
      )
      expect(again.kpis.find((k) => k.key === 'window_points')).toMatchObject({ measured: true, value: 1.5 / 9 })
      const later = new Date(NOW.getTime() + 16 * 60_000)
      const expired = KpiModel.parse(
        await readKpis(sql, { now: later, days: 7, usageTimeoutMs: 5_000, pointsCache: cache }),
      )
      expect(expired.kpis.find((k) => k.key === 'window_points')).toMatchObject({ measured: true })
      expect(expired.kpis.find((k) => k.key === 'window_points')?.value).not.toBeCloseTo(1.5 / 9)
    } finally {
      await sql`DROP SCHEMA usage CASCADE`
    }
  })

  test('kpis: a role with no USAGE on the usage schema leaves cost unmeasured instead of failing the read', async () => {
    await sql`CREATE SCHEMA usage`
    await sql`CREATE TABLE usage.sessions (id bigint PRIMARY KEY, source_session_id text, issue_id text)`
    await sql`CREATE ROLE kpi_no_usage`
    try {
      await sql`GRANT USAGE ON SCHEMA factory TO kpi_no_usage`
      await sql`GRANT SELECT ON ALL TABLES IN SCHEMA factory TO kpi_no_usage`
      // the failed statement leaves the transaction aborted (a COMMIT would be refused), so it always ends in a rollback
      const rollback = new Error('rollback')
      let model: KpiModel | undefined
      await sql
        .begin(async (tx) => {
          await tx`SET LOCAL ROLE kpi_no_usage`
          model = KpiModel.parse(await readKpis(tx, { now: NOW, days: 7 }))
          throw rollback
        })
        .catch((error: unknown) => {
          if (error !== rollback) throw error
        })
      if (!model) throw new Error('readKpis did not answer')
      expect(model.kpis.find((k) => k.key === 'cost')).toMatchObject({ measured: false, value: null })
      expect(model.kpis.find((k) => k.key === 'window_points')).toMatchObject({ measured: false, value: null })
      expect(model.kpis.find((k) => k.key === 'avoidable_touches')?.measured).toBe(true)
    } finally {
      await sql`DROP OWNED BY kpi_no_usage`
      await sql`DROP ROLE kpi_no_usage`
      await sql`DROP SCHEMA usage CASCADE`
    }
  })

  test('friction: counts by kind with plain labels, per Issue, and the zero ones present', async () => {
    const model = FrictionModel.parse(await readFriction(sql, { now: NOW, days: 7 }))
    expect(model.issues).toBe(9)
    expect(model.closed).toBe(2)
    expect(model.since).toBeNull()
    const count = (key: string) => model.counts.find((c) => c.key === key)
    expect(count('touch:decision_answered')).toMatchObject({ count: 1, perIssue: 1 / 2 })
    expect(count('touch:noted')?.count).toBe(1)
    expect(count('touch:cancelled')?.count).toBe(1)
    expect(count('touch:reopened')?.count).toBe(0)
    expect(count('refusal:total')?.count).toBe(1)
    expect(count('refusal:closed:not working')).toMatchObject({
      count: 1,
      label: 'A closed event was refused: not working',
    })
    expect(count('ship_refused:total')?.count).toBe(1)
    expect(count('stall:wall')?.count).toBe(1)
    expect(count('stall:lead_gone')?.count).toBe(0)
    expect(count('lead_gone')?.count).toBe(1)
    expect(count('undelivered_note')?.count).toBe(1)
    expect(count('unreviewed_ship')?.count).toBe(1)
    expect(count('unstated_acceptance')?.count).toBe(1)
    expect(count('regression')?.count).toBe(1)
    expect(count('decision_settled:owner')?.count).toBe(2)
    expect(count('decision_settled:judge')?.count).toBe(1)
    expect(count('decision_settled:policy')?.count).toBe(0)
    expect(count('signal_held:total')?.count).toBe(2)
    expect(count('signal_held:github')?.count).toBe(1)
    for (const c of model.counts) expect(c.label).not.toMatch(/(issue|decision|errand|signal)_\w+/)

    const later = new Date(NOW.getTime() + 10 * 24 * 3_600_000)
    const day = FrictionModel.parse(await readFriction(sql, { now: later, days: 1 }))
    expect(day.counts.find((c) => c.key === 'decision_settled:owner')?.count).toBe(0)
  })

  test('friction counts nothing older than the newest import, and the evidence agrees', async () => {
    await sql`INSERT INTO factory.import_issues (issue_id, legacy_id, imported_at, last_event, carried_version)
      VALUES ('issue_6', 6, ${ago(2)}, 1, 1)`
    try {
      const model = FrictionModel.parse(await readFriction(sql, { now: NOW, days: 7 }))
      expect(model.since).toBe(ago(2).toISOString())
      expect(model.window.from).toBe(ago(2).toISOString())
      const count = (key: string) => model.counts.find((c) => c.key === key)?.count
      expect(count('lead_gone')).toBe(1) // 1.2 hours ago: the new core's own
      expect(count('regression')).toBe(0) // answered 10 hours ago: history
      expect(model.issues).toBeLessThan(9)
      const evidence = await readFrictionEvidence(sql, { now: NOW, days: 7 }, ['lead_gone', 'regression'])
      expect(evidence).toEqual({ lead_gone: ['issue_6'], regression: [] })
    } finally {
      await sql`DELETE FROM factory.import_issues WHERE issue_id = 'issue_6'`
    }
  })

  test('friction evidence: Issue refs exist exactly when the count is above zero, newest first, at most five', async () => {
    const model = await readFriction(sql, { now: NOW, days: 7 })
    const mapped = model.counts.filter(
      (c) => !c.key.endsWith(':total') && !['decision_settled', 'undelivered_note', 'signal'].includes(c.group),
    )
    expect(mapped.length).toBeGreaterThan(10)
    const evidence = await readFrictionEvidence(
      sql,
      { now: NOW, days: 7 },
      mapped.map((c) => c.key),
    )
    for (const c of mapped) {
      const refs = evidence[c.key] ?? []
      expect(evidence[c.key], c.key).toBeDefined()
      expect(refs.length > 0, c.key).toBe(c.count > 0)
      expect(refs.length).toBeLessThanOrEqual(5)
      for (const ref of refs) expect(ref).toMatch(/^issue_\d+$/)
    }
    expect(await readFrictionEvidence(sql, { now: NOW, days: 7 }, ['undelivered_note', 'signal_held:github'])).toEqual(
      {},
    )
  })
})

describe('the flow trend', () => {
  test('daily samples of the state counts and the shipped counts per window; the last sample is the live count', async () => {
    await sql`TRUNCATE factory.issues CASCADE`
    // t1: working since 2 days ago (queued before), still working
    await issue('issue_1', 'app', 'working', 3)
    await filed('issue_1', 'app', 'One', ago(24 * 5))
    await event('issue_1', 2, 'settled', ago(24 * 5 - 1), { from: 'settling', to: 'queued' })
    await event('issue_1', 3, 'admitted', ago(24 * 2), { from: 'queued', to: 'working' })
    // t2: closed done 3 days ago
    await issue('issue_2', 'app', 'closed', 4, undefined, 'done')
    await filed('issue_2', 'app', 'Two', ago(24 * 6))
    await event('issue_2', 2, 'settled', ago(24 * 6 - 1), { from: 'settling', to: 'queued' })
    await event('issue_2', 3, 'admitted', ago(24 * 5), { from: 'queued', to: 'working' })
    await event('issue_2', 4, 'closed', ago(24 * 3 + 1), { from: 'working', to: 'closed', outcome: 'done' })
    // t3: healed 10 days ago, before the first sample; counts in shippedBefore only
    await issue('issue_3', 'app', 'closed', 2, undefined, 'healed')
    await filed('issue_3', 'app', 'Three', ago(24 * 11))
    await event('issue_3', 2, 'closed', ago(24 * 10), { from: 'settling', to: 'closed', outcome: 'healed' })
    // t4: filed 12 h ago, still settling
    await issue('issue_4', 'app', 'settling', 1)
    await filed('issue_4', 'app', 'Four', ago(12))

    const flow = FlowModel.parse(await readFlow(sql, { now: NOW }))
    const { trend } = flow
    expect(trend.at.map((t) => Date.parse(t))).toEqual(
      Array.from({ length: 8 }, (_, i) => NOW.getTime() - (7 - i) * 86_400_000),
    )
    expect(trend.at[7]).toBe(NOW.toISOString())
    // samples at -7 d .. now: t2 is settling at -6 d, working at -5 d and -4 d, closed by -3 d; t1 settles at -5 d, queues, works from -2 d
    expect(trend.states.settling).toEqual([0, 1, 1, 0, 0, 0, 0, 1])
    expect(trend.states.queued).toEqual([0, 0, 0, 1, 1, 0, 0, 0])
    expect(trend.states.working).toEqual([0, 0, 1, 1, 0, 1, 1, 1])
    expect(trend.states.waiting).toEqual(Array(8).fill(0))
    // t2 closed 3 d and 1 h ago: the window (-4 d, -3 d]
    expect(trend.shipped).toEqual([0, 0, 0, 1, 0, 0, 0])
    expect(trend.shippedBefore).toBe(1)
    // the last 7 days by the hour: t2 (73 h ago) is in the window (-74 h, -73 h]; t3 (10 d) is out. The last 30 days by the
    // day: t2 in the window (-4 d, -3 d] (bucket 26 of 30), t3 in (-11 d, -10 d] (bucket 19)
    expect(trend.shippedHourly.map((n, i) => (n ? i : -1)).filter((i) => i >= 0)).toEqual([94])
    expect(trend.shippedHourly.reduce((a, b) => a + b, 0)).toBe(1)
    expect(trend.shippedDaily30.map((n, i) => (n ? i : -1)).filter((i) => i >= 0)).toEqual([19, 26])
    // the last sample is the live column counts
    for (const state of Object.keys(trend.states) as (keyof typeof trend.states)[]) {
      expect(trend.states[state][7]).toBe(flow.states[state].count)
    }
  })
})

describe('one definition of running, paused, ready, held and checking', () => {
  test('the strip, the Flow cards, the per-project figures and the project digest agree, settling and watching included', async () => {
    await sql`TRUNCATE factory.issues CASCADE`
    // app: 2 working, 1 watching, 1 waiting, 2 queued, 1 settling; other: 1 working
    const seeded: [string, string, string][] = [
      ['issue_1', 'app', 'working'],
      ['issue_2', 'app', 'working'],
      ['issue_3', 'app', 'watching'],
      ['issue_4', 'app', 'waiting'],
      ['issue_5', 'app', 'queued'],
      ['issue_6', 'app', 'queued'],
      ['issue_7', 'app', 'settling'],
      ['issue_8', 'other', 'working'],
    ]
    for (const [id, repo, state] of seeded) {
      await issue(id, repo, state, 1, state === 'waiting' ? 'timer' : undefined)
      await event(id, 1, 'filed', ago(5), { payload: { repo, title: id, kind: 'feature', origin: 'you' }, to: state })
    }
    const flow = FlowModel.parse(await readFlow(sql, { now: NOW }))
    // the strip and the cards: watching is Checking, settling is Held, a queued Issue with no reason is Ready
    expect(flow.work).toMatchObject({ running: 3, checking: 1, paused: 1, ready: 2, held: 1 })
    expect(openOfWork(flow.work)).toBe(8)
    // the per-project figures add up to the whole and to open
    const app = flow.perProject.find((p) => p.repo === 'app')
    expect(app).toMatchObject({ repo: 'app', open: 7 })
    expect(app?.work).toMatchObject({ running: 2, checking: 1, paused: 1, ready: 2, held: 1 })
    expect(flow.perProject.reduce((n, p) => n + p.work.running, 0)).toBe(3)
    for (const p of flow.perProject) expect(openOfWork(p.work)).toBe(p.open)
    // the digest of the project counts the same Issues the same way
    const digestIssues = await loopReads(sql).digestIssues(new Date(NOW.getTime() - DIGEST_WINDOW_MS))
    const digest = countsOf(
      digestIssues.filter((i) => i.repo === 'app'),
      NOW,
    )
    expect(digest.done7d).toBe(0)
    expect(digest.work).toEqual(app?.work as WorkCounts)
  })
})

describe('the flow trend by bucket', () => {
  /** `count` Issues of `app` working from `from` to `to` hours ago, then closed */
  async function workedBetween(first: number, count: number, from: number, to: number) {
    for (let n = 0; n < count; n++) {
      const id = `issue_${first + n}`
      await issue(id, 'app', 'closed', 4, undefined, 'done')
      await filed(id, 'app', id, ago(from + 3))
      await event(id, 2, 'settled', ago(from + 2), { from: 'settling', to: 'queued' })
      await event(id, 3, 'admitted', ago(from), { from: 'queued', to: 'working' })
      await event(id, 4, 'closed', ago(to), { from: 'working', to: 'closed', outcome: 'done' })
    }
  }

  test('a noon peak of 25 working Issues is the peak of the 24-hour and the 7-day charts, with its average', async () => {
    await sql`TRUNCATE factory.issues CASCADE`
    // NOW is 12:00 UTC: 25 Issues work from 22 h to 20 h ago (14:00 to 16:00 yesterday)
    await workedBetween(1, 25, 22, 20)
    // a single Issue, working across the last 5 hours and still working
    await issue('issue_100', 'app', 'working', 3)
    await filed('issue_100', 'app', 'Steady', ago(8))
    await event('issue_100', 2, 'settled', ago(7), { from: 'settling', to: 'queued' })
    await event('issue_100', 3, 'admitted', ago(5), { from: 'queued', to: 'working' })

    const hourly = FlowTrendSeries.parse(await readFlowTrend(sql, { now: NOW, window: '24h', bucket: 'hour' }))
    expect(hourly.buckets).toHaveLength(24)
    // the first bucket starts 23 h before the current hour
    expect(hourly.buckets[0]?.at).toBe(ago(23).toISOString())
    expect(hourly.buckets.at(-1)?.at).toBe(NOW.toISOString())
    expect(Math.max(...hourly.buckets.map((b) => b.running.peak))).toBe(25)
    // the bucket that starts at 22 h ago holds all 25 for its whole hour
    const noon = hourly.buckets.find((b) => b.at === ago(22).toISOString())
    expect(noon?.running).toEqual({ peak: 25, avg: 25 })

    const week = FlowTrendSeries.parse(await readFlowTrend(sql, { now: NOW, window: '7d', bucket: 'hour' }))
    expect(week.buckets).toHaveLength(168)
    expect(Math.max(...week.buckets.map((b) => b.running.peak))).toBe(25)
    const days = FlowTrendSeries.parse(await readFlowTrend(sql, { now: NOW, window: '7d', bucket: 'day' }))
    expect(days.buckets).toHaveLength(7)
    expect(Math.max(...days.buckets.map((b) => b.running.peak))).toBe(25)
    // a day's average is below its peak: the 25 worked 2 of its 24 hours at most
    const peakDay = days.buckets.find((b) => b.running.peak === 25)
    expect(peakDay?.running.avg).toBeLessThan(25)
    expect(peakDay?.running.avg).toBeGreaterThan(0)
    const month = FlowTrendSeries.parse(await readFlowTrend(sql, { now: NOW, window: '30d', bucket: 'day' }))
    expect(month.buckets).toHaveLength(30)
    expect(Math.max(...month.buckets.map((b) => b.running.peak))).toBe(25)
  })
})
