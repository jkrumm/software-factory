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
})
