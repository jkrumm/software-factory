import { afterEach, expect, test } from 'bun:test'
import { type GitRepo, startGitRepo } from '@software-factory/tests/git-repo'
import { makefileProjects } from '../../src/adapters/quality/projects.ts'
import { MakeAndProbes } from '../../src/adapters/quality/proof.ts'
import { AgwReview } from '../../src/adapters/quality/review.ts'
import type { Run } from '../../src/adapters/quality/process.ts'
import { NO_VERSION_TARGET } from '../../src/domains/quality/watch.ts'
import type { Check } from '../../src/domains/quality/watch.ts'
import type { Result } from '../../src/kernel/result.ts'

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
