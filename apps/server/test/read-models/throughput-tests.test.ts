import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import type { SQL } from 'bun'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { readThroughput } from '../../src/read/throughput.ts'

/**
 * Test runs per project, failed-run minutes and flaky tests, over seeded `step_costs` and `test_results` rows. A flake is a
 * test with both results at one commit in clean-tree runs; the failed-run minutes are restated in plain SQL over `step_costs`.
 */
let db: TestCluster
let sql: SQL
const NOW = new Date('2026-11-07T12:00:00Z')
const at = (hhmm: string, day = '11-07'): Date => new Date(`2026-${day}T${hhmm}:00Z`)

beforeAll(async () => {
  db = await startTestCluster()
  sql = db.sql
  await migrate(sql, await loadMigrations())
  await seed()
})
afterAll(() => db.stop())

type Status = 'pass' | 'fail' | 'skip'

async function run(input: {
  at: Date
  repo: string | null
  exit: number | null
  ms: number
  commit?: string
  dirty?: boolean
  results?: [suite: string, name: string, status: Status][]
}): Promise<void> {
  const [row] = await sql`
    INSERT INTO factory.step_costs (at, name, repo, duration_ms, wait_ms, exit_code, vcs_ref_head_revision, dirty)
    VALUES (${input.at}, 'app check', ${input.repo}, ${input.ms}, 0, ${input.exit}, ${input.commit ?? null}, ${input.dirty ?? null})
    RETURNING id`
  for (const [suite, name, status] of input.results ?? [])
    await sql`
      INSERT INTO factory.test_results (step_cost_id, at, repo, vcs_ref_head_revision, dirty, test_suite_name, test_case_name,
        test_case_result_status, duration_ms)
      VALUES (${row.id}, ${input.at}, ${input.repo}, ${input.commit ?? null}, ${input.dirty ?? null}, ${suite}, ${name}, ${status}, 5)`
}

async function seed() {
  // commit c1: T fails then passes (a flake), V passes twice, W fails twice (broken, not flaky)
  await run({
    at: at('09:00'),
    repo: 'app',
    exit: 1,
    ms: 600_000,
    commit: 'c1',
    dirty: false,
    results: [
      ['t.test.ts', 'T', 'fail'],
      ['t.test.ts', 'V', 'pass'],
      ['t.test.ts', 'W', 'fail'],
    ],
  })
  await run({
    at: at('09:30'),
    repo: 'app',
    exit: 1,
    ms: 300_000,
    commit: 'c1',
    dirty: false,
    results: [
      ['t.test.ts', 'T', 'pass'],
      ['t.test.ts', 'V', 'pass'],
      ['t.test.ts', 'W', 'fail'],
      // a test twice in one run with both results is one failed result of that run, not a flake by itself
      ['u.test.ts', 'X', 'pass'],
      ['u.test.ts', 'X', 'fail'],
    ],
  })
  // commit c2: single runs: no pair
  await run({
    at: at('10:00'),
    repo: 'app',
    exit: 0,
    ms: 300_000,
    commit: 'c2',
    dirty: false,
    results: [
      ['t.test.ts', 'T', 'pass'],
      ['u.test.ts', 'Y', 'skip'],
    ],
  })
  // a dirty tree is not the same code: no flake evidence
  await run({
    at: at('10:30'),
    repo: 'app',
    exit: 1,
    ms: 120_000,
    commit: 'c3',
    dirty: true,
    results: [['t.test.ts', 'Z', 'fail']],
  })
  await run({
    at: at('10:45'),
    repo: 'app',
    exit: 0,
    ms: 60_000,
    commit: 'c3',
    dirty: true,
    results: [['t.test.ts', 'Z', 'pass']],
  })
  // not failed: no exit code read; another project; no project; outside the window and at its end
  await run({ at: at('11:00'), repo: 'app', exit: null, ms: 60_000 })
  await run({ at: at('11:10'), repo: 'lib', exit: 0, ms: 90_000 })
  await run({ at: at('11:15'), repo: null, exit: 1, ms: 45_000 })
  await run({
    at: at('11:00', '11-05'),
    repo: 'app',
    exit: 1,
    ms: 999_000,
    commit: 'c0',
    dirty: false,
    results: [['t.test.ts', 'T', 'fail']],
  })
  await run({ at: NOW, repo: 'app', exit: 1, ms: 888_000 })
}

const read = () => readThroughput(sql, { now: NOW, hours: 24 })

describe('readThroughput tests', () => {
  test('runs and failed-run minutes per project match step_costs', async () => {
    const { byProject } = (await read()).tests
    expect(byProject.map((p) => p.repo)).toEqual(['app', 'lib'])
    const app = byProject[0]
    expect(app).toMatchObject({ runs: 6, failedRuns: 3, runMinutes: 24, failedRunMinutes: 17, testResults: 12 })
    expect(byProject[1]).toMatchObject({
      runs: 1,
      failedRuns: 0,
      runMinutes: 1.5,
      failedRunMinutes: 0,
      testResults: 0,
      flakyTests: 0,
      flakeRate: null,
    })
    // restated in plain SQL, another shape
    for (const p of byProject) {
      const [row] = await sql`
        SELECT (SELECT coalesce(sum(duration_ms), 0) / 60000.0 FROM factory.step_costs s
                WHERE s.repo = ${p.repo} AND s.at >= ${new Date(NOW.getTime() - 86_400_000)} AND s.at < ${NOW}
                  AND s.exit_code IS DISTINCT FROM 0 AND s.exit_code IS NOT NULL)::float8 AS failed_minutes`
      expect(p.failedRunMinutes).toBeCloseTo(Number(row.failed_minutes), 1)
    }
  })

  test('the flake rate is the flaky (test, commit) pairs over the pairs seen in two or more clean runs', async () => {
    const [app] = (await read()).tests.byProject
    // pairs with two runs: (T,c1) flaky, (V,c1) passes, (W,c1) fails, (X,c1) one run only; dirty Z does not count
    expect(app?.flakyTests).toBe(1)
    expect(app?.flakeRate).toBeCloseTo(1 / 3, 3)
  })

  test('a seeded flaky test is named, with when it first showed both results; a broken one is not', async () => {
    const { flaky } = (await read()).tests
    expect(flaky).toEqual([
      {
        repo: 'app',
        suite: 't.test.ts',
        name: 'T',
        flakyCommits: 1,
        runs: 2,
        failures: 1,
        firstFlakeAt: at('09:30').toISOString(),
        lastFlakeAt: at('09:30').toISOString(),
      },
    ])
  })

  test('a window that holds no run is empty', async () => {
    const empty = await readThroughput(sql, { now: new Date('2026-10-01T00:00:00Z'), hours: 24 })
    expect(empty.tests).toEqual({ byProject: [], flaky: [] })
  })
})
