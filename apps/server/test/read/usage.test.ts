import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { deriveSession } from '../../src/domains/leads/session.ts'
import { fixedClock } from '../../src/kernel/clock.ts'
import { createReader, type ReadApi } from '../../src/read/reader.ts'

/**
 * An Issue's insights join the `usage` schema, which another component owns: tokens, cost, models and subagents of the
 * sessions its leads reported (with their `<session>:<agent>` subagents) and of the sessions tagged with its number.
 */
const NOW = '2026-11-07T12:00:00.000Z'
const ENDED = '2026-11-07T11:00:00.000Z'

let db: TestCluster
let read: ReadApi

const SESSIONS = `CREATE TABLE usage.sessions (id bigint PRIMARY KEY, source_session_id text, issue_id text)`
const RECORDS = `CREATE TABLE usage.records_unique (
  session_id bigint, model text, input_tokens bigint, output_tokens bigint, cache_read_tokens bigint,
  cache_write_5m_tokens bigint, cache_write_1h_tokens bigint, cost_usd numeric)`

beforeAll(async () => {
  db = await startTestCluster()
  await db.sql`DROP SCHEMA IF EXISTS factory CASCADE`
  await migrate(db.sql, await loadMigrations())
  const { sql } = db
  await sql`INSERT INTO factory.planning_projects (name, repo, source, project) VALUES ('argo', '/src/argo', 'file', '{}')`
  for (const n of [1, 2]) {
    await sql`INSERT INTO factory.issues (id, repo, state, outcome, version) VALUES (${`issue_${n}`}, 'argo', 'closed', 'done', 1)`
    await sql`
      INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, to_state)
      VALUES (${`event_${n}`}, ${`issue_${n}`}, ${`k${n}`}, 'filed', ${{ repo: 'argo', title: `Issue ${n}`, kind: 'bug', origin: 'you' }},
        'factory', ${NOW}, 'applied', 1, 'settling')`
    await sql`
      INSERT INTO factory.lead_attempts (issue_id, attempt, branch, account, terminal, tab, space, first_try_at, started_at, gone_at)
      VALUES (${`issue_${n}`}, 1, ${`factory/${n}-1`}, 'max1', 't', 'tab', '/src/argo', ${NOW}, ${NOW}, ${ENDED})`
    await sql`
      INSERT INTO factory.lead_hook_events (key, session, issue_id, attempt, kind, at, received_at, payload)
      VALUES (${`lead-${n}-1:session_started`}, ${`lead-${n}-1`}, ${`issue_${n}`}, 1, 'session_started', ${NOW}, ${NOW},
        ${{ claudeSessionId: `claude-${n}` }}),
        (${`lead-${n}-1:turn_started`}, ${`lead-${n}-1`}, ${`issue_${n}`}, 1, 'turn_started', ${NOW}, ${NOW}, '{}'::jsonb)`
  }
  read = createReader({
    sql,
    clock: fixedClock(NOW),
    deriveSession,
    loops: () => [],
    doorLines: async () => [],
    blockedStreak: 3,
    mainCheckouts: () => [],
    macbookProbe: true,
    maxRunTries: 2,
    streamPollMs: 20,
    usageTimeoutMs: 5_000,
  })
})

afterAll(async () => {
  await db.stop()
})

const detail = async (id: string) => {
  const issue = await read.issue({ id, redact: false })
  if (!issue) throw new Error('no such Issue')
  return issue
}

describe('insights from the usage schema', () => {
  test('the schema absent: every figure is unmeasured and the Issue is partial', async () => {
    const issue = await detail('issue_1')
    expect(issue.insights).toMatchObject({ cost: null, partial: true, subagents: 0, models: [] })
    expect(issue.insights.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(issue.sessions[0]?.insights.cost).toBeNull()
  })

  test('a finished Issue sums its attempt, its subagents and the sessions tagged with it, and is not partial', async () => {
    const { sql } = db
    await sql`CREATE SCHEMA usage`
    await sql.unsafe(SESSIONS)
    await sql.unsafe(RECORDS)
    await sql`INSERT INTO usage.sessions VALUES
      (1, 'claude-1', '1'), (2, 'claude-1:agent-a', '1'), (3, 'claude-1:agent-b', NULL),
      (4, 'tagged-only', '1'), (5, 'claude-2', '2'), (6, 'foreign', '999')`
    await sql`INSERT INTO usage.records_unique VALUES
      (1, 'claude-sonnet-5-5', 100, 20, 1000, 30, 40, 1.5),
      (1, 'claude-sonnet-5-5', 10, 2, 100, 3, 4, 0.5),
      (2, 'claude-haiku-5-5', 5, 6, 7, 8, 9, 0.25),
      (3, 'claude-haiku-5-5', 1, 1, 1, 1, 1, 0.25),
      (4, 'claude-opus-5-5', 2, 2, 2, 2, 2, 1.0),
      (5, 'claude-sonnet-5-5', 77, 77, 77, 77, 77, 9),
      (6, 'claude-opus-5-5', 999, 999, 999, 999, 999, 99)`
    const issue = await detail('issue_1')
    expect(issue.insights).toMatchObject({
      partial: false,
      cost: 3.5,
      subagents: 2,
      toolCalls: null,
      models: ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'],
      tokens: { input: 118, output: 31, cacheRead: 1110, cacheWrite: 30 + 40 + 3 + 4 + 8 + 9 + 1 + 1 + 2 + 2 },
    })
    // the attempt holds what its Claude session and subagents ran; the tagged-only session is the Issue's alone
    expect(issue.sessions).toHaveLength(1)
    expect(issue.sessions[0]?.insights).toMatchObject({ partial: false, subagents: 2, cost: 2.5 })
    expect(issue.sessions[0]?.insights.tokens.input).toBe(116)
    const other = await detail('issue_2')
    expect(other.insights).toMatchObject({ cost: 9, subagents: 0, models: ['claude-sonnet-5-5'] })
  })

  test('an Issue whose turns have no usage row yet is partial, with zeros and a cost of zero', async () => {
    const { sql } = db
    await sql`DELETE FROM usage.records_unique WHERE session_id = 5`
    await sql`DELETE FROM usage.sessions WHERE id = 5`
    const issue = await detail('issue_2')
    expect(issue.insights).toMatchObject({ partial: true, cost: 0 })
    expect(issue.insights.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })

  test('window points come with the Issue read, not with the list', async () => {
    const { sql } = db
    await sql`CREATE TABLE usage.session_window_share (account text, session_id bigint, five_hour_pct float8, seven_day_pct float8)`
    await sql`INSERT INTO usage.session_window_share VALUES ('a', 1, 1.5, 4), ('a', 2, 0.5, 1), ('a', 4, 2, 2)`
    expect((await detail('issue_1')).insights.windowPoints).toBe(4)
    const list = await read.issues({ scope: 'all', redact: false })
    expect(list.find((card) => card.id === 1)?.insights).toMatchObject({ cost: 3.5, windowPoints: null })
  })

  test('a column the role cannot read leaves the Issue partial, never failing the read', async () => {
    const { sql } = db
    await sql`ALTER TABLE usage.records_unique RENAME COLUMN cost_usd TO price`
    const issue = await detail('issue_1')
    expect(issue.insights).toMatchObject({ partial: true, cost: null })
    await sql`DROP SCHEMA usage CASCADE`
  })
})
