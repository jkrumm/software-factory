import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { RetroModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import type { SQL } from 'bun'
import { githubCiTimes } from '../../src/adapters/selfwatch/github.ts'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { ok } from '../../src/kernel/result.ts'
import { readRetro } from '../../src/read/retro.ts'
import { readRetroBuild } from '../../src/read/retro-build.ts'

/** The retro's build half: local check minutes from the slot steps against plain SQL, CI times from a fake GitHub. */
let db: TestCluster
let sql: SQL
const NOW = new Date('2026-11-07T12:00:00Z')
const DAYS = 7
const FROM = new Date(NOW.getTime() - DAYS * 24 * 3_600_000)
const ago = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000)
const MIN = 60_000

let keys = 0
const closed = (issue: string, repo: string, at: Date) => sql`
  WITH i AS (INSERT INTO factory.issues (id, repo, state, outcome, version) VALUES (${issue}, ${repo}, 'closed', 'done', 2))
  INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, from_state, to_state)
  VALUES (${`event_${++keys}`}, ${issue}, ${`key_${keys}`}, 'closed', '{}'::jsonb, 'factory', ${at}, 'applied', 2, 'working', 'closed')`
const step = (repo: string | null, name: string, minutes: number, waitMs: number, at: Date) => sql`
  INSERT INTO factory.step_costs (at, name, repo, duration_ms, wait_ms)
  VALUES (${at}, ${name}, ${repo}, ${minutes * MIN}, ${waitMs})`

beforeAll(async () => {
  db = await startTestCluster()
  sql = db.sql
  await migrate(sql, await loadMigrations())
  // two Issues closed in `app`, one in `lib`, one before the window
  await closed('issue_1', 'app', ago(48))
  await closed('issue_2', 'app', ago(24))
  await closed('issue_3', 'lib', ago(30))
  await closed('issue_4', 'app', ago(400))
  // app: 3 `make check` runs of 2, 4 and 6 minutes, 2 lead-named `layout` runs of 10 minutes; lib: one run; a step with no repo
  for (const [i, minutes] of [2, 4, 6].entries())
    await step('/work/app', 'app make check', minutes, 1000 * (i + 1), ago(40 - i))
  for (const n of [11, 12]) await step('/work/app/', `factory-${n}-1 layout`, 10, 0, ago(20))
  await step('/work/lib', 'lib make check', 3, 600_000, ago(10))
  await step(null, 'adhoc', 99, 0, ago(10))
  await step('/work/app', 'app make check', 50, 0, ago(400))
})
afterAll(() => db.stop())

const run = (event: string, branch: string, minutes: number, attempt: number, conclusion = 'success') => ({
  event,
  head_branch: branch,
  conclusion,
  run_attempt: attempt,
  run_started_at: '2026-11-06T10:00:00Z',
  updated_at: new Date(Date.parse('2026-11-06T10:00:00Z') + minutes * MIN).toISOString(),
})

/** GitHub as `app` has it: a default branch of `main`, five finished runs and one that was cancelled; `lib` answers 500. */
function fakeGithub(seen: string[] = []): typeof fetch {
  const answer = (path: string, search: string): Response => {
    seen.push(`${path}${search}`)
    if (path === '/repos/o/app') return Response.json({ default_branch: 'main' })
    if (path === '/repos/o/app/actions/runs')
      return Response.json({
        workflow_runs: [
          run('push', 'main', 10, 1),
          run('push', 'main', 20, 1, 'failure'),
          run('pull_request', 'topic', 30, 1),
          run('pull_request', 'topic', 40, 2),
          run('push', 'topic', 99, 1),
          run('pull_request', 'topic', 1, 1, 'cancelled'),
        ],
      })
    return new Response('boom', { status: 500 })
  }
  return (async (input: Request | string | URL) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    return answer(url.pathname, url.search)
  }) as unknown as typeof fetch
}

const github = (token: string | null = 't', seen: string[] = []) =>
  githubCiTimes({
    token,
    apiUrl: 'https://api.example.test',
    locate: async (repo) => ok(`/work/${repo}`),
    run: async () => ({ exitCode: 0, stdout: 'git@github.com:o/app.git\n' }),
    fetch: fakeGithub(seen),
  })

describe('GET /v1/retro `build`', () => {
  test('the check figures match plain SQL, per repo and per step, with the lead prefix dropped', async () => {
    const { build } = RetroModel.parse(await readRetro(sql, { now: NOW, days: DAYS }))
    expect(build.unreadable).toEqual([])
    const [row] =
      await sql`SELECT sum(duration_ms)::float8 / 60000 AS minutes, count(*)::int AS runs FROM factory.step_costs
      WHERE repo LIKE '/work/app%' AND at >= ${FROM} AND at < ${NOW}`
    const app = build.repos.find((r) => r.repo === 'app')
    expect(app?.closedIssues).toBe(2)
    expect(app?.check.runs).toBe(Number(row.runs))
    expect(app?.check.runs).toBe(5)
    expect(app?.check.totalMinutes).toBeCloseTo(Number(row.minutes), 9)
    expect(app?.check.totalMinutes).toBeCloseTo(32, 9)
    expect(app?.check.runsPerIssue).toBeCloseTo(2.5, 9)
    expect(app?.check.minutesPerIssue).toBeCloseTo(16, 9)
    expect(app?.check.waitMinutes).toBeCloseTo(6000 / MIN, 9)
    // the two `layout` runs are one step, and it ranks first by total minutes, not by its number of runs
    expect(app?.check.slowestSteps.map((s) => [s.name, s.runs, s.totalMinutes])).toEqual([
      ['layout', 2, 20],
      ['app make check', 3, 12],
    ])
    expect(app?.check.slowestSteps[1]).toMatchObject({ medianMs: 4 * MIN })
    expect(app?.check.slowestSteps[1]?.p90Ms).toBeCloseTo(5.6 * MIN, 3)
    expect(app?.ci).toBeNull()
    // a step with no repo is no repo's; `lib` has one run for its one closed Issue
    expect(build.repos.map((r) => r.repo)).toEqual(['app', 'lib'])
    expect(build.repos[1]).toMatchObject({ repo: 'lib', closedIssues: 1, minutesPerIssue: 3 })
    expect(build.figures).toEqual([
      expect.objectContaining({ key: 'check_minutes_per_issue', unit: 'minutes' }),
      expect.objectContaining({ key: 'ci_p50_minutes', value: null }),
    ])
    expect(build.figures[0]?.value).toBeCloseTo(35 / 3, 9)
  })

  test('CI times come from the finished runs; an unreadable repo is named and the rest still returns', async () => {
    const seen: string[] = []
    const model = RetroModel.parse(await readRetro(sql, { now: NOW, days: DAYS, ciTimes: github('t', seen) }))
    const { build } = model
    expect(build.unreadable).toEqual([])
    const app = build.repos.find((r) => r.repo === 'app')
    expect(app?.ci).toEqual({
      defaultBranch: { runs: 2, p50Minutes: 15, p90Minutes: 19 },
      pullRequest: { runs: 2, p50Minutes: 35, p90Minutes: 39 },
      totalMinutes: 100,
      truncated: false,
      // the cancelled run and the push to a topic branch are not counted; one of the four passed on a rerun
      flakyShare: 0.25,
    })
    expect(app?.minutesPerIssue).toBeCloseTo((32 + 100) / 2, 9)
    expect(build.figures.find((f) => f.key === 'ci_p50_minutes')?.value).toBeCloseTo(25, 9)
    expect(seen.some((p) => p.includes('status=completed') && p.includes('created=%3E%3D2026-10-31'))).toBe(true)
  })

  test('without a token, or on a bad answer, the repo is under unreadable with its check figures kept', async () => {
    const tokenless = RetroModel.parse(await readRetro(sql, { now: NOW, days: DAYS, ciTimes: github(null) })).build
    expect(tokenless.unreadable).toEqual([
      { repo: 'app', reason: 'no token' },
      { repo: 'lib', reason: 'no token' },
    ])
    expect(tokenless.repos.map((r) => [r.repo, r.ci, r.check.runs])).toEqual([
      ['app', null, 5],
      ['lib', null, 1],
    ])

    const down = githubCiTimes({
      token: 't',
      apiUrl: 'https://api.example.test',
      locate: async (repo) => ok(`/work/${repo}`),
      run: async () => ({ exitCode: 0, stdout: 'git@github.com:o/broken.git\n' }),
      fetch: fakeGithub(),
    })
    const broken = RetroModel.parse(await readRetro(sql, { now: NOW, days: DAYS, ciTimes: down })).build
    expect(broken.unreadable.map((u) => u.repo)).toEqual(['app', 'lib'])
    expect(broken.unreadable[0]?.reason).toContain('github 500')
    expect(broken.repos.find((r) => r.repo === 'app')?.check.runs).toBe(5)
  })

  test('a read that ends at the page limit is truncated; a CI read past its deadline names the repo and returns', async () => {
    const full = (): typeof fetch =>
      (async (input: Request | string | URL) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
        if (url.pathname === '/repos/o/app') return Response.json({ default_branch: 'main' })
        return Response.json({ workflow_runs: Array.from({ length: 100 }, () => run('push', 'main', 5, 1)) })
      }) as unknown as typeof fetch
    const busy = githubCiTimes({
      token: 't',
      apiUrl: 'https://api.example.test',
      locate: async (repo) => ok(`/work/${repo}`),
      run: async () => ({ exitCode: 0, stdout: 'git@github.com:o/app.git\n' }),
      fetch: full(),
    })
    const cut = await readRetroBuild(sql, { now: NOW, days: DAYS, ciTimes: busy })
    expect(cut.repos.find((r) => r.repo === 'app')?.ci).toMatchObject({ truncated: true, totalMinutes: 1500 })

    const never = () => new Promise<never>(() => undefined)
    const slow = await readRetroBuild(sql, { now: NOW, days: DAYS, ciTimes: never, ciDeadlineMs: 50 })
    expect(slow.unreadable).toEqual([
      { repo: 'app', reason: 'the CI read ran out of time' },
      { repo: 'lib', reason: 'the CI read ran out of time' },
    ])
    expect(slow.repos.map((r) => r.check.runs)).toEqual([5, 1])
  })

  test('the ledger resolves both keys to their value now', async () => {
    await sql`INSERT INTO factory.intake_signals (id, source, kind, origin, trust, repo, fingerprint, title, text, received_at, state, issue_id)
      VALUES ('signal_b1', 'agent:software-factory', 'request', 'factory', 'agent', 'app', 'b1', 'Cache installs in CI',
        ${'Retro: 2026-10-20 kpi=ci_p50_minutes before=30 direction=down'}, ${ago(400)}, 'filed', 'issue_1'),
        ('signal_b2', 'agent:software-factory', 'request', 'factory', 'agent', 'app', 'b2', 'Run affected tests',
        ${'Retro: 2026-10-20 kpi=check_minutes_per_issue before=20 direction=down'}, ${ago(400)}, 'filed', 'issue_2')`
    const model = RetroModel.parse(await readRetro(sql, { now: NOW, days: DAYS, ciTimes: github() }))
    const entry = (kpi: string) => model.ledger.find((e) => e.kpi === kpi)
    expect(entry('ci_p50_minutes')).toMatchObject({ before: 30, now: 25 })
    expect(entry('check_minutes_per_issue')?.before).toBe(20)
    expect(entry('check_minutes_per_issue')?.now).toBeCloseTo(35 / 3, 9)
    // with capacity settings the two are also among its figures
    const withCapacity = RetroModel.parse(
      await readRetro(sql, {
        now: NOW,
        days: DAYS,
        ciTimes: github(),
        capacityConstants: {
          leadsPerAccount: 3,
          loadCeiling: 8,
          slots: 2,
          slotsMax: 6,
          slotExtraLoad: 12,
          seatsMaxBonus: 2,
          reaperGraceMs: 300_000,
          swapoutCeilingMb: 2048,
          swapCeilingPct: 80,
        },
      }),
    )
    expect(withCapacity.capacity?.figures.map((f) => f.key)).toEqual(
      expect.arrayContaining(['check_minutes_per_issue', 'ci_p50_minutes']),
    )
  })
})
