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
    const { origin, clone } = cloneOf('wtp')
    fixture.commit(origin, { '.wtp.yml': 'version: "1.0"\n' })
    // An empty `wtp` is a host without it.
    await expect(new GitWorktrees({ wtp: '' }).create({ repo: clone, branch: 'factory/7-1' })).rejects.toThrow(
      'install wtp',
    )
  })

  test('a .wtp.yml that is only in this checkout is not the repo’s, and one the base has decides though this checkout is behind', async () => {
    const { clone } = cloneOf('wtp-local')
    await Bun.write(join(clone, '.wtp.yml'), 'version: "1.0"\n')
    const made = await new GitWorktrees({ wtp: '' }).create({ repo: clone, branch: 'factory/7-2' })
    expect(existsSync(made.path)).toBe(true)
  })

  test('a setup that failed leaves nothing behind, so a retry starts clean', async () => {
    const { origin, clone } = cloneOf('half')
    fixture.commit(origin, { '.wtp.yml': 'version: "1.0"\n' })
    // A `wtp` that makes the worktree and then fails in the repo's own hook.
    const script = join(fixture.root, 'wtp-fails')
    await Bun.write(script, `#!/bin/sh\ngit worktree add -q -b "$3" .claude/worktrees/half "$4"\nexit 1\n`)
    Bun.spawnSync(['chmod', '+x', script])
    await expect(new GitWorktrees({ wtp: script }).create({ repo: clone, branch: 'factory/8-1' })).rejects.toThrow(
      'wtp add failed',
    )
    expect(existsSync(join(clone, '.claude', 'worktrees', 'half'))).toBe(false)
    expect(fixture.git(clone, 'branch', '--list', 'factory/8-1')).toBe('')
  })

  test('a worktree a crash left half made is removed and made again; one made whole is answered', async () => {
    const { clone } = cloneOf('crash')
    const git = new GitWorktrees()
    // The state a process that died inside the setup leaves: the branch and the worktree, no marker.
    const left = join(clone, '.claude', 'worktrees', 'factory-9-1')
    fixture.git(clone, 'worktree', 'add', '-q', '-b', 'factory/9-1', left, 'origin/master')
    await Bun.write(join(left, 'half.txt'), 'nobody worked here')
    const made = await git.create({ repo: clone, branch: 'factory/9-1' })
    expect(made.path).toBe(left)
    expect(existsSync(join(left, 'half.txt'))).toBe(false)
    await Bun.write(join(left, 'work.txt'), 'somebody works here')
    await git.create({ repo: clone, branch: 'factory/9-1' })
    expect(existsSync(join(left, 'work.txt'))).toBe(true)
  })

  test('a marker a crash left empty is no finished setup', async () => {
    const { clone } = cloneOf('empty-marker')
    const git = new GitWorktrees()
    const made = await git.create({ repo: clone, branch: 'factory/9-4' })
    const dir = fixture.git(made.path, 'rev-parse', '--absolute-git-dir')
    await Bun.write(join(dir, 'factory-ready'), '')
    await Bun.write(join(made.path, 'half.txt'), 'x')
    const again = await git.create({ repo: clone, branch: 'factory/9-4' })
    expect(again.sha).toBe(made.sha)
    expect(existsSync(join(made.path, 'half.txt'))).toBe(false)
  })

  test('a branch with commits and no finished setup is not deleted', async () => {
    const { clone } = cloneOf('worked')
    const left = join(clone, '.claude', 'worktrees', 'factory-9-2')
    fixture.git(clone, 'worktree', 'add', '-q', '-b', 'factory/9-2', left, 'origin/master')
    fixture.commit(left, { 'work.txt': 'somebody worked here' })
    await expect(new GitWorktrees().create({ repo: clone, branch: 'factory/9-2' })).rejects.toThrow('has commits')
    expect(existsSync(join(left, 'work.txt'))).toBe(true)
  })

  test('a worktree answered again gives the sha it was cut from, not where the base is now', async () => {
    const { origin, clone } = cloneOf('moved')
    const git = new GitWorktrees()
    const first = await git.create({ repo: clone, branch: 'factory/9-3' })
    fixture.commit(origin, { 'NEW.md': 'x' })
    expect((await git.create({ repo: clone, branch: 'factory/9-3' })).sha).toBe(first.sha)
  })

  test('remove: a clean worktree whose commits are on the base goes, with its branch', async () => {
    const { origin, clone } = cloneOf('gone')
    fixture.git(origin, 'config', 'receive.denyCurrentBranch', 'ignore')
    const git = new GitWorktrees()
    const made = await git.create({ repo: clone, branch: 'factory/10-1' })
    fixture.commit(made.path, { 'a.txt': 'x' })
    fixture.git(made.path, 'push', '-q', 'origin', 'HEAD:master')
    expect(await git.remove({ repo: clone, branch: 'factory/10-1' })).toEqual({ removed: true })
    expect(existsSync(made.path)).toBe(false)
    expect(fixture.git(clone, 'branch', '--list', 'factory/10-1')).toBe('')
    expect(await git.remove({ repo: clone, branch: 'factory/10-1' })).toEqual({ removed: true })
  })

  test('remove: a squash merged on the remote counts, found after a fetch', async () => {
    const { origin, clone } = cloneOf('squash')
    const git = new GitWorktrees()
    const made = await git.create({ repo: clone, branch: 'factory/11-1' })
    fixture.commit(made.path, { 'a.txt': 'one' })
    fixture.commit(made.path, { 'a.txt': 'two' })
    fixture.commit(origin, { 'a.txt': 'two' })
    expect(await git.remove({ repo: clone, branch: 'factory/11-1' })).toEqual({ removed: true })
  })

  test('remove: uncommitted work and commits not on the base are kept, and say why', async () => {
    const { clone } = cloneOf('kept')
    const git = new GitWorktrees()
    const dirty = await git.create({ repo: clone, branch: 'factory/12-1' })
    await Bun.write(join(dirty.path, 'wip.txt'), 'x')
    expect(await git.remove({ repo: clone, branch: 'factory/12-1' })).toEqual({
      kept: 'it has uncommitted changes',
      path: dirty.path,
    })
    expect(existsSync(dirty.path)).toBe(true)

    const ahead = await git.create({ repo: clone, branch: 'factory/12-2' })
    fixture.commit(ahead.path, { 'b.txt': 'x' })
    expect(await git.remove({ repo: clone, branch: 'factory/12-2' })).toEqual({
      kept: 'its commits are not on origin/master',
      path: ahead.path,
    })
    expect(existsSync(ahead.path)).toBe(true)
    expect(fixture.git(clone, 'branch', '--list', 'factory/12-2')).toContain('factory/12-2')
  })

  test('worktreeOf reads git’s listing', () => {
    const listing =
      'worktree /a\nHEAD abc\nbranch refs/heads/master\n\nworktree /a/.claude/worktrees/x\nHEAD def\nbranch refs/heads/factory/1-1\n'
    expect(worktreeOf(listing, 'factory/1-1')).toBe('/a/.claude/worktrees/x')
    expect(worktreeOf(listing, 'factory/2-1')).toBeUndefined()
  })
})
