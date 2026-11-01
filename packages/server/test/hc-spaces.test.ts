import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { HcRunner } from '../src/hc-runner.ts'
import { RunnerError, type StartInput } from '../src/runner.ts'
import { FakeClock } from './support/clock.ts'
import { createFakeHc, type FakeHc } from './support/hc.ts'

// FL6: a space is keyed by path. The names below are paths that do not exist; the runner takes them as they are.
let hc: FakeHc
let runner: HcRunner

beforeAll(async () => {
  hc = await createFakeHc()
})
afterAll(() => hc.cleanup())
beforeEach(async () => {
  await hc.reset()
  runner = new HcRunner({
    bin: hc.bin,
    clock: new FakeClock(),
    pretrustBin: hc.pretrustBin,
    accountsFile: hc.accountsFile,
    home: '/home/me',
    deliverWaitMs: 3_000,
  })
})

const start = (key: string, repo: string, extra: Partial<StartInput> = {}) =>
  runner.start({ key, repo, role: 'worker', prompt: 'go', account: 'a', tier: 'sonnet', effort: 'high', ...extra })

const spaceOf = async (key: string) =>
  (await hc.state()).terminals.find((t) => t.labels['factory.key'] === key)?.labels['herdr.space']
const spaces = async () => [
  ...new Set((await hc.state()).terminals.map((t) => t.labels['herdr.space']).filter((s) => s !== undefined)),
]

/** The app's document with one space for a folder, as the app writes it once it has adopted the space. */
const appHas = (id: string, folder: string) => hc.setDoc('herdr-app', { spaces: [{ id, folder, name: 'x', tabs: [] }] })

describe('one space per repo, keyed by path', () => {
  test('two repos with the same directory name get two spaces, and each goes on finding its own', async () => {
    const one = await start('a', '/work/one/app')
    const two = await start('b', '/work/two/app')
    expect(one.workspace).toMatch(/^sp-app-/)
    expect(two.workspace).toMatch(/^sp-app-/)
    expect(one.workspace).not.toBe(two.workspace)
    expect((await start('c', '/work/one/app')).workspace).toBe(one.workspace)
    expect((await start('d', '/work/two/app')).workspace).toBe(two.workspace)
    expect(await spaces()).toHaveLength(2)
  })

  test('the same name under another root is another space', async () => {
    const a = await start('a', '/home/me/SourceRoot/x')
    const b = await start('b', '/home/me/IuRoot/x')
    expect(a.workspace).not.toBe(b.workspace)
  })

  test('a second spawn in a repo is a new tab in its existing space', async () => {
    const first = await start('a', '/work/app')
    const second = await start('b', '/work/app')
    expect(second.workspace).toBe(first.workspace)
    expect(second.tab).not.toBe(first.tab)
    expect(await spaces()).toHaveLength(1)
  })

  test('finds a space the app has, by its folder', async () => {
    await appHas('sp259fabc', '/work/app')
    const { workspace } = await start('a', '/work/app')
    expect(workspace).toBe('sp259fabc')
    expect(await spaceOf('a')).toBe('sp259fabc')
  })

  test("a space of the app that has the repo's name but another folder is not this repo", async () => {
    await appHas('sp-other', '/work/other/app')
    const { workspace } = await start('a', '/work/app')
    expect(workspace).not.toBe('sp-other')
    expect(workspace).toMatch(/^sp-app-/)
  })

  test('a document that is absent or odd is no space', async () => {
    await hc.setDoc('herdr-app', 'nonsense')
    expect((await start('a', '/work/app')).workspace).toMatch(/^sp-app-/)
  })

  test('a document that was never written is no space; one that cannot be read is an error, not a made-up space', async () => {
    // never written: the core answers value null, version 0
    expect((await start('a', '/work/app')).workspace).toMatch(/^sp-app-/)

    await hc.plan('doc.get:exit1')
    const error = (await start('b', '/work/other').catch((e: unknown) => e)) as RunnerError
    expect(error).toBeInstanceOf(RunnerError)
    expect(error.permanent).toBe(false)
    expect(error.message).toContain('doc.get')
    expect((await hc.state()).terminals.filter((t) => t.labels['factory.key'] === 'b')).toHaveLength(0)

    await hc.plan('doc.get:hang')
    const slow = new HcRunner({
      bin: hc.bin,
      clock: new FakeClock(),
      pretrustBin: hc.pretrustBin,
      accountsFile: hc.accountsFile,
      home: '/home/me',
      processTimeoutMs: 300,
    })
    const hung = (await slow
      .start({
        key: 'c',
        repo: '/work/third',
        role: 'worker',
        prompt: 'go',
        account: 'a',
        tier: 'sonnet',
        effort: 'high',
      })
      .catch((e: unknown) => e)) as RunnerError
    expect(hung).toBeInstanceOf(RunnerError)
    expect(hung.message).toContain('timed out')
    // And the next try, with a core that answers, works.
    expect((await start('b', '/work/other')).workspace).toMatch(/^sp-other-/)
  })

  test('a core that refuses the document with not_found counts as no document', async () => {
    await hc.plan('doc.get:notfound')
    expect((await start('a', '/work/app')).workspace).toMatch(/^sp-app-/)
  })

  test('two starts at once: one that asks for a space of its own does not take the standing id the other is making', async () => {
    const [plain, own] = await Promise.all([start('plain', '/work/app'), start('own', '/work/app', { newSpace: true })])
    expect(own.workspace).not.toBe(plain.workspace as string)
    expect(await spaces()).toHaveLength(2)
  })

  test("a fan worker's worktree names its main checkout as the space and lands in it", async () => {
    const lead = await start('lead', '/work/app')
    const fan = await start('fan-1', '/work/app/.claude/worktrees/w1', { space: '/work/app' })
    expect(fan.workspace).toBe(lead.workspace)
    expect(await spaces()).toHaveLength(1)
    // The agent still runs in the worktree.
    expect((await hc.state()).terminals.find((t) => t.address === fan.session)?.cwd).toBe(
      '/work/app/.claude/worktrees/w1',
    )
  })

  test("a fan worker's space made first is found again by the repo itself", async () => {
    const fan = await start('fan-1', '/work/app/.claude/worktrees/w1', { space: '/work/app' })
    expect((await start('lead', '/work/app')).workspace).toBe(fan.workspace)
  })

  test('without a space, the repo is the space (a worktree alone is its own, named after itself)', async () => {
    expect((await start('a', '/work/app/.claude/worktrees/w1')).workspace).toMatch(/^sp-w1-/)
  })

  test('new_space makes a second space for a path that has one, and a retry goes back into it', async () => {
    const first = await start('a', '/work/app')
    const own = await start('b', '/work/app', { newSpace: true })
    expect(own.workspace).not.toBe(first.workspace)
    expect(await spaces()).toHaveLength(2)

    // The same key again finds its terminal: no third space, no second terminal.
    const again = await start('b', '/work/app', { newSpace: true })
    expect(again).toEqual(own)
    expect(await spaces()).toHaveLength(2)
    expect((await hc.state()).terminals.filter((t) => t.labels['factory.key'] === 'b')).toHaveLength(1)
  })

  test('new_space on a path the app has a space for makes another one', async () => {
    await appHas('sp259fabc', '/work/app')
    const own = await start('a', '/work/app', { newSpace: true })
    expect(own.workspace).not.toBe('sp259fabc')
  })

  test('new_space is not needed for the first space of a path, and later plain spawns use the first one', async () => {
    const own = await start('a', '/work/app', { newSpace: true })
    expect(await spaces()).toHaveLength(1)
    expect((await start('b', '/work/app')).workspace).toBe(own.workspace)
  })

  test('a failed try reports its space, and a retry given it goes back there instead of making another', async () => {
    await start('a', '/work/app')
    await hc.plan('terminal.run:silent')
    const first = (await start('b', '/work/app', { newSpace: true }).catch((e: unknown) => e)) as RunnerError
    expect(first).toBeInstanceOf(RunnerError)
    expect(first.workspace).toBeDefined()
    // Its terminal is alive but silent: the second try waits for it again, in the same space.
    const second = (await start('b', '/work/app', { newSpace: true, workspace: first.workspace }).catch(
      (e: unknown) => e,
    )) as RunnerError
    expect(second.workspace).toBe(first.workspace as string)
    await hc.setStatus('t2', 'working')
    const third = await start('b', '/work/app', { newSpace: true, workspace: second.workspace })
    expect(third.workspace).toBe(first.workspace as string)
    expect(await spaces()).toHaveLength(2)
  })

  test("a resume goes back into the spawn's own space, not a sibling space of the same path", async () => {
    const one = await start('a', '/work/app', { newSpace: true })
    const two = await start('b', '/work/app', { newSpace: true })
    expect(two.workspace).not.toBe(one.workspace)
    // The terminal of `a` is gone; a resume of `a` is told its recorded space.
    await hc.finish(one.session)
    await hc.mutate((state) => {
      state.terminals = state.terminals.filter((t) => t.address !== one.session)
    })
    const again = await start('a', '/work/app', { newSpace: true, workspace: one.workspace })
    expect(again.workspace).toBe(one.workspace)
    expect(await spaces()).toHaveLength(2)
  })

  test('a recorded space the runner did not make (a classic herdr id) is ignored unless a terminal is in it', async () => {
    expect((await start('a', '/work/app', { workspace: 'w12' })).workspace).toMatch(/^sp-app-/)
    await hc.mutate((state) => {
      state.terminals.push({
        address: 't90',
        argv: ['sleep'],
        cwd: '/',
        keep: true,
        labels: { 'herdr.space': 'w12' },
        name: null,
        notify: true,
        parent: null,
        state: 'live',
        status: null,
        reported: false,
        turn: 0,
      })
    })
    expect((await start('b', '/work/app', { workspace: 'w12' })).workspace).toBe('w12')
  })

  test('the terminal gets the spawn role in FACTORY_ROLE, with the session and the account', async () => {
    await start('a', '/work/app', { role: 'wave' })
    const env = (await hc.state()).runs[0]?.params.env as Record<string, string>
    expect(env).toMatchObject({ FACTORY_ROLE: 'wave', FACTORY_SESSION: 'a', CLAUDE_ACCOUNT_PICKED: 'a' })
  })

  test('the result names the terminal, the tab and the space', async () => {
    const result = await start('a', '/work/app')
    const [terminal] = (await hc.state()).terminals
    expect(result).toEqual({
      session: terminal?.address as string,
      tab: terminal?.labels['herdr.tab'] as string,
      workspace: terminal?.labels['herdr.space'] as string,
    })
  })
})

// The app adopts a terminal into the space its label names; with no entry it names the space after the terminal's cwd (a
// worktree's). So the runner seeds the entry before it runs the terminal.
describe('seeding a new space in the app document', () => {
  type Entry = { id: string; name: string; folder: string; tabs: unknown[]; [key: string]: unknown }
  const docSpaces = async (): Promise<Entry[]> =>
    ((await hc.state()).docs['herdr-app']?.value as { spaces: Entry[] } | undefined)?.spaces ?? []

  test('a spawn into a repo with no space seeds one entry: the repo name, the folder, no tabs, the id the label carries', async () => {
    const { workspace } = await start('a', '/work/app')
    expect(await docSpaces()).toEqual([{ id: workspace as string, name: 'app', folder: '/work/app', tabs: [] }])
  })

  test('the entry is there before the terminal is run', async () => {
    await start('a', '/work/app')
    const calls = await hc.calls()
    const seeded = calls.findIndex((c) => c.startsWith('doc.set'))
    const ran = calls.findIndex((c) => c.startsWith('terminal.run'))
    expect(seeded).toBeGreaterThanOrEqual(0)
    expect(seeded).toBeLessThan(ran)
  })

  test('a worktree spawn into a repo with no space seeds the main checkout, never the worktree', async () => {
    const { workspace } = await start('fan-1', '/work/app/.claude/worktrees/w1', { space: '/work/app' })
    expect(await docSpaces()).toEqual([{ id: workspace as string, name: 'app', folder: '/work/app', tabs: [] }])
  })

  test('an existing entry is found by its folder and left alone', async () => {
    await hc.setDoc('herdr-app', {
      keep: 1,
      spaces: [{ id: 'sp259fabc', folder: '/work/app', name: 'mine', tabs: [], x: 1 }],
    })
    await start('a', '/work/app')
    await start('b', '/work/app/.claude/worktrees/w1', { space: '/work/app' })
    expect(await hc.callsOf('doc.set')).toHaveLength(0)
    expect((await hc.state()).docs['herdr-app']?.version).toBe(1)
  })

  test('other entries and unknown keys of the document are kept', async () => {
    const other = {
      id: 'sp1',
      folder: '/work/other',
      name: 'other',
      tabs: [{ id: 'tb1', name: '', root: { type: 'row' } }],
      x: 1,
    }
    await hc.setDoc('herdr-app', { keep: 1, spaces: [other] })
    const { workspace } = await start('a', '/work/app')
    expect((await hc.state()).docs['herdr-app']?.value).toEqual({
      keep: 1,
      spaces: [other, { id: workspace as string, name: 'app', folder: '/work/app', tabs: [] }],
    })
  })

  test('two spawns into the same new repo seed it once', async () => {
    const one = await start('a', '/work/app')
    const two = await start('b', '/work/app')
    const three = await start('c', '/work/app/.claude/worktrees/w1', { space: '/work/app' })
    expect(two.workspace).toBe(one.workspace)
    expect(three.workspace).toBe(one.workspace)
    expect(await docSpaces()).toHaveLength(1)
    expect(await hc.callsOf('doc.set')).toHaveLength(1)
  })

  test('two starts at once seed it once', async () => {
    await Promise.all([start('a', '/work/app'), start('b', '/work/app')])
    expect(await docSpaces()).toHaveLength(1)
  })

  test('new_space on a path that has a space seeds a second entry with a name that tells it apart', async () => {
    const first = await start('a', '/work/app')
    const own = await start('b', '/work/app', { newSpace: true })
    const third = await start('c', '/work/app', { newSpace: true })
    expect((await docSpaces()).map((s) => [s.id, s.name, s.folder])).toEqual([
      [first.workspace as string, 'app', '/work/app'],
      [own.workspace as string, 'app 2', '/work/app'],
      [third.workspace as string, 'app 3', '/work/app'],
    ])
    // A retry of the same key finds its entry: nothing more is written.
    await start('b', '/work/app', { newSpace: true })
    expect(await docSpaces()).toHaveLength(3)
  })

  test("new_space on a path the app has a space for seeds a second entry beside the app's", async () => {
    await appHas('sp259fabc', '/work/app')
    const own = await start('a', '/work/app', { newSpace: true })
    expect((await docSpaces()).map((s) => [s.id, s.name])).toEqual([
      ['sp259fabc', 'x'],
      [own.workspace as string, 'app 2'],
    ])
  })

  test('a second space never takes a name another entry has', async () => {
    await hc.setDoc('herdr-app', {
      spaces: [
        { id: 'sp1', folder: '/work/app', name: 'app', tabs: [] },
        { id: 'sp3', folder: '/work/app', name: 'app 3', tabs: [] },
      ],
    })
    const own = await start('a', '/work/app', { newSpace: true })
    expect((await docSpaces()).find((s) => s.id === own.workspace)?.name).toBe('app 4')
  })

  test('a conflict reads the document again and writes against the new version, keeping what was added meanwhile', async () => {
    await hc.setDoc('herdr-app', { spaces: [] })
    await hc.plan('doc.set:conflict')
    const { workspace } = await start('a', '/work/app')
    expect(await hc.callsOf('doc.set')).toHaveLength(2)
    expect((await docSpaces()).map((s) => s.id)).toEqual([workspace as string])
  })

  test('three conflicts give up, and the start goes on in the hashed id', async () => {
    await hc.plan('doc.set:conflict', 'doc.set:conflict', 'doc.set:conflict', 'doc.set:conflict')
    const { workspace } = await start('a', '/work/app')
    expect(workspace).toMatch(/^sp-app-/)
    expect(await hc.callsOf('doc.set')).toHaveLength(3)
    expect(await docSpaces()).toHaveLength(0)
    // The next spawn seeds it, under the same id.
    await start('b', '/work/app')
    expect((await docSpaces()).map((s) => s.id)).toEqual([workspace as string])
  })

  test('a doc.set that fails does not fail the start', async () => {
    await hc.plan('doc.set:exit1')
    const result = await start('a', '/work/app')
    expect(result.workspace).toMatch(/^sp-app-/)
    expect((await hc.state()).terminals).toHaveLength(1)
  })

  test('a doc.get that fails while seeding does not fail the start', async () => {
    // the first doc.get finds the space, the second is the seed's
    await hc.plan('doc.get:ok', 'doc.get:exit1')
    const result = await start('a', '/work/app')
    expect(result.workspace).toMatch(/^sp-app-/)
    expect(await docSpaces()).toHaveLength(0)
  })

  test("a document that is not the app's is never overwritten", async () => {
    await hc.setDoc('herdr-app', 'nonsense')
    await start('a', '/work/app')
    expect(await hc.callsOf('doc.set')).toHaveLength(0)
    await hc.setDoc('herdr-app', { spaces: 'none' })
    await start('b', '/work/app')
    expect(await hc.callsOf('doc.set')).toHaveLength(0)
    await hc.setDoc('herdr-app', { spaces: [{ id: 'sp1', folder: '/work/app', tabs: [] }, 'junk'] })
    await start('c', '/work/app')
    expect(await hc.callsOf('doc.set')).toHaveLength(0)
  })

  test('a core that refuses the document with not_found gets it created', async () => {
    await hc.plan('doc.get:notfound', 'doc.get:notfound')
    const { workspace } = await start('a', '/work/app')
    expect((await docSpaces()).map((s) => s.id)).toEqual([workspace as string])
  })

  test('a hidden worker, and a foreign space with a terminal in it, seed nothing', async () => {
    await start('lead', '/work/app')
    const before = (await hc.callsOf('doc.set')).length
    await start('w', '/work/app', { role: 'worker', parentTerminal: 't1' })
    expect((await hc.callsOf('doc.set')).length).toBe(before)

    await hc.mutate((state) => {
      state.terminals.push({
        address: 't90',
        argv: ['sleep'],
        cwd: '/',
        keep: true,
        labels: { 'herdr.space': 'w12' },
        name: null,
        notify: true,
        parent: null,
        state: 'live',
        status: null,
        reported: false,
        turn: 0,
      })
    })
    await start('b', '/work/other', { workspace: 'w12' })
    expect((await hc.callsOf('doc.set')).length).toBe(before)
  })

  test('a retry given the space the runner made seeds it again if the first try could not', async () => {
    await hc.plan('doc.set:exit1')
    const first = await start('a', '/work/app', { newSpace: true })
    expect(await docSpaces()).toHaveLength(0)
    await start('b', '/work/app', { newSpace: true, workspace: first.workspace })
    expect((await docSpaces()).map((s) => s.id)).toContain(first.workspace as string)
  })
})
