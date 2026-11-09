import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitBranches } from '../../src/adapters/git/branches.ts'
import { type Run, runProcess } from '../../src/adapters/quality/process.ts'
import type { BranchClosure } from '../../src/domains/leads/ports.ts'

let base: string
beforeAll(() => {
  base = realpathSync(mkdtempSync('/tmp/factory-branches-'))
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

async function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@x',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@x',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
  if (code !== 0) throw new Error(`git ${args.join(' ')}: ${err}`)
  return out.trim()
}

async function repo() {
  const dir = mkdtempSync(join(base, 'git-'))
  const origin = join(dir, 'origin.git')
  const work = join(dir, 'work')
  mkdirSync(origin)
  mkdirSync(work)
  await git(origin, 'init', '-q', '--bare', '-b', 'master')
  await git(work, 'init', '-q', '-b', 'master')
  writeFileSync(join(work, 'a.txt'), 'a\n')
  await git(work, 'add', '.')
  await git(work, 'commit', '-q', '-m', 'init')
  await git(work, 'remote', 'add', 'origin', origin)
  await git(work, 'push', '-q', 'origin', 'master')
  return { work, origin }
}

/** A pushed branch with one commit of its own (a file named after it), and the checkout back on master. */
async function branch(work: string, name: string, push = true) {
  await git(work, 'checkout', '-q', '-b', name, 'master')
  writeFileSync(join(work, `${name.replaceAll('/', '-')}.txt`), 'work\n')
  await git(work, 'add', '.')
  await git(work, 'commit', '-q', '-m', `work on ${name}`)
  if (push) await git(work, 'push', '-q', 'origin', name)
  await git(work, 'checkout', '-q', 'master')
}

/** Squash-merges the branch into master and pushes; the file is changed afterwards, so the branch no longer merges clean. */
async function squash(work: string, name: string): Promise<string> {
  await git(work, 'merge', '--squash', name)
  await git(work, 'commit', '-q', '-m', `squash ${name}`)
  const sha = await git(work, 'rev-parse', 'HEAD')
  writeFileSync(join(work, `${name.replaceAll('/', '-')}.txt`), 'changed later\n')
  await git(work, 'commit', '-qam', 'change it')
  await git(work, 'push', '-q', 'origin', 'master')
  return sha
}

const exists = async (dir: string, ref: string) => {
  try {
    await git(dir, 'rev-parse', '-q', '--verify', ref)
    return true
  } catch {
    return false
  }
}

const NO_PR = { token: null, apiUrl: 'https://api.example.test' }
const clean = (
  work: string,
  issue: number,
  closed: BranchClosure,
  shipped: string[] = [],
  options: Partial<Parameters<typeof gitBranches>[0]> = {},
) => {
  const result = gitBranches({ ...NO_PR, ...options }).clean({ repo: work, issue, closed, shipped })
  return result.then((r) => {
    if (!r.ok) throw new Error(r.error.detail)
    return r.value
  })
}

describe('lead branches', () => {
  test('a squash-merged branch is not merged by git; a shipped sha on origin/master settles it, local and remote', async () => {
    const { work, origin } = await repo()
    await branch(work, 'factory/10-1')
    const sha = await squash(work, 'factory/10-1')
    expect(await git(work, 'branch', '--merged', 'master')).not.toContain('factory/10-1')

    const unknown = await clean(work, 10, 'other')
    expect(unknown).toEqual({
      deleted: [],
      kept: [
        { branch: 'factory/10-1', why: 'its commits are not on origin/master and no merged PR or shipped commit' },
      ],
    })

    expect(await clean(work, 10, 'other', [sha])).toEqual({ deleted: ['factory/10-1'], kept: [] })
    expect(await exists(work, 'refs/heads/factory/10-1')).toBe(false)
    expect(await exists(work, 'refs/remotes/origin/factory/10-1')).toBe(false)
    expect(await exists(origin, 'refs/heads/factory/10-1')).toBe(false)
    expect(await clean(work, 10, 'other', [sha])).toEqual({ deleted: [], kept: [] })
  })

  test('a shipped sha that is not on origin/master settles nothing', async () => {
    const { work } = await repo()
    await branch(work, 'factory/14-1')
    const result = await clean(work, 14, 'other', ['0'.repeat(40)])
    expect(result.deleted).toEqual([])
    expect(result.kept.map((k) => k.branch)).toEqual(['factory/14-1'])
  })

  test('a merged pull request settles the branch; no token, an open one, or an error keeps it', async () => {
    const { work, origin } = await repo()
    await branch(work, 'factory/11-1')
    await squash(work, 'factory/11-1')
    const run: Run = (cmd, timeoutMs, options) =>
      cmd.includes('get-url')
        ? Promise.resolve({ exitCode: 0, stdout: 'https://github.com/o/r.git\n' })
        : runProcess(cmd, timeoutMs, options)
    const asked: string[] = []
    const answer = (body: unknown, status = 200) =>
      (async (url: string | URL | Request) => {
        asked.push(String(url))
        return new Response(JSON.stringify(body), { status })
      }) as unknown as typeof fetch
    const options = (body: unknown, status?: number, token: string | null = 't') => ({
      token,
      run,
      fetch: answer(body, status),
    })

    expect((await clean(work, 11, 'other', [], options([{ merged_at: null }]))).deleted).toEqual([])
    expect((await clean(work, 11, 'other', [], options([], 500))).deleted).toEqual([])
    expect(
      (await clean(work, 11, 'other', [], options([{ merged_at: '2026-11-08T10:00:00Z' }], 200, null))).deleted,
    ).toEqual([])
    expect(asked).toHaveLength(2)

    const merged = await clean(work, 11, 'other', [], options([{ merged_at: '2026-11-08T10:00:00Z' }]))
    expect(merged.deleted).toEqual(['factory/11-1'])
    expect(asked.at(-1)).toBe('https://api.example.test/repos/o/r/pulls?head=o%3Afactory%2F11-1&state=all')
    expect(await exists(origin, 'refs/heads/factory/11-1')).toBe(false)
  })

  test('a dropped or cancelled Issue loses its unmerged branch; a closed one that is done keeps it and says so', async () => {
    const { work, origin } = await repo()
    await branch(work, 'factory/12-1')
    await branch(work, 'factory/12-2', false)
    const kept = await clean(work, 12, 'other')
    expect(kept.deleted).toEqual([])
    expect(kept.kept.map((k) => k.branch)).toEqual(['factory/12-1', 'factory/12-2'])

    expect(await clean(work, 12, 'dropped')).toEqual({ deleted: ['factory/12-1', 'factory/12-2'], kept: [] })
    expect(await exists(work, 'refs/heads/factory/12-2')).toBe(false)
    expect(await exists(origin, 'refs/heads/factory/12-1')).toBe(false)
  })

  test('a branch whose commits are on origin/master, or whose merge changes nothing, goes', async () => {
    const { work } = await repo()
    await branch(work, 'factory/13-1')
    await git(work, 'merge', '--ff-only', 'factory/13-1')
    await git(work, 'push', '-q', 'origin', 'master')
    await branch(work, 'factory/13-2')
    await git(work, 'cherry-pick', '-x', 'factory/13-2')
    await git(work, 'push', '-q', 'origin', 'master')
    expect(await clean(work, 13, 'other')).toEqual({ deleted: ['factory/13-1', 'factory/13-2'], kept: [] })
  })

  test('only the Issue number asked for: factory/5-1 never matches factory/55-1', async () => {
    const { work, origin } = await repo()
    await branch(work, 'factory/5-1')
    await branch(work, 'factory/55-1')
    await branch(work, 'factory/6-1')
    expect(await clean(work, 5, 'dropped')).toEqual({ deleted: ['factory/5-1'], kept: [] })
    expect(await exists(work, 'refs/heads/factory/55-1')).toBe(true)
    expect(await exists(origin, 'refs/heads/factory/55-1')).toBe(true)
    expect(await exists(origin, 'refs/heads/factory/6-1')).toBe(true)
    expect(await clean(work, 55, 'cancelled')).toEqual({ deleted: ['factory/55-1'], kept: [] })
    expect(await exists(work, 'refs/heads/factory/6-1')).toBe(true)
  })

  test('a branch a worktree has checked out is kept, even when the Issue was dropped', async () => {
    const { work, origin } = await repo()
    await branch(work, 'factory/15-1')
    const tree = join(base, 'tree-15')
    await git(work, 'worktree', 'add', '-q', tree, 'factory/15-1')
    const result = await clean(work, 15, 'dropped')
    expect(result.deleted).toEqual([])
    expect(result.kept).toEqual([{ branch: 'factory/15-1', why: `checked out in the worktree ${tree}` }])
    expect(await exists(origin, 'refs/heads/factory/15-1')).toBe(true)
  })

  test('a repo that is no repo is an error, not a throw', async () => {
    const result = await gitBranches(NO_PR).clean({
      repo: join(base, 'nowhere'),
      issue: 1,
      closed: 'dropped',
      shipped: [],
    })
    expect(result.ok).toBe(false)
  })
})
