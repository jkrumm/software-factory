/* oxlint-disable typescript/await-thenable -- bun types the `rejects` matchers as void; they return a promise */
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { GitWorktrees, WorktreeFailed, worktreeOf } from '../src/issues/worktree.ts'
import { repoRoot } from './support/repos.ts'

const fixture = repoRoot('factory-worktree-')
afterAll(() => fixture.cleanup())

/** A clone of a repo with an origin, so `git fetch origin` has something to fetch. */
function cloneOf(name: string) {
  const origin = fixture.repo(`${name}-origin`, { 'README.md': 'one' })
  const clone = join(fixture.root, name)
  fixture.git(fixture.root, 'clone', '-q', origin, clone)
  return { origin, clone }
}

describe('GitWorktrees', () => {
  test('cuts the branch from the fetched default branch, not from a checkout that is behind', async () => {
    const { origin, clone } = cloneOf('behind')
    fixture.commit(origin, { 'NEW.md': 'pushed after the clone' })
    const made = await new GitWorktrees().create({ repo: clone, branch: 'factory/3-1' })
    expect(made.path).toBe(join(clone, '.claude', 'worktrees', 'factory-3-1'))
    expect(made.base).toBe('origin/master')
    expect(made.sha).toBe(fixture.git(origin, 'rev-parse', 'HEAD'))
    expect(existsSync(join(made.path, 'NEW.md'))).toBe(true)
    expect(fixture.git(made.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('factory/3-1')
    // Cut from origin/master, it must not track it: a bare push would target the default branch.
    expect(
      Bun.spawnSync(['git', '-C', made.path, 'rev-parse', '--abbrev-ref', '@{upstream}'], { stderr: 'pipe' }).exitCode,
    ).not.toBe(0)
  })

  test('the same branch answers its worktree again, so a start that crashed after the checkout finds it', async () => {
    const { clone } = cloneOf('again')
    const git = new GitWorktrees()
    const first = await git.create({ repo: clone, branch: 'factory/4-1' })
    const second = await git.create({ repo: clone, branch: 'factory/4-1' })
    expect(second.path).toBe(first.path)
  })

  test('a branch that exists with no worktree is somebody else’s and is refused', async () => {
    const { clone } = cloneOf('taken')
    fixture.git(clone, 'branch', 'factory/5-1')
    await expect(new GitWorktrees().create({ repo: clone, branch: 'factory/5-1' })).rejects.toThrow('already exists')
  })

  test('no origin, or a timeout, is a failure that says which step', async () => {
    const lonely = fixture.repo('lonely', {})
    await expect(new GitWorktrees().create({ repo: lonely, branch: 'factory/6-1' })).rejects.toBeInstanceOf(
      WorktreeFailed,
    )
    const slow = new GitWorktrees({ run: async () => ({ exitCode: -1, stdout: '' }) })
    await expect(slow.create({ repo: lonely, branch: 'factory/6-2' })).rejects.toThrow(
      'git fetch origin did not finish',
    )
  })

  test('a repo with a .wtp.yml and no wtp is refused: plain git would skip its setup', async () => {
    const { clone } = cloneOf('wtp')
    await Bun.write(join(clone, '.wtp.yml'), 'version: "1.0"\n')
    // An empty `wtp` is a host without it.
    await expect(new GitWorktrees({ wtp: '' }).create({ repo: clone, branch: 'factory/7-1' })).rejects.toThrow(
      'install wtp',
    )
  })

  test('worktreeOf reads git’s listing', () => {
    const listing =
      'worktree /a\nHEAD abc\nbranch refs/heads/master\n\nworktree /a/.claude/worktrees/x\nHEAD def\nbranch refs/heads/factory/1-1\n'
    expect(worktreeOf(listing, 'factory/1-1')).toBe('/a/.claude/worktrees/x')
    expect(worktreeOf(listing, 'factory/2-1')).toBeUndefined()
  })
})
