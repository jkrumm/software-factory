import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  nextKey,
  parseSpool,
  type SpoolLine,
  spoolFileName,
  summarize,
  parseSummary,
} from '@software-factory/contract/spool'
import { rootedRepos } from '../../src/adapters/git/repos.ts'
import { gitWorktrees } from '../../src/adapters/git/worktrees.ts'
import { terminalName, tabId } from '../../src/adapters/hc/terminals.ts'
import { SpoolReplayer } from '../../src/adapters/leads/spool.ts'
import { loadLeadSettings } from '../../src/adapters/leads/settings.ts'

let base: string

beforeAll(() => {
  base = realpathSync(mkdtempSync('/tmp/factory-adapters-'))
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('the trust boundary', () => {
  const root = () => join(base, 'root')
  beforeAll(() => {
    mkdirSync(join(root(), 'proj'), { recursive: true })
    mkdirSync(join(base, 'outside', 'secret'), { recursive: true })
    mkdirSync(join(base, 'root-evil', 'proj'), { recursive: true })
    writeFileSync(join(root(), 'a-file'), '')
    symlinkSync(join(base, 'outside', 'secret'), join(root(), 'link-out'))
    symlinkSync(join(root(), 'proj'), join(root(), 'link-in'))
  })
  const locate = (repo: string) => rootedRepos([root()]).locate(repo)

  test('a name under a root, or a path inside it, is a repo; the link inside resolves to its target', async () => {
    const real = (await locate('proj')).ok && (await locate('proj'))
    expect(real).toMatchObject({ ok: true })
    expect(await locate(join(root(), 'proj'))).toEqual(await locate('proj'))
    expect(await locate('link-in')).toEqual(await locate('proj'))
  })

  test.each([
    ['..', 'a parent of the root'],
    ['../outside/secret', 'a path through ..'],
    ['link-out', 'a link out of the roots'],
    ['a-file', 'a file'],
    ['missing', 'a missing directory'],
    ['', 'the root itself'],
    ['@evil', 'a sibling that shares the root name as a prefix'],
    ['/etc', 'an absolute path elsewhere'],
  ])('%p (%s) is refused', async (repo) => {
    const result = await locate(repo === '@evil' ? join(base, 'root-evil', 'proj') : repo)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error.kind).toBe('refused')
  })
})

describe('the spool replay', () => {
  const dirOf = () => mkdtempSync(join(base, 'spool-'))
  const append = (dir: string, session: string, kind: SpoolLine['kind'], at = '2026-11-07T10:00:00.000Z') => {
    const file = join(dir, spoolFileName(session))
    const lines = existsSync(file) ? parseSpool(readFileSync(file, 'utf8')) : []
    const summary = summarize(
      parseSummary(existsSync(`${file}.base`) ? readFileSync(`${file}.base`, 'utf8') : ''),
      lines,
    )
    const line: SpoolLine = { key: nextKey(summary, session, kind), session, kind, at }
    appendFileSync(file, `${JSON.stringify(line)}\n`)
    return line
  }

  test('lines past the offset go to the sink once; a line still being written waits for its newline', async () => {
    const dir = dirOf()
    const seen: string[] = []
    const replayer = new SpoolReplayer({
      dir,
      now: () => new Date(),
      sink: async (lines) => void seen.push(...lines.map((l) => l.key)),
    })
    append(dir, 'lead-1-1', 'session_started')
    append(dir, 'lead-1-1', 'turn_started')
    expect((await replayer.replay()).lines).toBe(2)
    expect((await replayer.replay()).lines).toBe(0)
    appendFileSync(join(dir, spoolFileName('lead-1-1')), '{"key":"half')
    expect((await replayer.replay()).lines).toBe(0)
    expect(seen).toEqual(['lead-1-1:session_started:0', 'lead-1-1:turn_started:1'])
  })

  test('a sink that fails holds the offset: the lines come again', async () => {
    const dir = dirOf()
    let fail = true
    const seen: string[] = []
    const replayer = new SpoolReplayer({
      dir,
      now: () => new Date(),
      sink: async (lines) => {
        if (fail) throw new Error('the database is down')
        seen.push(...lines.map((l) => l.key))
      },
    })
    append(dir, 'lead-1-1', 'session_started')
    await replayer.replay()
    expect(seen).toEqual([])
    fail = false
    expect((await replayer.replay()).lines).toBe(1)
    expect(seen).toEqual(['lead-1-1:session_started:0'])
  })

  test('a quiet, read, large file is rotated and the numbering carries on from its sums', async () => {
    const dir = dirOf()
    const replayer = new SpoolReplayer({
      dir,
      now: () => new Date(Date.now() + 3_600_000),
      sink: async () => {},
      rotateBytes: 100,
      quietMs: 1,
    })
    for (let i = 0; i < 4; i++) append(dir, 'lead-1-1', i % 2 === 0 ? 'turn_started' : 'turn_ended')
    const result = await replayer.replay()
    expect(result.rotated).toEqual([spoolFileName('lead-1-1')])
    expect(existsSync(join(dir, spoolFileName('lead-1-1')))).toBe(false)
    const next = append(dir, 'lead-1-1', 'turn_started')
    expect(next.key).toBe('lead-1-1:turn_started:3')
    expect(existsSync(join(dir, `${spoolFileName('lead-1-1')}.retired`))).toBe(false)
  })
})

describe('git worktrees', () => {
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
    return work
  }
  const trees = gitWorktrees()
  const value = async <T>(
    promise: Promise<{ ok: true; value: T } | { ok: false; error: { detail: string } }>,
  ): Promise<T> => {
    const result = await promise
    if (!result.ok) throw new Error(result.error.detail)
    return result.value
  }

  test('create cuts the branch from the remote default and is idempotent per branch', async () => {
    const work = await repo()
    const first = await value(trees.create({ repo: work, branch: 'factory/1-1' }))
    expect(first.base).toBe('origin/master')
    expect(first.sha).toBe(await git(work, 'rev-parse', 'origin/master'))
    expect(existsSync(join(first.path, 'a.txt'))).toBe(true)
    const again = await value(trees.create({ repo: work, branch: 'factory/1-1' }))
    expect(again).toEqual(first)
  })

  test('remove takes a clean worktree whose branch is on the base; one with changes or commits is kept, and says why', async () => {
    const work = await repo()
    const clean = await value(trees.create({ repo: work, branch: 'factory/2-1' }))
    expect(await value(trees.remove({ repo: work, branch: 'factory/2-1' }))).toEqual({ removed: true })
    expect(existsSync(clean.path)).toBe(false)

    const dirty = await value(trees.create({ repo: work, branch: 'factory/3-1' }))
    writeFileSync(join(dirty.path, 'new.txt'), 'x')
    expect(await value(trees.remove({ repo: work, branch: 'factory/3-1' }))).toEqual({
      kept: 'it has uncommitted changes',
      path: dirty.path,
    })

    const ahead = await value(trees.create({ repo: work, branch: 'factory/4-1' }))
    writeFileSync(join(ahead.path, 'b.txt'), 'b')
    await git(ahead.path, 'add', '.')
    await git(ahead.path, 'commit', '-q', '-m', 'work')
    expect(await value(trees.remove({ repo: work, branch: 'factory/4-1' }))).toEqual({
      kept: 'its commits are not on origin/master',
      path: ahead.path,
    })
    // pushed and merged on the remote: now it is on the base
    await git(ahead.path, 'push', '-q', 'origin', 'factory/4-1:master')
    expect(await value(trees.remove({ repo: work, branch: 'factory/4-1' }))).toEqual({ removed: true })
  })

  test('a branch somebody else made, with commits and no finished setup, is left as it is', async () => {
    const work = await repo()
    await git(work, 'checkout', '-q', '-b', 'factory/5-1')
    writeFileSync(join(work, 'c.txt'), 'c')
    await git(work, 'add', '.')
    await git(work, 'commit', '-q', '-m', 'theirs')
    await git(work, 'checkout', '-q', 'master')
    const result = await trees.create({ repo: work, branch: 'factory/5-1' })
    expect(result.ok).toBe(false)
  })
})

describe('names and settings', () => {
  test('a terminal name is hc-valid and never an address; a tab id is stable', () => {
    expect(terminalName('lead-286-2')).toBe('lead-286-2')
    expect(terminalName('t7')).toMatch(/^f-[0-9a-f]{6}-t7$/)
    expect(terminalName('Lead 286/2 with a very long key that goes past thirty-two characters')).toMatch(
      /^[a-z][a-z0-9-]{0,31}$/,
    )
    expect(tabId('lead-286-2')).toBe(tabId('lead-286-2'))
    expect(tabId('lead-286-2')).not.toBe(tabId('lead-286-3'))
  })

  test('the defaults come from HOME; relative roots refuse the start', () => {
    const settings = loadLeadSettings({ HOME: '/home/x' })
    expect(settings).toMatchObject({
      tickMs: 10_000,
      repoRoots: ['/home/x/SourceRoot', '/home/x/IuRoot'],
      socket: '/home/x/.local/share/factory/hook.sock',
      spoolDir: '/home/x/.local/share/factory/spool',
      startBudgetMs: 1_800_000,
    })
    expect(() => loadLeadSettings({ HOME: '/home/x', FACTORY_REPO_ROOTS: 'relative' })).toThrow(/absolute/)
    expect(() => loadLeadSettings({ HOME: '/home/x', FACTORY_TICK_MS: 'soon' })).toThrow(/FACTORY_TICK_MS/)
  })
})
