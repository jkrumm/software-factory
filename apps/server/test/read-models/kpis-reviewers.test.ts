import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import type { SQL } from 'bun'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { readReviewerKpis, reviewerTakesAll } from '../../src/read/kpis-reviewers.ts'

/**
 * The two reviewer seats side by side over a real Postgres, from the review evidence of accepted ships and the first
 * watches, every expectation worked out by hand from one fixture.
 */
let db: TestCluster
let sql: SQL
const NOW = new Date('2026-11-17T12:00:00Z')
const ago = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000)
const W = { from: ago(7 * 24), to: NOW }
const table = { cheap: { tier: 'haiku', effort: 'high' }, reviewer: { tier: 'sonnet', effort: 'medium' } } as const

const thread = (
  role: string,
  tier: string,
  rounds: number,
  wallMs: number,
  total: number,
  applied: number,
  declined: number,
) => ({
  thread: `t-${Math.random()}`,
  key: 'factory-1',
  job: 'rv',
  tier,
  rounds,
  outcome: 'clean',
  seat: { role, tier: role === 'reviewer-cheap' ? 'haiku' : 'sonnet', effort: 'medium' },
  routed: null,
  wallMs,
  findings: { total, important: 0, applied, declined, open: total - applied - declined },
})

async function reviewed(n: number, assigned: string | null, threads: object[], first: 'passed' | 'regressed' | null) {
  const id = `issue_${n}`
  await sql`INSERT INTO factory.issues (id, repo, state, version) VALUES (${id}, 'app', 'working', 1)`
  const payload = { kind: 'review', status: 'covered', ...(assigned ? { reviewer: assigned, threads } : {}) }
  await sql`INSERT INTO factory.quality_evidence (id, issue_id, attempt, source_key, kind, at, payload)
    VALUES (${`ev_${n}`}, ${id}, 1, ${`ship_${n}`}, 'review', ${ago(10)}, ${JSON.stringify(payload)}::text::jsonb)`
  if (first)
    await sql`INSERT INTO factory.quality_watches (key, issue_id, attempt, watch, started_at, window_ms, answer, answered_at)
      VALUES (${`w:${n}`}, ${id}, 1, 1, ${ago(9)}, 0, ${first}, ${ago(8)})`
}

beforeAll(async () => {
  db = await startTestCluster()
  sql = db.sql
  await migrate(sql, await loadMigrations())
  await reviewed(1, 'reviewer-cheap', [thread('reviewer-cheap', 'standard', 2, 40_000, 3, 2, 1)], 'passed')
  await reviewed(2, 'reviewer-cheap', [thread('reviewer-cheap', 'light', 1, 20_000, 0, 0, 0)], 'regressed')
  await reviewed(3, 'reviewer', [thread('reviewer', 'standard', 1, 10_000, 2, 2, 0)], 'passed')
  // a cheap Issue whose only review was deep: it ran on the reviewer row and tested neither seat's Issues
  await reviewed(4, 'reviewer-cheap', [thread('reviewer', 'deep', 3, 90_000, 4, 4, 0)], 'passed')
  // a ship from before the seat was recorded counts for nothing
  await reviewed(5, null, [], 'passed')
})

afterAll(async () => {
  await db.stop()
})

describe('the reviewer seats', () => {
  test('each seat’s row: reviews, findings, applied against declined, rounds, first pass, regressions and wall time', async () => {
    const { rows, startShare } = await readReviewerKpis(sql, W, { now: NOW, table, cost: null })
    expect(startShare).toBe(0.5)
    expect(rows.find((row) => row.seat === 'cheap')).toEqual({
      seat: 'cheap',
      role: 'reviewer-cheap',
      tier: 'haiku',
      effort: 'high',
      reviews: 2,
      deepReviews: 0,
      findings: 3,
      findingsPerReview: 1.5,
      applied: 2,
      declined: 1,
      appliedShare: 2 / 3,
      roundsPerReview: 1.5,
      issues: 2,
      firstWatches: 2,
      firstPassRate: 0.5,
      regressedIssues: 1,
      regressionRate: 0.5,
      costPerReview: null,
      wallP50Ms: 30_000,
    })
    expect(rows.find((row) => row.seat === 'plain')).toMatchObject({
      role: 'reviewer',
      tier: 'sonnet',
      reviews: 1,
      deepReviews: 1,
      findingsPerReview: 2,
      appliedShare: 1,
      issues: 1,
      firstWatches: 1,
      firstPassRate: 1,
      regressionRate: 0,
      wallP50Ms: 10_000,
    })
  })

  test('cost per review divides each seat’s reviewer dollars by its reviews, deep ones included', async () => {
    const { rows } = await readReviewerKpis(sql, W, { now: NOW, table, cost: async () => ({ cheap: 1, plain: 3 }) })
    expect(rows.find((row) => row.seat === 'cheap')?.costPerReview).toBe(0.5)
    expect(rows.find((row) => row.seat === 'plain')?.costPerReview).toBe(1.5)
  })

  test('the tripwire shows its inputs and, with two reviews of a seat, takes nothing over', async () => {
    const { tripwire } = await readReviewerKpis(sql, W, { now: NOW, table, cost: null })
    expect(tripwire).toMatchObject({
      minReviews: 100,
      points: 2,
      windowDays: 3,
      windowMinIssues: 10,
      cheap: { reviews: 2, issues: 2, firstPassRate: 0.5, regressionRate: 0.5 },
      plain: { reviews: 1, issues: 1, firstPassRate: 1, regressionRate: 0 },
      window: { reviews: 2, issues: 2 },
      enough: false,
      windowBreaks: null,
      takesAll: false,
    })
    expect(await reviewerTakesAll(sql, NOW)).toBe(false)
  })

  test('a window that holds none of the ships shows empty rows, never a failure', async () => {
    const { rows } = await readReviewerKpis(
      sql,
      { from: ago(48 * 24), to: ago(30 * 24) },
      { now: NOW, table, cost: null },
    )
    expect(rows.map((row) => [row.reviews, row.findingsPerReview, row.firstPassRate])).toEqual([
      [0, null, null],
      [0, null, null],
    ])
  })
})
