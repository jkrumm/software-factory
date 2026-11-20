import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { githubCiLedger } from '../../src/adapters/selfwatch/github.ts'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { postgresLoopStore } from '../../src/adapters/postgres/loop-store.ts'
import { ciLedgerPass } from '../../src/app/loops/ci-ledger.ts'
import type { UnitOfWork } from '../../src/app/unit-of-work.ts'
import type { CiLedgerRuns } from '../../src/domains/improve/ports.ts'
import type { LoopStore } from '../../src/app/loops/stores.ts'
import { err, ok, portError } from '../../src/kernel/result.ts'

/** The CI ledger: GitHub's runs as the adapter maps them, and what a pass stores, repeats and prunes, on a real Postgres. */
let db: TestCluster
const NOW = new Date('2026-11-07T12:00:00Z')
const projects = async () => ['app']
const DAY = 24 * 3_600_000
const clock = { now: () => NOW }

beforeAll(async () => {
  db = await startTestCluster()
  await migrate(db.sql, await loadMigrations())
})
afterAll(() => db.stop())

/** No transaction: the stores run straight on the cluster. */
const uow: UnitOfWork<{ loops: LoopStore }> = {
  run: (work) => work({ loops: postgresLoopStore(db.sql) }),
  inTransaction: () => false,
}

const github = (runs: unknown[], calls: string[] = []) =>
  githubCiLedger({
    token: 't',
    apiUrl: 'https://api.example.test',
    locate: async (repo) => ok(`/work/${repo}`),
    run: async () => ({ exitCode: 0, stdout: 'git@github.com:o/app.git\n' }),
    fetch: (async (input: Request | string | URL) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      calls.push(`${url.pathname}${url.search}`)
      return Response.json({ workflow_runs: runs })
    }) as unknown as typeof fetch,
  })

const run = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  name: ' CI ',
  event: 'pull_request',
  head_branch: 'factory/1-1',
  head_sha: 'abc123',
  conclusion: 'success',
  run_attempt: 1,
  created_at: '2026-11-07T10:00:00Z',
  run_started_at: '2026-11-07T10:02:00Z',
  updated_at: '2026-11-07T10:12:00Z',
  ...over,
})

describe('githubCiLedger', () => {
  test('maps a finished run with its queue and duration, a rerun from its own start, and leaves out a run with no end', async () => {
    const calls: string[] = []
    const read = await github(
      [
        run(1),
        run(2, { run_attempt: 2, run_started_at: '2026-11-07T11:00:00Z', updated_at: '2026-11-07T11:05:00Z' }),
        run(3, { conclusion: null }),
        run(4, { run_started_at: null }),
        // a clock that disagrees with itself is clamped, never refused
        run(5, { run_started_at: '2026-11-07T09:00:00Z', updated_at: '2026-11-07T08:00:00Z' }),
      ],
      calls,
    )('app', new Date('2026-11-01T00:00:00Z'))
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(
      read.value.map((r) => [r.runId, r.queuedAt.toISOString(), r.startedAt.toISOString(), r.finishedAt.toISOString()]),
    ).toEqual([
      [1, '2026-11-07T10:00:00.000Z', '2026-11-07T10:02:00.000Z', '2026-11-07T10:12:00.000Z'],
      [2, '2026-11-07T11:00:00.000Z', '2026-11-07T11:00:00.000Z', '2026-11-07T11:05:00.000Z'],
      [5, '2026-11-07T09:00:00.000Z', '2026-11-07T09:00:00.000Z', '2026-11-07T09:00:00.000Z'],
    ])
    expect(read.value[0]).toMatchObject({
      workflow: 'CI',
      headBranch: 'factory/1-1',
      headSha: 'abc123',
      conclusion: 'success',
    })
    expect(calls[0]).toContain('created=%3E%3D2026-11-01')
  })
})

describe('githubCiLedger refusals', () => {
  const answering = (status: number, headers: Record<string, string> = {}) =>
    githubCiLedger({
      token: 't',
      apiUrl: 'https://api.example.test',
      locate: async (repo) => ok(`/work/${repo}`),
      run: async () => ({ exitCode: 0, stdout: 'git@github.com:o/app.git\n' }),
      fetch: (async () => new Response('{}', { status, headers })) as unknown as typeof fetch,
    })

  test.each([
    [404, {}, 'refused'],
    [403, {}, 'refused'],
    [403, { 'x-ratelimit-remaining': '0' }, 'timeout'],
    [429, { 'retry-after': '60' }, 'timeout'],
    [500, {}, 'unreadable'],
  ] as const)('a %d answer (%j) is %s', async (status, headers, kind) => {
    const read = await answering(status, headers)('app', NOW)
    expect(read.ok).toBe(false)
    expect(!read.ok && read.error.kind).toBe(kind)
  })
})

describe('ciLedgerPass', () => {
  test('stores the runs of the stored projects and the always-followed repo', async () => {
    const asked: [string, string][] = []
    const ledger: CiLedgerRuns = async (repo, since) => {
      asked.push([repo, since.toISOString()])
      return repo === 'broken' ? err(portError('unreadable', 'github 500')) : ok(await first(repo))
    }
    const first = async (repo: string) => {
      const read = await github([run(repo === 'app' ? 1 : 2)])(repo, NOW)
      return read.ok ? read.value : []
    }
    const pass = await ciLedgerPass({ uow, clock, ledger, projects, always: ['broken', 'factory'], refused: new Map() })
    expect(pass).toEqual(ok({ repos: 2, runs: 2, pruned: 0, notes: ['ci ledger broken: github 500'] }))
    // a repo with no run is read 14 days back
    expect(asked.map(([repo]) => repo)).toEqual(['app', 'broken', 'factory'])
    expect(asked[0]?.[1]).toBe(new Date(NOW.getTime() - 14 * DAY).toISOString())
    const rows = await db.sql`SELECT repo, run_id::int AS id, head_branch FROM factory.ci_runs ORDER BY repo`
    expect(rows.map((r: { repo: string; id: number }) => [r.repo, r.id])).toEqual([
      ['app', 1],
      ['factory', 2],
    ])
  })

  test('a second pass reads from the day before the newest stored run and overwrites a run it sees again', async () => {
    const asked: string[] = []
    const ledger: CiLedgerRuns = async (repo, since) => {
      if (repo === 'app') asked.push(since.toISOString())
      const read = await github([run(1, { conclusion: 'failure' })])(repo, since)
      return read
    }
    expect((await ciLedgerPass({ uow, clock, ledger, projects, always: [], refused: new Map() })).ok).toBe(true)
    // the newest run of `app` finished 2026-11-07T10:12
    expect(asked).toEqual(['2026-11-06T10:12:00.000Z'])
    const [row] = await db.sql`SELECT conclusion, count(*) OVER ()::int AS n FROM factory.ci_runs WHERE repo = 'app'`
    expect(row).toEqual({ conclusion: 'failure', n: 1 })
  })

  test('prunes the runs that finished over 30 days ago', async () => {
    await db.sql`INSERT INTO factory.ci_runs (repo, run_id, workflow, event, head_sha, queued_at, started_at, finished_at, conclusion)
      VALUES ('app', 99, 'CI', 'push', 'x', ${new Date(NOW.getTime() - 31 * DAY)}, ${new Date(NOW.getTime() - 31 * DAY)},
              ${new Date(NOW.getTime() - 31 * DAY)}, 'success')`
    const ledger: CiLedgerRuns = async () => ok([])
    expect(await ciLedgerPass({ uow, clock, ledger, projects, always: [], refused: new Map() })).toEqual(
      ok({ repos: 1, runs: 0, pruned: 1, notes: [] }),
    )
  })

  test('a refused repo is a note once, left alone for a day, then asked again; a repo that cannot be read for now is asked every pass', async () => {
    const asked: string[] = []
    const ledger: CiLedgerRuns = async (repo) => {
      asked.push(repo)
      if (repo === 'gone') return err(portError('refused', 'github 404'))
      if (repo === 'slow') return err(portError('timeout', 'github 403 (rate limited)'))
      return ok([])
    }
    const refused = new Map<string, number>()
    const deps = { uow, ledger, projects: async () => ['app', 'gone', 'slow'], always: [], refused }
    const first = await ciLedgerPass({ ...deps, clock })
    expect(first.ok && first.value.notes).toEqual([
      'ci ledger gone: github 404',
      'ci ledger slow: github 403 (rate limited)',
    ])
    const later = await ciLedgerPass({ ...deps, clock: { now: () => new Date(NOW.getTime() + 3_600_000) } })
    expect(later.ok && later.value.notes).toEqual(['ci ledger slow: github 403 (rate limited)'])
    const nextDay = await ciLedgerPass({ ...deps, clock: { now: () => new Date(NOW.getTime() + DAY + 60_000) } })
    expect(nextDay.ok && nextDay.value.notes).toEqual([
      'ci ledger gone: github 404',
      'ci ledger slow: github 403 (rate limited)',
    ])
    expect(asked.filter((repo) => repo === 'gone')).toHaveLength(2)
    expect(asked.filter((repo) => repo === 'slow')).toHaveLength(3)
  })
})
