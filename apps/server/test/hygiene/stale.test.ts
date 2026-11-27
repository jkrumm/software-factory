import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { defaultTools } from '../../src/adapters/hygiene/git.ts'

const ID = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
}
const tools = defaultTools()
let base: string
let counter = 0

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, ...ID, ...env } })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

/** A committed repo with `files`; the probe reads the tracked files of this directory. */
function repo(files: Record<string, string>): string {
  const dir = join(base, `repo-${++counter}`)
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'master'])
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'factory-hygiene-probe-'))
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

import { parseWorktrees, shortPath, staleProbe } from '../../src/adapters/hygiene/probes/stale.ts'

/** Sets the mtime of a worktree's own index and HEAD `days` back. */
function quiet(work: string, wt: string, days: number): void {
  const gitDir = git(wt, ['rev-parse', '--absolute-git-dir']).trim()
  const old = new Date(Date.now() - days * 86_400_000)
  for (const name of ['index', 'HEAD']) utimesSync(join(gitDir, name), old, old)
}

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString()
const dated = (n: number) => ({ GIT_AUTHOR_DATE: daysAgo(n), GIT_COMMITTER_DATE: daysAgo(n) })

/** A bare origin with master plus a clone; `throwaway` is a detached worktree of origin/master, as the sweep gets. */
function fixture(): { work: string; origin: string; throwaway: string } {
  const n = ++counter
  const origin = join(base, `origin-${n}.git`)
  const work = join(base, `work-${n}`)
  mkdirSync(origin)
  mkdirSync(work)
  git(origin, ['init', '-q', '--bare', '-b', 'master'])
  git(work, ['init', '-q', '-b', 'master'])
  git(work, ['remote', 'add', 'origin', origin])
  writeFileSync(join(work, 'a.txt'), 'a')
  git(work, ['add', '-A'])
  git(work, ['commit', '-q', '-m', 'init'])
  git(work, ['push', '-q', 'origin', 'master'])
  git(work, ['remote', 'set-head', 'origin', 'master'])
  const throwaway = join(base, 'hygiene', `t-${n}`)
  git(work, ['worktree', 'add', '-q', '--detach', throwaway, 'origin/master'])
  return { work, origin, throwaway }
}

/** Pushes a branch `name` with one commit dated `age` days ago; `mergeIt` fast-forwards master to it. */
function branch(work: string, name: string, age: number, mergeIt = false): void {
  git(work, ['checkout', '-q', '-b', name, 'master'])
  writeFileSync(join(work, `${name.replace('/', '-')}.txt`), name)
  git(work, ['add', '-A'])
  git(work, ['commit', '-q', '-m', name], dated(age))
  git(work, ['push', '-q', 'origin', name])
  git(work, ['checkout', '-q', 'master'])
  if (mergeIt) {
    git(work, ['merge', '-q', '--ff-only', name])
    git(work, ['push', '-q', 'origin', 'master'])
  }
  git(work, ['fetch', '-q', 'origin'])
}

describe('parseWorktrees', () => {
  test('drops the main checkout, keeps branch and prunable', () => {
    const text = [
      'worktree /tmp/main\nHEAD aaa\nbranch refs/heads/master',
      'worktree /tmp/x/wt-1\nHEAD bbb\nbranch refs/heads/feat/one',
      'worktree /tmp/x/wt-2\nHEAD ccc\ndetached\nprunable gitdir file points to non-existent location',
      '',
    ].join('\n\n')
    expect(parseWorktrees(text)).toEqual([
      { path: '/tmp/x/wt-1', head: 'bbb', branch: 'feat/one', prunable: false },
      { path: '/tmp/x/wt-2', head: 'ccc', branch: undefined, prunable: true },
    ])
    expect(shortPath('/tmp/x/wt-1')).toBe('x/wt-1')
  })
})

describe('staleProbe', () => {
  /** A gh whose `pr list` prints `json` and exits `exit`. */
  const fakeGh = (json = '[]', exit = 0): string => {
    const script = join(base, `gh-${++counter}`)
    writeFileSync(script, `#!/bin/sh\nprintf '%s' '${json}'\nexit ${exit}\n`)
    chmodSync(script, 0o755)
    return script
  }
  const headOf = (work: string, name: string): string => git(work, ['rev-parse', name]).trim()

  test('red: a squash-merged branch whose pull request merged at its tip counts as merged', async () => {
    const { work, throwaway } = fixture()
    branch(work, 'squash-one', 90)
    git(throwaway, ['fetch', '-q', 'origin'])
    const row = { headRefName: 'squash-one', headRefOid: headOf(work, 'squash-one'), isCrossRepository: false }
    const out = await staleProbe({ ...tools, gh: fakeGh(JSON.stringify([row])) }, throwaway)
    expect(out.findings.find((f) => f.key === 'stale:branches')?.lines).toEqual(['origin/squash-one (merged)'])
  })

  test('green: a pull request that merged at another head leaves its branch untouched', async () => {
    const { work, throwaway } = fixture()
    branch(work, 'reused-one', 90)
    git(throwaway, ['fetch', '-q', 'origin'])
    const row = { headRefName: 'reused-one', headRefOid: 'f'.repeat(40), isCrossRepository: false }
    const out = await staleProbe({ ...tools, gh: fakeGh(JSON.stringify([row])) }, throwaway)
    expect(out.findings.find((f) => f.key === 'stale:branches')?.lines).toEqual([
      'origin/reused-one (untouched 90 days)',
    ])
  })

  test("green: a gh that cannot read the repo leaves git's answer alone", async () => {
    const { work, throwaway } = fixture()
    branch(work, 'squash-two', 90)
    git(throwaway, ['fetch', '-q', 'origin'])
    const out = await staleProbe({ ...tools, gh: fakeGh('', 1) }, throwaway)
    expect(out.findings.find((f) => f.key === 'stale:branches')?.lines).toEqual([
      'origin/squash-two (untouched 90 days)',
    ])
  })

  test('red: merged and untouched branches, merged first then oldest', async () => {
    const { work, throwaway } = fixture()
    branch(work, 'old-one', 90)
    branch(work, 'older-one', 120)
    branch(work, 'fresh-one', 1)
    branch(work, 'done-one', 2, true)
    git(throwaway, ['fetch', '-q', 'origin'])
    const out = await staleProbe(tools, throwaway)
    expect(out.outcome).toBe('found')
    const branches = out.findings.find((f) => f.key === 'stale:branches')
    expect(branches?.title).toBe('Hygiene: stale remote branches')
    expect(branches?.lines).toEqual([
      'origin/done-one (merged)',
      'origin/older-one (untouched 120 days)',
      'origin/old-one (untouched 90 days)',
    ])
  })

  test('red: a merged linked worktree and a prunable one, never the throwaway or a hygiene dir', async () => {
    const { work, throwaway } = fixture()
    branch(work, 'done-two', 1, true)
    branch(work, 'live-two', 1)
    git(work, ['commit', '-q', '--allow-empty', '-m', 'later'])
    git(work, ['push', '-q', 'origin', 'master'])
    git(work, ['worktree', 'add', '-q', join(base, 'wts', `merged-${counter}`), 'done-two'])
    quiet(work, join(base, 'wts', `merged-${counter}`), 3)
    git(work, ['worktree', 'add', '-q', join(base, 'wts', `live-${counter}`), 'live-two'])
    git(work, ['worktree', 'add', '-q', join(base, 'wts', `gone-${counter}`), '-b', 'gone-two'])
    rmSync(join(base, 'wts', `gone-${counter}`), { recursive: true })
    const out = await staleProbe(tools, throwaway)
    const trees = out.findings.find((f) => f.key === 'stale:worktrees')
    expect(trees?.title).toBe('Hygiene: leftover worktrees')
    expect(trees?.lines.sort()).toEqual([
      `wts/gone-${counter} [gone-two] (prunable)`,
      `wts/merged-${counter} [done-two] (merged)`,
    ])
  })

  test('green: a young unmerged branch and a young worktree', async () => {
    const { work, throwaway } = fixture()
    branch(work, 'live-three', 1)
    git(work, ['worktree', 'add', '-q', join(base, 'wts', `live-${counter}`), 'live-three'])
    git(throwaway, ['fetch', '-q', 'origin'])
    expect((await staleProbe(tools, throwaway)).outcome).toBe('clean')
  })

  test('skipped: no remote branches and no linked worktrees', async () => {
    const dir = repo({ 'a.txt': 'x' })
    git(dir, ['worktree', 'add', '-q', '--detach', join(base, 'hygiene', `solo-${counter}`)])
    expect((await staleProbe(tools, join(base, 'hygiene', `solo-${counter}`))).outcome).toBe('skipped')
  })

  test('a fresh worktree on an old base is not merged until it has been quiet for 2 days', async () => {
    const { work, throwaway } = fixture()
    branch(work, 'lead-base', 40, true)
    git(work, ['commit', '-q', '--allow-empty', '-m', 'moved on'])
    git(work, ['push', '-q', 'origin', 'master'])
    const wt = join(base, 'wts', `fresh-${counter}`)
    git(work, ['worktree', 'add', '-q', wt, '-b', 'fresh-branch', 'HEAD~1'])
    const out = await staleProbe(tools, throwaway)
    expect(out.findings.find((f) => f.key === 'stale:worktrees')).toBeUndefined()
    quiet(work, wt, 3)
    const later = await staleProbe(tools, throwaway)
    expect(later.findings.find((f) => f.key === 'stale:worktrees')?.lines).toEqual([
      `wts/fresh-${counter} [fresh-branch] (merged)`,
    ])
  })

  test("a lead's own worktree is never flagged, merged and quiet or not", async () => {
    const { work, throwaway } = fixture()
    branch(work, 'lead-base', 40, true)
    git(work, ['commit', '-q', '--allow-empty', '-m', 'moved on'])
    git(work, ['push', '-q', 'origin', 'master'])
    const wt = join(base, 'wts', `factory-1-${counter}`)
    git(work, ['worktree', 'add', '-q', wt, '-b', 'factory/1-1', 'HEAD~1'])
    quiet(work, wt, 3)
    expect((await staleProbe(tools, throwaway)).findings.find((f) => f.key === 'stale:worktrees')).toBeUndefined()
  })

  test('a branch at the default tip is merged only once its tip is 2 days old', async () => {
    const { work, throwaway } = fixture()
    git(work, ['push', '-q', 'origin', 'master:refs/heads/same-tip'])
    git(throwaway, ['fetch', '-q', 'origin'])
    expect((await staleProbe(tools, throwaway)).findings.find((f) => f.key === 'stale:branches')).toBeUndefined()
  })
})
