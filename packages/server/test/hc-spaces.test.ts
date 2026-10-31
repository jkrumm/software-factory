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
