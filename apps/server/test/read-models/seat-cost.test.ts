import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import type { SQL } from 'bun'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { readSeatCost, type SeatCostReading, seatCostLine } from '../../src/read/seat-cost.ts'

/**
 * The seat cost over a real Postgres, worked out by hand from one fixture: two Issues whose first lead ran on opus (filed
 * with an opus seat; 15 and 20 dollars, 60 and 120 working minutes), three that started on the lead row (2, 4 and 6 dollars,
 * 30, 40 and 50 minutes), one light Issue and one opus Issue outside the window. The `usage` schema is another component's:
 * it is created here, and dropped for the read that must come back null.
 */
let db: TestCluster
let sql: SQL
const NOW = new Date('2026-11-17T12:00:00Z')
const MIN = 60_000
const DAY = 24 * 3_600_000
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY)
const LIGHT = { tier: 'haiku', effort: 'high', role: 'light', rule: 'hygiene:links' }
const LEAD = { tier: 'sonnet', effort: 'high', role: 'lead' }
const OPUS = { tier: 'opus', effort: 'high' }

let events = 0
let spends = 0

async function event(
  issue: string,
  version: number,
  kind: string,
  at: Date,
  payload: Record<string, unknown>,
  from: string | null,
  to: string,
) {
  events += 1
  await sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, from_state, to_state)
    VALUES (${`cost_${events}`}, ${issue}, ${`cost_key_${events}`}, ${kind}, ${payload}, 'factory', ${at}, 'applied', ${version}, ${from}, ${to})`
}

/** An Issue whose first lead ran on `seat` (filed with it when `filed`), one lead attempt per cost, working `minutes`. */
async function issue(
  id: string,
  spec: { at: Date; seat: Record<string, unknown>; filed: boolean; costs: number[]; minutes: number },
) {
  await sql`INSERT INTO factory.issues (id, repo, state, version) VALUES (${id}, 'app', 'working', 3)`
  await event(id, 1, 'filed', spec.at, spec.filed ? { seat: spec.seat } : {}, null, 'settling')
  for (const [index, cost] of spec.costs.entries()) {
    const attempt = index + 1
    await event(
      id,
      index + 2,
      'lead_started',
      spec.at,
      { attempt, terminal: 't', seat: spec.seat },
      'working',
      'working',
    )
    await sql`INSERT INTO factory.lead_hook_events (key, session, issue_id, attempt, kind, at, received_at, payload)
      VALUES (${`hook_${id}_${attempt}`}, ${`lead-${id}-${attempt}`}, ${id}, ${attempt}, 'session_started', ${spec.at}, ${spec.at}, ${{ claudeSessionId: `claude-${id}-${attempt}` }})`
    spends += 1
    await sql`INSERT INTO usage.sessions VALUES (${spends}, ${`claude-${id}-${attempt}`}, NULL)`
    await sql`INSERT INTO usage.records_unique VALUES (${spends}, ${cost})`
  }
  await event(
    id,
    spec.costs.length + 2,
    'closed',
    new Date(spec.at.getTime() + spec.minutes * MIN),
    {},
    'working',
    'closed',
  )
}

beforeAll(async () => {
  db = await startTestCluster()
  sql = db.sql
  await migrate(sql, await loadMigrations())
  await sql`CREATE SCHEMA usage`
  await sql`CREATE TABLE usage.sessions (id bigint PRIMARY KEY, source_session_id text, issue_id text)`
  await sql`CREATE TABLE usage.records_unique (session_id bigint, cost_usd numeric)`
  await issue('issue_1', { at: daysAgo(2), seat: OPUS, filed: true, costs: [10, 5], minutes: 60 })
  await issue('issue_2', { at: daysAgo(3), seat: OPUS, filed: true, costs: [20], minutes: 120 })
  await issue('issue_3', { at: daysAgo(1), seat: LEAD, filed: false, costs: [2], minutes: 30 })
  await issue('issue_4', { at: daysAgo(1), seat: LEAD, filed: false, costs: [4], minutes: 40 })
  await issue('issue_5', { at: daysAgo(4), seat: LEAD, filed: false, costs: [6], minutes: 50 })
  await issue('issue_6', { at: daysAgo(2), seat: LIGHT, filed: false, costs: [100], minutes: 10 })
  await issue('issue_7', { at: daysAgo(10), seat: OPUS, filed: true, costs: [1000], minutes: 5 })
})

afterAll(async () => {
  await db.stop()
})

describe('the seat cost of a tier and of the lead row', () => {
  test('prices every attempt of the Issues, with the median working time, over the last seven days', async () => {
    const reading = await readSeatCost(sql, { tier: 'opus', now: NOW })
    expect(reading).toEqual({
      tier: { issues: 2, costPerIssue: 17.5, medianWorkingMs: 90 * MIN },
      lead: { issues: 3, costPerIssue: 4, medianWorkingMs: 40 * MIN },
    })
    if (reading === null) throw new Error('the usage schema is there: a reading')
    expect(seatCostLine('opus', reading)).toBe(
      'opus seats, last 7 days: 17.50 dollars an Issue, median 90 working minutes (2 Issues); the lead row: 4.00 dollars, 40 minutes (3 Issues)',
    )
  })

  test('is null when the usage schema cannot be read', async () => {
    await sql`DROP SCHEMA usage CASCADE`
    expect(await readSeatCost(sql, { tier: 'opus', now: NOW })).toBeNull()
  })
})

describe('the seat cost line', () => {
  const empty = { issues: 0, costPerIssue: null, medianWorkingMs: null }

  test('leaves out a figure that is null, and a clause with none', () => {
    const cost: SeatCostReading = { tier: { issues: 4, costPerIssue: null, medianWorkingMs: 9 * MIN }, lead: empty }
    expect(seatCostLine('haiku', cost)).toBe('haiku seats, last 7 days: median 9 working minutes (4 Issues)')
    expect(seatCostLine('opus', { tier: empty, lead: { issues: 3, costPerIssue: 4, medianWorkingMs: 40 * MIN } })).toBe(
      'the lead row: 4.00 dollars, 40 minutes (3 Issues)',
    )
  })

  test('is null with no figure at all', () => {
    expect(seatCostLine('opus', { tier: empty, lead: empty })).toBeNull()
  })
})
