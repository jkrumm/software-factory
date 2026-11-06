import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MakeAndProbes } from '../src/issues/hold.ts'
import { syncCheckout } from '../src/issues/origin.ts'

let root: string
let origin: string
let clone: string
let work: string

const git = (cwd: string, ...args: string[]) => {
  const run = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`)
  return run.stdout.toString().trim()
}

/** A commit pushed to origin from `work`, a second clone: the way the lead's merge reaches the remote. */
function land(files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) writeFileSync(join(work, path), content)
  git(work, 'add', '-A')
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'c')
  git(work, 'push', '-q', 'origin', 'master')
  return git(work, 'rev-parse', 'HEAD')
}

const localCommit = (path: string) => {
  writeFileSync(join(clone, path), 'own')
  git(clone, 'add', '-A')
  git(clone, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'own')
}

const makefile = (verify: string) => `verify:\n\t@${verify}\n`

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'factory-sync-'))
  origin = join(root, 'origin.git')
  work = join(root, 'work')
  clone = join(root, 'clone')
  git(root, 'init', '-q', '--bare', '-b', 'master', origin)
  git(root, 'clone', '-q', origin, work)
  git(work, 'checkout', '-q', '-b', 'master')
  writeFileSync(join(work, 'Makefile'), makefile('echo old; exit 1'))
  writeFileSync(join(work, 'a.txt'), 'a')
  git(work, 'add', '-A')
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'first')
  git(work, 'push', '-q', 'origin', 'master')
  git(root, 'clone', '-q', origin, clone)
  git(clone, 'remote', 'set-head', 'origin', 'master')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('syncCheckout', () => {
  test('behind, clean and on the default branch: fast-forwarded to origin', async () => {
    const sha = land({ 'a.txt': 'b' })
    const result = await syncCheckout(clone)
    expect(result.state).toBe('advanced')
    expect(result.detail).toContain(sha.slice(0, 12))
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(sha)
  })

  test('current: nothing to do, ahead or with a dirty tree too', async () => {
    expect((await syncCheckout(clone)).state).toBe('current')
    localCommit('own.txt')
    writeFileSync(join(clone, 'a.txt'), 'dirty')
    const head = git(clone, 'rev-parse', 'HEAD')
    expect((await syncCheckout(clone)).state).toBe('current')
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(head)
  })

  test('a tracked change while behind: blocked, tree and HEAD untouched', async () => {
    land({ 'b.txt': 'b' })
    writeFileSync(join(clone, 'a.txt'), 'dirty')
    const head = git(clone, 'rev-parse', 'HEAD')
    const result = await syncCheckout(clone)
    expect(result).toMatchObject({ state: 'blocked' })
    expect(result.detail).toContain('uncommitted changes (a.txt)')
    expect(result.detail).toContain(clone)
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(clone, 'status', '--porcelain')).toContain('a.txt')
  })

  test('an untracked file does not block', async () => {
    land({ 'b.txt': 'b' })
    writeFileSync(join(clone, 'scratch.txt'), 'x')
    expect((await syncCheckout(clone)).state).toBe('advanced')
  })

  test('diverged: blocked, unchanged', async () => {
    land({ 'b.txt': 'b' })
    localCommit('own.txt')
    const head = git(clone, 'rev-parse', 'HEAD')
    const result = await syncCheckout(clone)
    expect(result.state).toBe('blocked')
    expect(result.detail).toContain('diverged from origin/master: 1 ahead, 1 behind')
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(head)
  })

  test('on a feature branch while behind: blocked, unchanged', async () => {
    land({ 'b.txt': 'b' })
    git(clone, 'checkout', '-q', '-b', 'feature')
    const head = git(clone, 'rev-parse', 'HEAD')
    const result = await syncCheckout(clone)
    expect(result.state).toBe('blocked')
    expect(result.detail).toContain('on branch feature, not master')
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(head)
  })

  test('a detached HEAD while behind is blocked', async () => {
    land({ 'b.txt': 'b' })
    git(clone, 'checkout', '-q', '--detach')
    expect((await syncCheckout(clone)).state).toBe('blocked')
  })

  test('no remote to fetch from: unknown', async () => {
    git(clone, 'remote', 'set-url', 'origin', join(root, 'gone.git'))
    expect((await syncCheckout(clone)).state).toBe('unknown')
  })
})

describe('MakeAndProbes and the checkout', () => {
  test('a checkout behind origin verifies the new commit at the first try', async () => {
    land({ Makefile: makefile('echo new; exit 0') })
    const checks = await new MakeAndProbes().run({ repo: clone, makeVerify: true, probes: [] })
    expect(checks.map((c) => [c.name, c.ok])).toEqual([
      ['checkout', true],
      ['make verify', true],
    ])
    expect(checks[1]?.detail).toContain('new')
  })

  test('a blocked checkout returns the blocked check and runs no make', async () => {
    land({ Makefile: makefile('echo new; exit 0') })
    writeFileSync(join(clone, 'a.txt'), 'dirty')
    const checks = await new MakeAndProbes().run({
      repo: clone,
      makeVerify: true,
      version: { landedAt: 'x' },
      probes: [],
    })
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ name: 'checkout', ok: false, blocked: true })
    expect(git(clone, 'show', 'HEAD:Makefile')).toContain('old')
  })

  test('a sync that throws is a blocked checkout, not an error, and the probes still report', async () => {
    const throwing = new MakeAndProbes({
      sync: async () => {
        throw new Error('git status did not finish in time')
      },
    })
    const checks = await throwing.run({ repo: clone, makeVerify: true, probes: [] })
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ name: 'checkout', ok: false, blocked: true })
    expect(checks[0]?.detail).toContain('did not finish')
  })

  test('with nothing that reads the checkout, it is not synced', async () => {
    land({ 'b.txt': 'b' })
    const head = git(clone, 'rev-parse', 'HEAD')
    expect(await new MakeAndProbes().run({ repo: clone, makeVerify: false, probes: [] })).toEqual([])
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(head)
  })
})
