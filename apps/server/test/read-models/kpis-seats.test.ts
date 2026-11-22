import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import type { SQL } from 'bun'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { costOfIssues } from '../../src/read/kpis.ts'
import { readSeatKpis, readTripwire } from '../../src/read/kpis-seats.ts'

/**
 * The light seat's four figures and the tripwire over a real Postgres, worked out by hand from one fixture. Six Issues
 * started in the last day: three the light rule seated (one shipped and passed, one said it was beyond its seat and the
 * lead row shipped it, one shipped and regressed on its first watch and moved up) and three that started on the lead
 * row (two passed, one regressed). The `usage` schema is another component's: it is created after the first read.
 */
let db: TestCluster
let sql: SQL
const NOW = new Date('2026-11-17T12:00:00Z')
const ago = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000)
const W = { from: ago(7 * 24), to: NOW }
const MIN = 60_000

let events = 0
async function event(
  issue: string,
  version: number,
  kind: string,
  at: Date,
  payload: Record<string, unknown> = {},
  states: { from?: string; to?: string } = {},
) {
  events += 1
  await sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, from_state, to_state)
    VALUES (${`event_${events}`}, ${issue}, ${`key_${events}`}, ${kind}, ${payload}, 'factory', ${at}, 'applied', ${version},
      ${states.from ?? 'working'}, ${states.to ?? 'working'})`
}

async function started(issue: string, version: number, attempt: number, at: Date, rule: string | null) {
  await event(issue, version, 'lead_started', at, {
    attempt,
    terminal: 't',
    seat: { tier: rule ? 'haiku' : 'sonnet', effort: 'high', role: rule ? 'light' : 'lead', ...(rule ? { rule } : {}) },
  })
  await sql`INSERT INTO factory.lead_attempts (issue_id, attempt, branch, first_try_at, started_at, tier, effort)
    VALUES (${issue}, ${attempt}, ${`b-${issue}-${attempt}`}, ${at}, ${at}, ${rule ? 'haiku' : 'sonnet'}, 'high')`
  await sql`INSERT INTO factory.lead_hook_events (key, session, issue_id, attempt, kind, at, received_at, payload)
    VALUES (${`h-${issue}-${attempt}`}, ${`lead-${issue}-${attempt}`}, ${issue}, ${attempt}, 'session_started', ${at}, ${at},
      ${{ claudeSessionId: `claude-${issue}-${attempt}` }})`
}

async function watch(issue: string, attempt: number, answer: 'passed' | 'regressed') {
  await sql`INSERT INTO factory.quality_watches (key, issue_id, attempt, watch, started_at, window_ms, answer, answered_at)
    VALUES (${`w:${issue}:${attempt}`}, ${issue}, ${attempt}, 1, ${ago(2)}, 0, ${answer}, ${ago(1)})`
}

async function filed(issue: string, at: Date) {
  await sql`INSERT INTO factory.issues (id, repo, state, version) VALUES (${issue}, 'app', 'working', 3)`
  await event(issue, 1, 'filed', at, {}, { to: 'settling' })
  await sql`UPDATE factory.issue_events SET from_state = NULL WHERE issue_id = ${issue} AND version = 1`
}

beforeAll(async () => {
  db = await startTestCluster()
  sql = db.sql
  await migrate(sql, await loadMigrations())

  // L1: light attempt shipped, passed
  await filed('issue_1', ago(10))
  await started('issue_1', 2, 1, ago(9), 'hygiene:links')
  await watch('issue_1', 1, 'passed')
  // L2: light attempt said it is out of its depth after 30 minutes; the lead row's attempt shipped and passed
  await filed('issue_2', ago(10))
  await started('issue_2', 2, 1, ago(9), 'hygiene:stale')
  await event('issue_2', 3, 'moved_up', new Date(ago(9).getTime() + 30 * MIN), { attempt: 1, why: 'beyond its seat' })
  await started('issue_2', 4, 2, ago(8), null)
  await watch('issue_2', 2, 'passed')
  // L3: light attempt shipped, its first watch regressed and it moved up
  await filed('issue_3', ago(10))
  await started('issue_3', 2, 1, ago(9), 'kind:docs')
  await watch('issue_3', 1, 'regressed')
  await event('issue_3', 3, 'moved_up', new Date(ago(9).getTime() + 90 * MIN), { attempt: 1, why: 'regressed' })
  // lead row: two pass, one regresses
  for (const [n, answer] of [
    [4, 'passed'],
    [5, 'passed'],
    [6, 'regressed'],
  ] as const) {
    await filed(`issue_${n}`, ago(10))
    await started(`issue_${n}`, 2, 1, ago(9), null)
    await watch(`issue_${n}`, 1, answer)
  }
})

afterAll(async () => {
  await db.stop()
})

// without the usage schema: unmeasured, never zero
const costOf = (issues: readonly string[]) => costOfIssues(sql, issues, 5_000)
const priced = costOf

describe('the light seat delivers', () => {
  test('counts what finished on the seat, the move-ups apart, and leaves cost and bound unmeasured without usage', async () => {
    const kpis = await readSeatKpis(sql, W, { now: NOW, cost: costOf })
    const { light, lead } = kpis.delivery
    // (a) two first watches shipped by the light lead: one passed, one regressed; L2's move-up shipped nothing on the seat
    expect(light).toMatchObject({
      issues: 3,
      finishedWatches: 2,
      finishedPassRate: 0.5,
      movedUp: 2,
      regressions: 1,
      cost: null,
      costPerIssue: null,
      movedUpCost: null,
    })
    expect(light.movedUpShare).toBeCloseTo(2 / 3)
    expect(light.regressionsPerIssue).toBeCloseTo(1 / 3)
    // (b) the light attempts ran 30 and 90 minutes before they moved up
    expect(light.movedUpMs).toBe(60 * MIN)
    expect(lead).toMatchObject({ issues: 3, finishedWatches: 3, movedUp: 0, movedUpShare: null })
    expect(lead.finishedPassRate).toBeCloseTo(2 / 3)
    expect(kpis.rows.find((row) => row.seat === 'light')).toMatchObject({ firstWatches: 2, firstPassRate: 0.5 })
    expect(kpis.tripwire.bound).toBeNull()
    expect(kpis.tripwire.met).toBeNull()
  })

  test('stays closed while light has fewer than ten finished first watches, even with the cost known', async () => {
    await sql`CREATE SCHEMA usage`
    await sql`CREATE TABLE usage.sessions (id bigint PRIMARY KEY, source_session_id text, issue_id text)`
    await sql`CREATE TABLE usage.records_unique (session_id bigint, cost_usd numeric)`
    // light attempts cost 0.1, 0.2 and 0.3 (mean 0.2); the lead row's attempts of lead Issues 2, 3 and 4 (mean 3); the
    // lead attempt after L2's move-up 1, a single one, so the lead row's mean stands in for it
    const sessions: [string, number][] = [
      ['issue_1-1', 0.1],
      ['issue_2-1', 0.2],
      ['issue_3-1', 0.3],
      ['issue_2-2', 1],
      ['issue_4-1', 2],
      ['issue_5-1', 3],
      ['issue_6-1', 4],
    ]
    for (const [i, [name, cost]] of sessions.entries()) {
      const [issue, attempt] = name.split('-') as [string, string]
      await sql`INSERT INTO usage.sessions VALUES (${i + 1}, ${`claude-${issue}-${attempt}`}, NULL)`
      await sql`INSERT INTO usage.records_unique VALUES (${i + 1}, ${cost})`
    }
    const kpis = await readSeatKpis(sql, W, { now: NOW, cost: priced })
    // (3 - 0.2) / 3: light plus a follow-up costs more than the lead row only above 93.3 % moved up
    expect(kpis.tripwire.bound?.share).toBeCloseTo((3 - 0.2) / 3)
    expect(kpis.tripwire.bound).toMatchObject({ lightAttempt: expect.closeTo(0.2), leadAttempt: 3, followUpAttempt: 3 })
    // the same break-even in minutes (medians: a light Issue that finished, a move-up's attempt, the lead row's Issue)
    const { bound } = kpis.tripwire
    expect(bound?.time).not.toBeNull()
    expect(bound?.time?.movedMs).toBe(60 * MIN)
    expect(kpis.tripwire.met).toBeNull()
    expect(kpis.tripwire.failing.join(' ')).toContain('2 of 10')
    // (d) every session of the light Issues: 0.1 + 0.2 + 1 + 0.3
    expect(kpis.delivery.light.cost).toBeCloseTo(1.6)
    expect((await readTripwire(sql, { now: NOW, cost: priced })).met === true).toBe(false)
  })

  test('opens on a measured window and closes on a broken one', async () => {
    // pad the light seat with eight more shipped-and-passed Issues so ten first watches finished on it
    for (let n = 10; n < 18; n += 1) {
      await filed(`issue_${n}`, ago(10))
      await started(`issue_${n}`, 2, 1, ago(9), 'hygiene:links')
      await watch(`issue_${n}`, 1, 'passed')
    }
    // and a lead row that passes as often: 7 of 9 more
    for (let n = 20; n < 29; n += 1) {
      await filed(`issue_${n}`, ago(10))
      await started(`issue_${n}`, 2, 1, ago(9), null)
      await watch(`issue_${n}`, 1, 'passed')
    }
    const open = await readSeatKpis(sql, W, { now: NOW, cost: priced })
    // light passed 9 of 10 finished (0.9) against lead 11 of 12 (0.917): the gap is not shown, the move-up share is far
    // under the bound, and light regressing 1 in 11 Issues against the lead row's 1 in 12 is shown, not a condition
    expect(open.tripwire.light.finishedWatches).toBe(10)
    expect(open.tripwire.light.finishedPassRate).toBeCloseTo(0.9)
    expect(open.tripwire.lead.finishedPassRate).toBeCloseTo(11 / 12)
    expect(open.tripwire.met).toBe(true)
    expect(open.tripwire.failing).toEqual([])
    expect(open.tripwire.passGap?.lower).toBeLessThan(0)
    expect(open.tripwire.regressionGap?.perIssue).toBeGreaterThan(0)
    expect(open.tripwire).toMatchObject({ days: 14, confidence: 0.95, targetWatches: 100 })
    expect((await readTripwire(sql, { now: NOW, cost: priced })).met === true).toBe(true)
    // four more light first watches regressed: light passed 5 of 10, shown far under lead's rate
    await sql`UPDATE factory.quality_watches SET answer = 'regressed'
      WHERE key IN ('w:issue_10:1', 'w:issue_11:1', 'w:issue_12:1', 'w:issue_13:1')`
    const closed = await readSeatKpis(sql, W, { now: NOW, cost: priced })
    expect(closed.tripwire.met).toBe(false)
    expect(closed.tripwire.failing[0]).toContain('shown more than 3 points under')
    expect((await readTripwire(sql, { now: NOW, cost: priced })).met === true).toBe(false)
    // a window 15 days later holds none of them: nothing is measured, the gate narrows by itself
    const later = new Date(NOW.getTime() + 15 * 24 * 3_600_000)
    expect((await readTripwire(sql, { now: later, cost: priced })).met).toBeNull()
  })

  test('prices a subagent with its attempt and leaves an unreported session tagged to the Issue out', async () => {
    // issue_2's light attempt 1 moved up: its subagent session (`<session>:<agent>`) is priced with it, 0.5. Session 9 is
    // tagged to issue 2 but no hook reported it, so it belongs to no attempt and is not counted.
    await sql`INSERT INTO usage.sessions VALUES (8, ${'claude-issue_2-1:explore'}, NULL)`
    await sql`INSERT INTO usage.records_unique VALUES (8, 0.5)`
    await sql`INSERT INTO usage.sessions VALUES (9, ${'claude-issue_2-9'}, '2')`
    await sql`INSERT INTO usage.records_unique VALUES (9, 7)`
    const kpis = await readSeatKpis(sql, W, { now: NOW, cost: priced })
    // 11 light Issues; the moved-up attempts cost 0.2 + 0.5 (subagent) and 0.3, over the 11
    expect(kpis.delivery.light.issues).toBe(11)
    expect(kpis.delivery.light.movedUpCost).toBeCloseTo(1 / 11)
  })
})

describe('the move-up steps, the filed seats and the move-up seat of the lead row', () => {
  // a window of its own in 2030: nothing of the fixture above falls in it
  const LATER = new Date('2030-01-15T12:00:00Z')
  const W2 = { from: new Date(LATER.getTime() - 7 * 24 * 3_600_000), to: LATER }
  const base = new Date(LATER.getTime() - 2 * 24 * 3_600_000)
  const at = (minutes: number) => new Date(base.getTime() + minutes * MIN)
  const LIGHT_SEAT = { tier: 'haiku', effort: 'high', role: 'light', rule: 'hygiene:links' }
  const LEAD_SEAT = { tier: 'sonnet', effort: 'high', role: 'lead' }
  const MOVE_UP_SEAT = { tier: 'sonnet', effort: 'medium', role: 'lead', moveUp: true }
  const STRONG_SEAT = { tier: 'opus', effort: 'high', role: 'strong' }
  let steps = 0

  async function put(
    issue: string,
    version: number,
    kind: string,
    when: Date,
    payload: Record<string, unknown>,
    from: string | null,
    to: string,
  ) {
    steps += 1
    await sql`
      INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, from_state, to_state)
      VALUES (${`step_${steps}`}, ${issue}, ${`step_key_${steps}`}, ${kind}, ${payload}, 'factory', ${when}, 'applied', ${version}, ${from}, ${to})`
  }

  async function filed(issue: string, seat: Record<string, unknown> | null) {
    await sql`INSERT INTO factory.issues (id, repo, state, version) VALUES (${issue}, 'app', 'working', 3)`
    await put(issue, 1, 'filed', base, seat === null ? {} : { seat }, null, 'settling')
  }

  async function lead(issue: string, version: number, attempt: number, seat: Record<string, unknown>) {
    await put(issue, version, 'lead_started', base, { attempt, terminal: 't', seat }, 'working', 'working')
    await sql`INSERT INTO factory.lead_hook_events (key, session, issue_id, attempt, kind, at, received_at, payload)
      VALUES (${`hook_${issue}_${attempt}`}, ${`lead-${issue}-${attempt}`}, ${issue}, ${attempt}, 'session_started', ${base}, ${base}, ${{ claudeSessionId: `claude-${issue}-${attempt}` }})`
  }

  async function moved(issue: string, version: number, minutes: number, why: string, to?: string) {
    await put(
      issue,
      version,
      'moved_up',
      at(minutes),
      { attempt: 1, why, ...(to === undefined ? {} : { to }) },
      'working',
      'working',
    )
  }

  async function watch(issue: string, attempt: number, n: number, answer: 'passed' | 'regressed') {
    await sql`INSERT INTO factory.quality_watches (key, issue_id, attempt, watch, started_at, window_ms, answer, answered_at)
      VALUES (${`step_watch_${issue}_${n}`}, ${issue}, ${attempt}, ${n}, ${base}, 0, ${answer}, ${base})`
  }

  async function closed(issue: string, version: number, outcome: 'done' | 'dropped' | 'cancelled') {
    await sql`UPDATE factory.issues SET state = 'closed', outcome = ${outcome} WHERE id = ${issue}`
    await put(issue, version, 'closed', at(120), { outcome }, 'working', 'closed')
  }

  async function spend(id: number, claude: string, cost: number) {
    await sql`INSERT INTO usage.sessions VALUES (${id}, ${claude}, NULL)`
    await sql`INSERT INTO usage.records_unique VALUES (${id}, ${cost})`
  }

  beforeAll(async () => {
    await sql`DROP SCHEMA IF EXISTS usage CASCADE`
    await sql`CREATE SCHEMA usage`
    await sql`CREATE TABLE usage.sessions (id bigint PRIMARY KEY, source_session_id text, issue_id text)`
    await sql`CREATE TABLE usage.records_unique (session_id bigint, cost_usd numeric)`

    // light Issues: one moves up for each sign and the lead row finishes it, one regresses again after its move, one passes
    await filed('issue_101', null)
    await lead('issue_101', 2, 1, LIGHT_SEAT)
    await moved('issue_101', 3, 30, 'the light lead said the work is beyond its seat: the parser is out of reach')
    await lead('issue_101', 4, 2, LEAD_SEAT)
    await closed('issue_101', 5, 'done')

    await filed('issue_102', null)
    await lead('issue_102', 2, 1, LIGHT_SEAT)
    await watch('issue_102', 1, 1, 'regressed')
    await moved('issue_102', 3, 90, 'the light lead’s change regressed on its first watch')
    await lead('issue_102', 4, 2, LEAD_SEAT)
    await watch('issue_102', 2, 2, 'regressed')
    await closed('issue_102', 5, 'dropped')

    await filed('issue_103', null)
    await lead('issue_103', 2, 1, LIGHT_SEAT)
    await moved('issue_103', 3, 45, 'the light lead stalled 2 times')
    await lead('issue_103', 4, 2, LEAD_SEAT)

    await filed('issue_104', null)
    await lead('issue_104', 2, 1, LIGHT_SEAT)
    await moved('issue_104', 3, 15, 'the light lead’s ship was refused 2 times')
    await lead('issue_104', 4, 2, LEAD_SEAT)
    await closed('issue_104', 5, 'cancelled')

    await filed('issue_105', null)
    await lead('issue_105', 2, 1, LIGHT_SEAT)
    await watch('issue_105', 1, 1, 'passed')

    await filed('issue_106', null)
    await lead('issue_106', 2, 1, LEAD_SEAT)
    await watch('issue_106', 1, 1, 'passed')

    // the lead row's move-up seat: four move up to the strong row, one passes
    await filed('issue_111', MOVE_UP_SEAT)
    await lead('issue_111', 2, 1, MOVE_UP_SEAT)
    await moved('issue_111', 3, 20, 'the lead said the work is beyond its seat: out of reach', 'strong')
    await lead('issue_111', 4, 2, STRONG_SEAT)
    await closed('issue_111', 5, 'done')

    await filed('issue_112', MOVE_UP_SEAT)
    await lead('issue_112', 2, 1, MOVE_UP_SEAT)
    await moved('issue_112', 3, 40, 'the lead stalled 2 times', 'strong')
    await lead('issue_112', 4, 2, STRONG_SEAT)
    await watch('issue_112', 2, 2, 'regressed')
    await closed('issue_112', 5, 'cancelled')

    await filed('issue_113', MOVE_UP_SEAT)
    await lead('issue_113', 2, 1, MOVE_UP_SEAT)
    await watch('issue_113', 1, 1, 'regressed')
    await moved('issue_113', 3, 60, 'the lead’s change regressed on its first watch', 'strong')
    await lead('issue_113', 4, 2, STRONG_SEAT)

    await filed('issue_114', MOVE_UP_SEAT)
    await lead('issue_114', 2, 1, MOVE_UP_SEAT)
    await moved('issue_114', 3, 30, 'the lead’s ship was refused 3 times', 'strong')
    await lead('issue_114', 4, 2, STRONG_SEAT)
    await closed('issue_114', 5, 'done')

    await filed('issue_115', MOVE_UP_SEAT)
    await lead('issue_115', 2, 1, MOVE_UP_SEAT)
    await watch('issue_115', 1, 1, 'passed')
    await closed('issue_115', 3, 'done')

    // a filed seat without the move-up: its own row
    await filed('issue_116', { tier: 'opus', effort: 'high' })
    await lead('issue_116', 2, 1, { tier: 'opus', effort: 'high' })
    await watch('issue_116', 1, 1, 'passed')
    await closed('issue_116', 3, 'done')

    // dollars of the first attempts: 1, 2, 3 and 4 moved up, 10 did not
    await spend(1001, 'claude-issue_111-1', 1)
    await spend(1002, 'claude-issue_112-1', 2)
    await spend(1003, 'claude-issue_113-1', 3)
    await spend(1004, 'claude-issue_114-1', 4)
    await spend(1005, 'claude-issue_115-1', 10)
  })

  test('splits the filed Issues by tier and effort, one row per pair', async () => {
    const kpis = await readSeatKpis(sql, W2, { now: LATER, cost: null })
    expect(kpis.rows.filter((row) => row.seat === 'filed').map((row) => [row.tier, row.effort, row.issues])).toEqual([
      ['opus', 'high', 1],
      ['sonnet', 'medium', 5],
    ])
    expect(kpis.rows.find((row) => row.seat === 'light')).toMatchObject({
      tier: null,
      effort: null,
      issues: 5,
      movedUp: 4,
    })
  })

  test('counts the move-ups of each step by sign and by where the Issue ended', async () => {
    const kpis = await readSeatKpis(sql, W2, { now: LATER, cost: null })
    expect(kpis.steps.light).toEqual({
      moved: 4,
      bySign: { outOfDepth: 1, regressed: 1, stalled: 1, refusedShips: 1 },
      outcomes: { done: 1, dropped: 2, regressedAfter: 1, open: 1 },
    })
    expect(kpis.steps.lead).toEqual({
      moved: 4,
      bySign: { outOfDepth: 1, regressed: 1, stalled: 1, refusedShips: 1 },
      outcomes: { done: 2, dropped: 1, regressedAfter: 1, open: 1 },
    })
  })

  test('delivers the lead row’s move-up seat: first pass, move-ups with their cost and minutes, regressions', async () => {
    const kpis = await readSeatKpis(sql, W2, { now: LATER, cost: null })
    const { leadMoveUp, lead } = kpis.delivery
    // the first watches that shipped on the move-up seat: one regressed (issue_113), one passed (issue_115)
    expect(leadMoveUp).toMatchObject({
      issues: 5,
      finishedWatches: 2,
      finishedPassRate: 0.5,
      movedUp: 4,
      regressions: 2,
      regressionsPerIssue: 0.4,
      cost: null,
      costPerIssue: null,
    })
    expect(leadMoveUp.movedUpShare).toBeCloseTo(0.8)
    // the moved-up attempts ran 20, 40, 60 and 30 minutes; their dollars 1 + 2 + 3 + 4 over the five Issues
    expect(leadMoveUp.movedUpMs).toBe(37.5 * MIN)
    expect(leadMoveUp.movedUpCost).toBeCloseTo(2)
    expect(lead).toMatchObject({ issues: 1, movedUp: 0, movedUpShare: null })
  })
})
