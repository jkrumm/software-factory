import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import type { SQL } from 'bun'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { readAttemptSeats, readInferredEdges } from '../../src/read/kpis-attempts.ts'

/**
 * The by-attempt-seat table and the inferred-edge figures over a real Postgres, each expectation worked out by hand from
 * one fixture. The `usage` schema is another component's: it is created after the first read to show cost as unmeasured
 * without it and priced with it.
 */
let db: TestCluster
let sql: SQL
const NOW = new Date('2026-11-17T12:00:00Z')
const ago = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000)
const W = { from: ago(7 * 24), to: NOW }

async function attempt(issue: string, n: number, tier: string | null, effort: string | null, startedAt: Date) {
  await sql`INSERT INTO factory.lead_attempts (issue_id, attempt, branch, first_try_at, started_at, tier, effort)
    VALUES (${issue}, ${n}, ${`factory/${issue}-${n}`}, ${startedAt}, ${startedAt}, ${tier}, ${effort})`
}

async function watch(issue: string, n: number, answer: 'passed' | 'regressed' | 'ended' | null) {
  await sql`INSERT INTO factory.quality_watches (key, issue_id, attempt, watch, started_at, window_ms, answer, answered_at)
    VALUES (${`w:${issue}:${n}`}, ${issue}, ${n}, 1, ${ago(5)}, 0, ${answer}, ${answer === null ? null : ago(4)})`
}

async function hook(issue: string, n: number, claude: string) {
  await sql`INSERT INTO factory.lead_hook_events (key, session, issue_id, attempt, kind, at, received_at, payload)
    VALUES (${`lead-${issue}-${n}:${claude}`}, ${`lead-${issue}-${n}`}, ${issue}, ${n}, 'session_started', ${ago(5)}, ${ago(5)},
      ${{ claudeSessionId: claude }})`
}

beforeAll(async () => {
  db = await startTestCluster()
  sql = db.sql
  await migrate(sql, await loadMigrations())
  for (const n of [1, 2, 3, 4]) {
    await sql`INSERT INTO factory.issues (id, repo, state, version) VALUES (${`issue_${n}`}, 'app', 'working', 1)`
  }
  // issue_1: attempt 1 haiku/high ships, watch passes. issue_2: attempt 1 haiku/high regresses, attempt 2 sonnet/high
  // retries (no watch). issue_3: sonnet/high passes. issue_4: an attempt from before the seat was stored, and one outside
  // the window.
  await attempt('issue_1', 1, 'haiku', 'high', ago(30))
  await watch('issue_1', 1, 'passed')
  await attempt('issue_2', 1, 'haiku', 'high', ago(28))
  await watch('issue_2', 1, 'regressed')
  await attempt('issue_2', 2, 'sonnet', 'high', ago(20))
  await attempt('issue_3', 1, 'sonnet', 'high', ago(10))
  await watch('issue_3', 1, 'passed')
  await attempt('issue_4', 1, null, null, ago(9))
  await attempt('issue_4', 2, 'sonnet', 'high', ago(24 * 20))
})

afterAll(async () => {
  await db.stop()
})

describe('by attempt seat', () => {
  test('groups the window by stored seat, splits first passes by the attempt that shipped, and leaves cost unmeasured without usage', async () => {
    const rows = await readAttemptSeats(sql, W, { timeoutMs: 5_000 })
    expect(rows).toEqual([
      {
        tier: 'haiku',
        effort: 'high',
        attempts: 2,
        issues: 2,
        firstWatches: 2,
        firstPassRate: 0.5,
        cost: null,
        costPerIssue: null,
      },
      {
        tier: 'sonnet',
        effort: 'high',
        attempts: 2,
        issues: 2,
        firstWatches: 1,
        firstPassRate: 1,
        cost: null,
        costPerIssue: null,
      },
    ])
  })

  test('prices each attempt by the Claude sessions its hooks reported, subagents included', async () => {
    await hook('issue_1', 1, 'claude-1')
    await hook('issue_2', 1, 'claude-2a')
    await hook('issue_2', 2, 'claude-2b')
    await hook('issue_3', 1, 'claude-3')
    await sql`CREATE SCHEMA usage`
    await sql`CREATE TABLE usage.sessions (id bigint PRIMARY KEY, source_session_id text, issue_id text)`
    await sql`CREATE TABLE usage.records_unique (session_id bigint, cost_usd numeric)`
    await sql`INSERT INTO usage.sessions VALUES (1, 'claude-1', NULL), (2, 'claude-1:agent', NULL), (3, 'claude-2a', NULL),
      (4, 'claude-2b', NULL), (5, 'claude-3', NULL), (6, 'claude-unreported', '1')`
    await sql`INSERT INTO usage.records_unique VALUES (1, 1.0), (2, 0.5), (3, 2.0), (4, 3.0), (5, 4.0), (6, 100)`
    const rows = await readAttemptSeats(sql, W, { timeoutMs: 5_000 })
    // haiku: issue_1 1.5 + issue_2 attempt 1 2.0 = 3.5 over 2 Issues; sonnet: issue_2 attempt 2 3.0 + issue_3 4.0 = 7 over 2
    expect(rows.map((r) => [r.tier, r.cost, r.costPerIssue])).toEqual([
      ['haiku', 3.5, 1.75],
      ['sonnet', 7, 3.5],
    ])
  })

  test('is empty with no attempt in the window', async () => {
    expect(await readAttemptSeats(sql, { from: ago(1), to: NOW })).toEqual([])
  })
})

describe('inferred edges', () => {
  test("counts the window's inferred edges as needed, not needed (with the idle hours) or open, and ignores stated ones", async () => {
    for (const n of [5, 6, 7, 8, 9, 10]) {
      await sql`INSERT INTO factory.issues (id, repo, state, version) VALUES (${`issue_${n}`}, 'app', 'queued', 1)`
    }
    const edge = (
      issue: string,
      after: number,
      createdAt: Date,
      satisfiedAt: Date | null,
      readySince: Date | null,
      by: string | null,
    ) =>
      sql`INSERT INTO factory.planning_edges (issue_id, after_issue, created_at, satisfied_at, ready_since, inferred_by)
        VALUES (${issue}, ${`issue_${after}`}, ${createdAt}, ${satisfiedAt}, ${readySince}, ${by})`
    await edge('issue_5', 1, ago(40), ago(30), null, 'triage: names it')
    await edge('issue_6', 1, ago(40), ago(30), ago(34), 'triage: names it') // ready 4 h
    await edge('issue_7', 1, ago(40), ago(30), ago(32), 'queue: same repo') // ready 2 h
    await edge('issue_8', 1, ago(40), null, null, 'triage: names it') // open
    await edge('issue_9', 1, ago(40), ago(30), ago(33), null) // stated: not counted
    await edge('issue_10', 1, ago(24 * 20), ago(24 * 19), null, 'triage: names it') // before the window
    expect(await readInferredEdges(sql, W)).toEqual({
      total: 4,
      open: 1,
      needed: 1,
      notNeeded: 2,
      neededShare: 1 / 3,
      idleHours: 6,
    })
  })

  test('has no share with nothing settled', async () => {
    expect(await readInferredEdges(sql, { from: ago(1), to: NOW })).toEqual({
      total: 0,
      open: 0,
      needed: 0,
      notNeeded: 0,
      neededShare: null,
      idleHours: 0,
    })
  })
})
