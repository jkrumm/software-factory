import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HcRunner, tabId } from '../src/hc-runner.ts'
import { RunnerError } from '../src/runner.ts'
import { Spaces } from '../src/spaces.ts'
import { FakeClock } from './support/clock.ts'
import { createFakeHc, type FakeHc } from './support/hc.ts'

// RS6: every listed repo has a space and a `plan:` tab that is a shell and is never closed.
let hc: FakeHc
let base: string
let runner: HcRunner
let clock: FakeClock
let roots: string[]

beforeAll(async () => {
  hc = await createFakeHc()
  base = await realpath(await mkdtemp('/tmp/factory-spaces-'))
})
afterAll(async () => {
  await hc.cleanup()
  await rm(base, { recursive: true, force: true })
})
beforeEach(async () => {
  await hc.reset()
  clock = new FakeClock()
  roots = [join(base, 'SourceRoot')]
  runner = new HcRunner({
    bin: hc.bin,
    clock,
    pretrustBin: hc.pretrustBin,
    accountsFile: hc.accountsFile,
    home: '/home/me',
    deliverWaitMs: 3_000,
  })
})

const repo = async (name: string, root = 'SourceRoot'): Promise<string> => {
  const path = join(base, root, name)
  await mkdir(path, { recursive: true })
  return path
}
let n = 0
const list = async (...entries: { name: string; path: string }[]): Promise<string> => {
  const file = join(base, `spaces-${++n}.json`)
  await writeFile(file, JSON.stringify({ spaces: entries }))
  return file
}
const spacesOf = (file: string, over: { intervalMs?: number } = {}) =>
  new Spaces({ file, roots, runner, now: () => clock.now(), ...over })

const WRITES = /^(terminal\.(run|rm|kill)|doc\.set) /
const writes = async () => (await hc.calls()).filter((call) => WRITES.test(call))
const terminals = async () => (await hc.state()).terminals
const planOf = async (name: string) => (await terminals()).filter((t) => t.labels['factory.key'] === `plan:${name}`)

describe('the fixed spaces', () => {
  test('an entry gets its space and a plan tab: a shell in the repo, kept, with no parent', async () => {
    const path = await repo('app')
    const result = await spacesOf(await list({ name: 'app', path })).reconcile()
    expect(result).toEqual({ started: ['app'], present: [], skipped: [], errors: [] })

    const [run] = (await hc.state()).runs
    expect(run?.params).toMatchObject({
      cwd: path,
      keep: true,
      no_parent: true,
      labels: {
        'factory.key': 'plan:app',
        'herdr.tab': tabId('plan:app'),
        'factory.tab_name': 'plan',
        'herdr.space': expect.stringMatching(/^sp-app-/),
      },
    })
    // no argv: the core runs the machine's own shell; nothing here is Claude Code, so no pretrust and no account
    expect(run?.params.argv).toBeUndefined()
    expect(await hc.pretrustCalls()).toEqual([])
    const [terminal] = await planOf('app')
    expect(terminal?.state).toBe('live')
    expect(terminal?.keep).toBe(true)

    // the app's document names the space after the repo and roots it at the repo
    const doc = (await hc.state()).docs['herdr-app']?.value as {
      spaces: { id: string; name: string; folder: string; tabs: unknown[] }[]
    }
    expect(doc.spaces).toEqual([
      {
        id: (await planOf('app'))[0]?.labels['herdr.space'] as string,
        name: 'app',
        folder: path,
        tabs: [],
      },
    ])
  })

  test('a space the app already has, by its folder, is used and not seeded again', async () => {
    const path = await repo('app')
    await hc.setDoc('herdr-app', { spaces: [{ id: 'sp259fabc', name: 'app', folder: path, tabs: [] }] })
    await spacesOf(await list({ name: 'app', path })).reconcile()
    const [terminal] = await planOf('app')
    expect(terminal?.labels['herdr.space']).toBe('sp259fabc')
    expect(await hc.callsOf('doc.set')).toHaveLength(0) // seeded nothing, and nameTab finds no tab entry yet
  })

  test('entries go in file order', async () => {
    const [a, b, c] = [await repo('a'), await repo('b'), await repo('c')]
    await spacesOf(await list({ name: 'b', path: b }, { name: 'c', path: c }, { name: 'a', path: a })).reconcile()
    const keys = (await hc.state()).runs.map((r) => (r.params.labels as Record<string, string>)['factory.key'])
    expect(keys).toEqual(['plan:b', 'plan:c', 'plan:a'])
  })

  test('a second reconcile with nothing changed starts nothing and writes nothing', async () => {
    const [a, b] = [await repo('a'), await repo('b')]
    const spaces = spacesOf(await list({ name: 'a', path: a }, { name: 'b', path: b }))
    await spaces.reconcile()
    const before = (await hc.calls()).length
    const again = await spaces.reconcile()
    expect(again).toEqual({ started: [], present: ['a', 'b'], skipped: [], errors: [] })
    const after = (await hc.calls()).slice(before)
    expect(after.length).toBeGreaterThan(0)
    expect(after.filter((call) => WRITES.test(call))).toEqual([])
    expect(await terminals()).toHaveLength(2)
  })

  test('an entry outside the roots and a path that does not exist are skipped, and the rest goes on', async () => {
    const inside = await repo('app')
    const outside = await repo('app', 'IuRoot')
    const link = join(base, 'SourceRoot', 'sneaky')
    await symlink(outside, link)
    const result = await spacesOf(
      await list(
        { name: 'iu', path: outside },
        { name: 'sneaky', path: link },
        { name: 'gone', path: join(base, 'SourceRoot', 'gone') },
        { name: 'app', path: inside },
      ),
    ).reconcile()
    expect(result.started).toEqual(['app'])
    expect(result.skipped.map((s) => s.name)).toEqual(['iu', 'sneaky', 'gone'])
    expect((await terminals()).map((t) => t.labels['factory.key'])).toEqual(['plan:app'])
  })

  test('a plan terminal that is dead is started again under the same key and tab', async () => {
    const path = await repo('app')
    const spaces = spacesOf(await list({ name: 'app', path }))
    await spaces.reconcile()
    const [first] = await planOf('app')
    await hc.finish(first?.address as string)

    expect((await spaces.reconcile()).started).toEqual(['app'])
    const now = await planOf('app')
    expect(now).toHaveLength(1)
    expect(now[0]?.address).not.toBe(first?.address)
    expect(now[0]?.state).toBe('live')
    expect(now[0]?.labels['herdr.tab']).toBe(first?.labels['herdr.tab'])
    expect(now[0]?.labels['herdr.space']).toBe(first?.labels['herdr.space'])
    // a live one that lost its program is still a live shell under the label: nothing to do
    expect((await spaces.reconcile()).present).toEqual(['app'])
  })

  test('an absent or invalid file does nothing and is said once', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const absent = spacesOf(join(base, 'no-such-file.json'))
      expect(await absent.reconcile()).toEqual({ started: [], present: [], skipped: [], errors: [] })
      await absent.reconcile()
      expect(warn).toHaveBeenCalledTimes(1)

      for (const text of [
        'not json',
        '{"spaces": [{"name": "a"}]}',
        '{"spaces": [{"name": "a b", "path": "/x"}]}',
        '[]',
      ]) {
        const file = join(base, `bad-${++n}.json`)
        await writeFile(file, text)
        expect(await spacesOf(file).reconcile()).toEqual({ started: [], present: [], skipped: [], errors: [] })
      }
      expect(warn).toHaveBeenCalledTimes(5)
    } finally {
      warn.mockRestore()
    }
    expect(await hc.calls()).toEqual([])
  })

  test('one repo failing holds nothing back, and the next pass looks again', async () => {
    const [a, b] = [await repo('a'), await repo('b')]
    await hc.plan('terminal.list:error')
    const spaces = spacesOf(await list({ name: 'a', path: a }, { name: 'b', path: b }))
    const first = await spaces.reconcile()
    expect(first.errors).toHaveLength(1)
    expect(first.errors[0]).toStartWith('a: ')
    expect(first.started).toEqual(['b'])
    expect((await spaces.reconcile()).started).toEqual(['a'])
  })

  test('kick runs a pass at once, then waits out its interval, and never throws', async () => {
    const path = await repo('app')
    const spaces = spacesOf(await list({ name: 'app', path }), { intervalMs: 600_000 })
    spaces.kick()
    spaces.kick()
    await spaces.settled()
    expect(await planOf('app')).toHaveLength(1)

    const calls = (await hc.calls()).length
    clock.advance(599_000)
    spaces.kick()
    await spaces.settled()
    expect((await hc.calls()).length).toBe(calls)

    clock.advance(2_000)
    spaces.kick()
    await spaces.settled()
    expect((await hc.calls()).length).toBeGreaterThan(calls)

    const broken = spacesOf(join(base, 'missing.json'))
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => broken.kick()).not.toThrow()
    await broken.settled()
    warn.mockRestore()
  })
})

describe('a plan tab is never closed', () => {
  test('close of a plan: key is refused and touches nothing', async () => {
    const path = await repo('app')
    await spacesOf(await list({ name: 'app', path })).reconcile()
    const before = (await hc.calls()).length
    const error = (await runner.close('plan:app').catch((e: unknown) => e)) as RunnerError
    expect(error).toBeInstanceOf(RunnerError)
    expect(error.permanent).toBe(true)
    expect((await hc.calls()).length).toBe(before)
    expect((await planOf('app'))[0]?.state).toBe('live')
  })

  test('a spawn cannot be started under a plan: key', async () => {
    const error = (await runner
      .start({
        key: 'plan:app',
        repo: '/work/app',
        role: 'lead',
        prompt: 'go',
        account: 'a',
        tier: 'sonnet',
        effort: 'high',
      })
      .catch((e: unknown) => e)) as RunnerError
    expect(error).toBeInstanceOf(RunnerError)
    expect(error.permanent).toBe(true)
    expect(await hc.calls()).toEqual([])
  })

  test('closing a spawn of the same repo leaves the plan tab alone', async () => {
    const path = await repo('app')
    await spacesOf(await list({ name: 'app', path })).reconcile()
    await runner.start({
      key: 'lead-1-1',
      repo: path,
      role: 'lead',
      prompt: 'go',
      account: 'a',
      tier: 'sonnet',
      effort: 'high',
    })
    await runner.close('lead-1-1')
    expect((await terminals()).map((t) => t.labels['factory.key'])).toEqual(['plan:app'])
    expect((await planOf('app'))[0]?.state).toBe('live')
    expect(await writes()).not.toContainEqual(expect.stringContaining('terminal.kill {"terminal":"t1"}'))
  })
})
