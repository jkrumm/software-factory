import { afterEach, expect, test } from 'bun:test'
import { type GitRepo, startGitRepo } from '@software-factory/tests/git-repo'
import { deployedHolds, GitCommits, syncCheckout } from '../../src/adapters/quality/git.ts'
import type { CommitRead } from '../../src/domains/quality/evidence.ts'
import type { Result } from '../../src/kernel/result.ts'

const repos: GitRepo[] = []
afterEach(async () => {
  for (const repo of repos.splice(0)) await repo.stop()
})
const fresh = async () => {
  const repo = await startGitRepo()
  repos.push(repo)
  return repo
}

const read = (repo: GitRepo, reported: string[], extra: { branch?: string; cut?: string } = {}) =>
  new GitCommits().read({ repo: repo.path, branch: extra.branch ?? null, cut: extra.cut ?? null, reported })

function value(result: Result<CommitRead>): CommitRead {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.value
}

test('a commit on origin’s default branch is evidence: where it landed, what it touched, the range to review', async () => {
  const repo = await fresh()
  const sha = await repo.commit('src/a.ts', 'export const a = 1\n', 'feat: a')
  const got = value(await read(repo, [sha]))
  const tip = await repo.git('rev-parse', 'origin/master')
  expect(got).toMatchObject({ landedAt: tip, commits: [sha], paths: ['src/a.ts'] })
  expect(got.mergedAt).toBeInstanceOf(Date)
  expect(got.reviewRanges).toEqual([{ base: await repo.git('rev-parse', `${sha}^`), head: sha }])
})

test('two neighbouring commits are one range; a commit by someone else between them splits it', async () => {
  const repo = await fresh()
  const one = await repo.commit('a.ts', '1\n')
  const two = await repo.commit('b.ts', '2\n')
  const together = value(await read(repo, [one, two]))
  expect(together.reviewRanges).toEqual([{ base: await repo.git('rev-parse', `${one}^`), head: two }])

  const other = await repo.other()
  await other.commit('theirs.ts', 'x\n')
  await repo.git('pull', '-q', '--ff-only', 'origin', 'master')
  const three = await repo.commit('c.ts', '3\n')
  const split = value(await read(repo, [one, two, three]))
  expect(split.reviewRanges).toHaveLength(2)
  expect(split.reviewRanges[1]?.head).toBe(three)
})

test('a commit that is not on the default branch is refused: merge it first', async () => {
  const repo = await fresh()
  await repo.git('checkout', '-q', '-b', 'feature')
  await Bun.write(`${repo.path}/f.ts`, 'f\n')
  await repo.git('add', '-A')
  await repo.git('commit', '-q', '-m', 'feat: f')
  const sha = await repo.git('rev-parse', 'HEAD')
  const got = await read(repo, [sha])
  expect(got).toEqual({
    ok: false,
    error: { kind: 'refused', detail: expect.stringContaining('is not on origin/master: merge it first') },
  })
})

test('a commit git does not know is refused: push it first', async () => {
  const repo = await fresh()
  const got = await read(repo, ['deadbeef'])
  expect(got).toEqual({
    ok: false,
    error: { kind: 'refused', detail: `commit deadbeef is not in ${repo.path}: push it first` },
  })
})

test('a commit merged elsewhere is found after a fetch (a pull request merged on GitHub)', async () => {
  const repo = await fresh()
  const other = await repo.other()
  const sha = await other.commit('remote.ts', 'r\n', 'feat: remote')
  expect(value(await read(repo, [sha])).commits).toEqual([sha])
})

test('a commit from before the attempt’s cut proves nothing about it', async () => {
  const repo = await fresh()
  const old = await repo.commit('old.ts', 'o\n')
  const cut = await repo.commit('cut.ts', 'c\n')
  const got = await read(repo, [old], { cut })
  expect(got).toEqual({
    ok: false,
    error: { kind: 'refused', detail: expect.stringContaining('is older than this attempt') },
  })
})

test('the lead’s branch counts too: work on it that is not on the base is refused', async () => {
  const repo = await fresh()
  const cut = await repo.git('rev-parse', 'HEAD')
  await repo.git('checkout', '-q', '-b', 'factory/issue_1-1')
  await Bun.write(`${repo.path}/wip.ts`, 'w\n')
  await repo.git('add', '-A')
  await repo.git('commit', '-q', '-m', 'wip')
  await repo.git('checkout', '-q', 'master')
  const merged = await repo.commit('named.ts', 'n\n', 'feat: named')
  const got = await read(repo, [merged], { branch: 'factory/issue_1-1', cut })
  expect(got).toEqual({
    ok: false,
    error: { kind: 'refused', detail: expect.stringContaining('holds work that is not on origin/master') },
  })
})

test('a squash merge of the branch is on the base: the branch’s content landed', async () => {
  const repo = await fresh()
  const cut = await repo.git('rev-parse', 'HEAD')
  await repo.git('checkout', '-q', '-b', 'factory/issue_1-1')
  await Bun.write(`${repo.path}/s.ts`, 's\n')
  await repo.git('add', '-A')
  await repo.git('commit', '-q', '-m', 'wip')
  await repo.git('checkout', '-q', 'master')
  await repo.git('merge', '-q', '--squash', 'factory/issue_1-1')
  await repo.git('commit', '-q', '-m', 'feat: s')
  await repo.git('push', '-q', 'origin', 'master')
  const squashed = await repo.git('rev-parse', 'HEAD')
  const got = value(await read(repo, [squashed], { branch: 'factory/issue_1-1', cut }))
  expect(got.paths).toContain('s.ts')
  expect(got.reviewRanges).toHaveLength(1)
})

test('without a cut, the range starts at the parent of the oldest commit named', async () => {
  const repo = await fresh()
  const one = await repo.commit('a.ts', '1\n')
  const two = await repo.commit('b.ts', '2\n')
  const got = value(await read(repo, [two, one]))
  expect(got.reviewRanges).toEqual([{ base: await repo.git('rev-parse', `${one}^`), head: two }])
})

test('the checkout fast-forwards to origin; one with a tracked change or another branch is blocked, never moved', async () => {
  const repo = await fresh()
  const other = await repo.other()
  await other.commit('n.ts', 'n\n')
  const advanced = await syncCheckout(repo.path)
  expect(advanced.state).toBe('advanced')
  expect((await syncCheckout(repo.path)).state).toBe('current')

  await other.commit('m.ts', 'm\n')
  await Bun.write(`${repo.path}/n.ts`, 'dirty\n')
  const dirty = await syncCheckout(repo.path)
  expect(dirty).toMatchObject({ state: 'blocked', detail: expect.stringContaining('uncommitted changes (n.ts)') })
  await repo.git('checkout', '-q', '--', 'n.ts')
  await repo.git('checkout', '-q', '-b', 'side')
  expect(await syncCheckout(repo.path)).toMatchObject({
    state: 'blocked',
    detail: expect.stringContaining('on branch side'),
  })
})

test('the deployed commit must hold where the work landed', async () => {
  const repo = await fresh()
  const early = await repo.git('rev-parse', 'HEAD')
  const landed = await repo.commit('a.ts', '1\n')
  expect(await deployedHolds(repo.path, landed, landed)).toMatchObject({ ok: true })
  const later = await repo.commit('b.ts', '2\n')
  expect(await deployedHolds(repo.path, later, landed)).toMatchObject({ ok: true })
  expect(await deployedHolds(repo.path, early, landed)).toMatchObject({
    ok: false,
    detail: expect.stringContaining('`make deploy` has not run'),
  })
  expect(await deployedHolds(repo.path, 'f'.repeat(40), landed)).toMatchObject({
    ok: false,
    detail: expect.stringContaining('is not in'),
  })
})

test('a deployed commit behind where the work landed only by changes no deploy carries still holds it', async () => {
  const repo = await fresh()
  const deployed = await repo.commit('src/a.ts', '1\n')
  const docs = await repo.commit('docs/notes.md', 'x\n')
  const tests = await repo.commit('src/a.test.ts', 't\n')
  expect(await deployedHolds(repo.path, deployed, docs)).toMatchObject({ ok: true })
  expect(await deployedHolds(repo.path, deployed, tests)).toMatchObject({ ok: true })
  const code = await repo.commit('src/b.ts', '2\n')
  expect(await deployedHolds(repo.path, deployed, code)).toMatchObject({
    ok: false,
    detail: expect.stringContaining('`make deploy` has not run'),
  })
  const after = await repo.commit('docs/more.md', 'y\n')
  expect(await deployedHolds(repo.path, deployed, after)).toMatchObject({ ok: false })
})

test('a plan or project.yaml edit after the deploy never regresses it; a change under apps/ does', async () => {
  const repo = await fresh()
  const deployed = await repo.commit('apps/server/a.ts', '1\n')
  await repo.commit('project.yaml', 'a: 1\n')
  const plan = await repo.commit('docs/plan.yaml', 'b: 1\n')
  expect(await deployedHolds(repo.path, deployed, plan)).toMatchObject({ ok: true })
  const code = await repo.commit('apps/server/b.ts', '2\n')
  expect(await deployedHolds(repo.path, deployed, code)).toMatchObject({ ok: false })
})
