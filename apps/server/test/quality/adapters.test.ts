import { afterEach, expect, test } from 'bun:test'
import { type GitRepo, startGitRepo } from '@software-factory/tests/git-repo'
import { githubCi } from '../../src/adapters/quality/ci.ts'
import { makefileProjects } from '../../src/adapters/quality/projects.ts'
import { MakeAndProbes } from '../../src/adapters/quality/proof.ts'
import { AgwReview } from '../../src/adapters/quality/review.ts'
import type { Run } from '../../src/adapters/quality/process.ts'
import { NO_VERSION_TARGET } from '../../src/domains/quality/watch.ts'
import type { Check } from '../../src/domains/quality/watch.ts'
import type { Ci } from '../../src/domains/quality/ports.ts'
import { err, ok, portError, type Result } from '../../src/kernel/result.ts'

const repos: GitRepo[] = []
afterEach(async () => {
  for (const repo of repos.splice(0)) await repo.stop()
})

const MAKEFILE = 'verify:\n\t@test ! -e red\nversion:\n\t@git rev-parse HEAD\ndeploy:\n\t@true\n'
const fresh = async (makefile = MAKEFILE) => {
  const repo = await startGitRepo(makefile)
  repos.push(repo)
  return repo
}

const checks = (result: Result<Check[]>): Check[] => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.value
}
const signal = () => new AbortController().signal
const verify = (repo: GitRepo, input: { landedAt?: string; makeVerify?: boolean; problem?: string } = {}) =>
  new MakeAndProbes().run(
    {
      repo: repo.path,
      makeVerify: input.makeVerify ?? true,
      probes: [],
      ...(input.problem
        ? { version: { problem: input.problem } }
        : input.landedAt
          ? { version: { landedAt: input.landedAt } }
          : {}),
    },
    signal(),
  )

test('verify runs make verify and the deployed version check; green is every check passing', async () => {
  const repo = await fresh()
  const landedAt = await repo.git('rev-parse', 'HEAD')
  const got = checks(await verify(repo, { landedAt }))
  expect(got.map((c) => [c.name, c.ok])).toEqual([
    ['deployed version', true],
    ['make verify', true],
  ])
})

test('a red make verify carries its exit and its last output', async () => {
  const repo = await fresh()
  await Bun.write(`${repo.path}/red`, '')
  const [only] = checks(await verify(repo))
  expect(only).toMatchObject({ name: 'make verify', ok: false, detail: expect.stringContaining('exit 2') })
})

test('a red make verify with long output keeps the error and the end, and a watchdog list keeps the red check', async () => {
  const plain = await fresh(
    "verify:\n\t@seq 1 300 | sed 's/^/passing line /'; echo 'src/x.ts: error TS1: boom'; seq 301 600 | sed 's/^/passing line /'; exit 2\n",
  )
  const [one] = checks(await verify(plain, { makeVerify: true }))
  expect(one?.detail).toContain('error TS1: boom')
  expect(one?.detail).toContain('passing line 600')
  expect(one?.detail).toMatch(/\[… \d+ lines cut\]/)
  expect((one?.detail.length ?? 0) < 1_700).toBe(true)

  const json = JSON.stringify([
    { name: 'quiet', ok: true, detail: 'q'.repeat(2_000) },
    { name: 'round_integrity', ok: false, detail: 'no blend row' },
  ])
  const list = await fresh(`verify:\n\t@printf '%s\\n' '${json}'; exit 1\n`)
  const [red] = checks(await verify(list, { makeVerify: true }))
  expect(red?.detail).toBe('exit 2: 1 of 2 checks failing:\nround_integrity: no blend row')
})

test('the deployed version must hold where the work landed', async () => {
  const repo = await fresh()
  const before = await repo.git('rev-parse', 'HEAD')
  const landed = await repo.commit('a.ts', 'a\n')
  // The checkout is behind origin: it is fast-forwarded first, so make reads what was merged.
  await repo.git('reset', '-q', '--hard', before)
  const got = checks(await verify(repo, { landedAt: landed }))
  expect(got.map((c) => [c.name, c.ok])).toEqual([
    ['checkout', true],
    ['deployed version', true],
    ['make verify', true],
  ])
  await repo.git('reset', '-q', '--hard', before)
  const behind = checks(
    await new MakeAndProbes({ sync: async () => ({ state: 'current', detail: 'held' }) }).run(
      { repo: repo.path, makeVerify: false, probes: [], version: { landedAt: landed } },
      signal(),
    ),
  )
  expect(behind).toMatchObject([
    { name: 'deployed version', ok: false, detail: expect.stringContaining('`make deploy` has not run') },
  ])
})

test('a repo with no make version target reds with the line that says the owner adds it', async () => {
  const repo = await fresh('verify:\n\t@true\n')
  const [only, second] = checks(await verify(repo, { landedAt: await repo.git('rev-parse', 'HEAD') }))
  expect(only).toEqual({ name: 'deployed version', ok: false, detail: NO_VERSION_TARGET })
  expect(second).toMatchObject({ name: 'make verify', ok: true })
})

test('a ship that found nowhere it landed reds the version check with that reason', async () => {
  const repo = await fresh()
  const [only] = checks(await verify(repo, { makeVerify: false, problem: 'no landed commit' }))
  expect(only).toEqual({ name: 'deployed version', ok: false, detail: 'no landed commit' })
})

test('a checkout that is not ours to move is blocked: neither version nor verify run on the stale tree', async () => {
  const repo = await fresh()
  const other = await repo.other()
  await other.commit('n.ts', 'n\n')
  await repo.git('checkout', '-q', '-b', 'side')
  const got = checks(await verify(repo, { landedAt: other.path }))
  expect(got).toMatchObject([{ name: 'checkout', ok: false, blocked: true }])
})

test('a probe passes on the status the project expects, redirects included', async () => {
  const repo = await fresh()
  const answers = new Map([
    ['http://probe.example/ok', 200],
    ['http://probe.example/moved', 302],
    ['http://probe.example/down', 503],
  ])
  const fetch = (async (url: string) => {
    if (url.endsWith('/boom')) throw new Error('connect ECONNREFUSED')
    return new Response(null, { status: answers.get(url) ?? 404 })
  }) as unknown as typeof globalThis.fetch
  const got = checks(
    await new MakeAndProbes({ fetch }).run(
      {
        repo: repo.path,
        makeVerify: false,
        probes: [
          { name: 'ok', http: 'http://probe.example/ok', expect: 200 },
          { name: 'moved', http: 'http://probe.example/moved', expect: 302 },
          { name: 'down', http: 'http://probe.example/down', expect: 200 },
          { name: 'boom', http: 'http://probe.example/boom', expect: 200 },
        ],
      },
      signal(),
    ),
  )
  expect(got.map((c) => [c.name, c.ok])).toEqual([
    ['ok', true],
    ['moved', true],
    ['down', false],
    ['boom', false],
  ])
  expect(got[2]?.detail).toBe('HTTP 503, expected 200')
})

test('a server that is stopping gets no answer: the checks would say nothing', async () => {
  const repo = await fresh()
  const stopping = new AbortController()
  stopping.abort()
  const got = await new MakeAndProbes().run({ repo: repo.path, makeVerify: true, probes: [] }, stopping.signal)
  expect(got).toEqual({ ok: false, error: { kind: 'gone', detail: 'the server is stopping' } })
})

test('a Makefile says what the watch runs; no Makefile has nothing to run', async () => {
  const repo = await fresh()
  const projects = makefileProjects({ windowMs: 5 })
  expect(await projects.checksOf(repo.path)).toEqual({
    ok: true,
    value: { windowMs: 5, deployMode: 'make', makeVerify: true, probes: [] },
  })
  expect(await projects.checksOf('/nonexistent/repo')).toEqual({
    ok: true,
    value: { windowMs: 5, deployMode: 'none', makeVerify: false, probes: [] },
  })
})

// agw's review reads: the ledger is agw's, and any failure is a result for the ship to record, never a throw.
const agw = (answers: Record<string, { exitCode: number; stdout: string }>): AgwReview => {
  const run: Run = async (cmd) => answers[cmd[2] ?? ''] ?? { exitCode: 1, stdout: '' }
  return new AgwReview({ bin: 'agw', run })
}
const range = { base: 'b'.repeat(40), head: 'a'.repeat(40) }

test('agw review: covered ranges are a review at the highest level asked', async () => {
  const review = agw({
    route: { exitCode: 0, stdout: JSON.stringify({ tier: 'deep' }) },
    covered: { exitCode: 0, stdout: JSON.stringify({ covered: true, commits: [], uncovered: [] }) },
  })
  expect(await review.read({ repo: '/r', ranges: [range] })).toEqual({
    ok: true,
    value: { tier: 'deep', covered: true, uncovered: [] },
  })
})

test('agw review: an uncovered commit is named with the level it needs and agw’s reason', async () => {
  const sha = 'c'.repeat(40)
  const review = agw({
    route: { exitCode: 0, stdout: JSON.stringify({ tier: 'standard' }) },
    covered: {
      exitCode: 0,
      stdout: JSON.stringify({
        covered: false,
        commits: [{ sha, subject: 'feat: x', required: 'standard', reason: 'an important finding is open' }],
        uncovered: [sha],
      }),
    },
  })
  expect(await review.read({ repo: '/r', ranges: [range] })).toEqual({
    ok: true,
    value: {
      tier: 'standard',
      covered: false,
      uncovered: [{ sha, subject: 'feat: x', required: 'standard', reason: 'an important finding is open' }],
    },
  })
})

test('agw review: every range shares one limit, so batches of ranges do not add their waits up', async () => {
  let clock = 0
  const limits: number[] = []
  const run: Run = async (cmd, timeoutMs) => {
    limits.push(timeoutMs)
    await Promise.resolve() // the work takes its time after every call of the batch has been started
    clock += 40_000
    return cmd[2] === 'route'
      ? { exitCode: 0, stdout: JSON.stringify({ tier: 'light' }) }
      : { exitCode: 0, stdout: JSON.stringify({ covered: true, commits: [], uncovered: [] }) }
  }
  const review = new AgwReview({ bin: 'agw', run, timeoutMs: 100_000, now: () => clock })
  // five ranges: a batch of four, then one; the second batch gets what the first left of the 100 s
  await review.read({ repo: '/r', ranges: Array.from({ length: 5 }, () => range) })
  expect(limits.slice(0, 8).every((ms) => ms === 100_000)).toBe(true)
  expect(limits.slice(8)).toEqual([1, 1])
})

test('agw review: a failing, silent or unexpected agw is an error result', async () => {
  expect(await agw({}).read({ repo: '/r', ranges: [range] })).toMatchObject({
    ok: false,
    error: { kind: 'refused', detail: expect.stringContaining('exited 1') },
  })
  const garbage = agw({ route: { exitCode: 0, stdout: 'nope' }, covered: { exitCode: 0, stdout: '{}' } })
  expect(await garbage.read({ repo: '/r', ranges: [range] })).toMatchObject({
    ok: false,
    error: { kind: 'unreadable', detail: expect.stringContaining('printed no JSON') },
  })
  const odd = agw({ route: { exitCode: 0, stdout: '{"tier":1}' }, covered: { exitCode: 0, stdout: '{}' } })
  expect(await odd.read({ repo: '/r', ranges: [range] })).toMatchObject({
    ok: false,
    error: { kind: 'unreadable', detail: expect.stringContaining('unexpected') },
  })
})

test('a project’s other make target runs beside verify, each its own check; a missing one is red', async () => {
  const repo = await fresh()
  const got = checks(
    await new MakeAndProbes().run(
      { repo: repo.path, makeVerify: true, makeTargets: ['no-such-target'], probes: [] },
      signal(),
    ),
  )
  expect(got.map((c) => [c.name, c.ok])).toEqual([
    ['make verify', true],
    ['make no-such-target', false],
  ])
})

const github = (routes: Record<string, unknown>, seen: string[] = []): typeof fetch =>
  (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname
    seen.push(path)
    return path in routes ? Response.json(routes[path]) : new Response('not found', { status: 404 })
  }) as typeof fetch

const withOrigin = async (url: string) => {
  const repo = await fresh()
  await repo.git('remote', 'set-url', 'origin', url)
  return repo
}

test('github CI: the merged pull request of the named commits and the conclusion of its head', async () => {
  const repo = await withOrigin('git@github.com:o/app.git')
  const seen: string[] = []
  const fetch = github(
    {
      '/repos/o/app/commits/c1/pulls': [{ number: 4, merged_at: null, head: { sha: 'h0' } }],
      '/repos/o/app/commits/c2/pulls': [
        {
          number: 9,
          html_url: 'https://github.com/o/app/pull/9',
          merged_at: '2026-01-01T00:00:00Z',
          head: { sha: 'h9' },
        },
      ],
      '/repos/o/app/commits/h9/check-runs': {
        check_runs: [
          { name: 'build', head_sha: 'h9', status: 'completed', conclusion: 'success' },
          {
            name: 'test',
            head_sha: 'h9',
            status: 'completed',
            conclusion: 'failure',
            html_url: 'https://github.com/o/app/runs/2',
          },
        ],
      },
      '/repos/o/app/commits/h9/status': { sha: 'h9', statuses: [] },
    },
    seen,
  )
  const ci = githubCi({ token: 't', apiUrl: 'https://api.example.test', fetch })
  expect(await ci.ofShip({ repo: repo.path, commits: ['c1', 'c2', 'c3'] })).toEqual({
    ok: true,
    value: { status: 'red', pr: 9, headSha: 'h9', url: 'https://github.com/o/app/runs/2', reason: 'test failure' },
  })
  expect(seen.some((path) => path.includes('c3'))).toBe(false)
})

test('github CI: no pull request is missing; no token, no github origin and a failing github are errors', async () => {
  const repo = await withOrigin('https://github.com/o/app.git')
  const none = github({ '/repos/o/app/commits/c1/pulls': [] })
  expect(
    await githubCi({ token: 't', apiUrl: 'https://api.example.test', fetch: none }).ofShip({
      repo: repo.path,
      commits: ['c1'],
    }),
  ).toMatchObject({
    ok: true,
    value: { status: 'missing', pr: null, headSha: null },
  })
  const down = githubCi({ token: 't', apiUrl: 'https://api.example.test', fetch: github({}) })
  expect(await down.ofShip({ repo: repo.path, commits: ['c1'] })).toMatchObject({
    ok: false,
    error: { detail: 'github 404' },
  })
  const tokenless = githubCi({ token: null, apiUrl: 'https://api.example.test', fetch: none })
  expect(await tokenless.ofCommit({ repo: repo.path, sha: 'c1' })).toMatchObject({
    ok: false,
    error: { detail: 'no token' },
  })
  const local = await fresh()
  expect(
    await githubCi({ token: 't', apiUrl: 'https://api.example.test', fetch: none }).ofCommit({
      repo: local.path,
      sha: 'c1',
    }),
  ).toMatchObject({
    ok: false,
    error: { detail: expect.stringContaining('no github.com origin') },
  })
})

test('github CI: a commit status counts beside the check runs; a head with a pending status is running', async () => {
  const repo = await withOrigin('https://github.com/o/app.git')
  const fetch = github({
    '/repos/o/app/commits/s1/check-runs': {
      check_runs: [{ name: 'build', head_sha: 'h9', status: 'completed', conclusion: 'success' }],
    },
    '/repos/o/app/commits/s1/status': {
      sha: 's1',
      statuses: [{ context: 'lint', state: 'pending', target_url: 'https://x/lint' }],
    },
  })
  expect(
    await githubCi({ token: 't', apiUrl: 'https://api.example.test', fetch }).ofCommit({ repo: repo.path, sha: 's1' }),
  ).toEqual({
    ok: true,
    value: { status: 'running', url: 'https://x/lint', reason: 'lint is still running' },
  })
})

test('the ci check reads the landed commit; a CI that cannot be read does not hold the watch; unset reads nothing', async () => {
  const repo = await fresh()
  const asked: string[] = []
  const ci: Ci = {
    ofShip: async () => err(portError('refused', 'unused')),
    ofCommit: async ({ sha }) => {
      asked.push(sha)
      return ok({ status: 'red', url: null, reason: 'build failure' })
    },
  }
  const now = '2026-01-01T12:05:00.000Z'
  const input = {
    repo: repo.path,
    makeVerify: false,
    probes: [],
    ci: { landedAt: 'abcdef0123', mergedAt: '2026-01-01T12:00:00.000Z', now },
  }
  expect(checks(await new MakeAndProbes({ ci }).run(input, signal()))).toEqual([
    { name: 'ci', ok: false, detail: 'build failure for abcdef0' },
  ])
  expect(asked).toEqual(['abcdef0123'])
  const unread: Ci = { ...ci, ofCommit: async () => err(portError('refused', 'no token')) }
  expect(checks(await new MakeAndProbes({ ci: unread }).run(input, signal()))).toEqual([
    { name: 'ci', ok: true, detail: 'CI was not read: no token' },
  ])
  expect(checks(await new MakeAndProbes({ ci }).run({ ...input, ci: undefined }, signal()))).toEqual([])
})
