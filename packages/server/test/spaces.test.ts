import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { HerdrRunner, type StartInput } from '../src/runner.ts'
import { FakeClock } from './support/clock.ts'
import { createFakeHerdr, type FakeHerdr } from './support/herdr.ts'

// FL6: a herdr space is keyed by path. The names below are paths that do not exist; the runner takes them as they are.
let herdr: FakeHerdr
let runner: HerdrRunner

beforeAll(async () => {
  herdr = await createFakeHerdr()
})
afterAll(() => herdr.cleanup())
beforeEach(async () => {
  await herdr.reset()
  runner = new HerdrRunner({
    bin: herdr.bin,
    clock: new FakeClock(),
    pretrustBin: herdr.pretrustBin,
    accountsFile: herdr.accountsFile,
    home: '/home/me',
    deliverWaitMs: 3_000,
  })
})

const start = (key: string, repo: string, extra: Partial<StartInput> = {}) =>
  runner.start({ key, repo, role: 'worker', prompt: 'go', account: 'a', tier: 'sonnet', effort: 'high', ...extra })

/** A space as `rd` makes one: labelled with the directory's name, its first pane in the directory. */
async function rdSpace(path: string, label: string): Promise<void> {
  const proc = Bun.spawn([herdr.bin, 'workspace', 'create', '--cwd', path, '--label', label, '--no-focus'])
  await proc.exited
}

const labels = async () => (await herdr.state()).workspaces.map((w) => w.label)

describe('one herdr space per repo, keyed by path', () => {
  test('two repos with the same directory name get two spaces', async () => {
    const one = await start('a', '/work/one/app')
    const two = await start('b', '/work/two/app')
    expect(await labels()).toEqual(['app', 'app'])
    expect(one.workspace).not.toBe(two.workspace)
    // And each repo goes on finding its own.
    expect((await start('c', '/work/one/app')).workspace).toBe(one.workspace)
    expect((await start('d', '/work/two/app')).workspace).toBe(two.workspace)
    expect((await herdr.state()).workspaces).toHaveLength(2)
  })

  test('a second spawn in a repo is a new tab in its existing space', async () => {
    const first = await start('a', '/work/app')
    const second = await start('b', '/work/app')
    expect(second.workspace).toBe(first.workspace)
    expect(second.tab).not.toBe(first.tab)
    const state = await herdr.state()
    expect(state.workspaces).toHaveLength(1)
    expect(state.tabs.map((t) => t.label)).toContain('b')
  })

  test('finds a space that rd made, by its label and the directory of its pane', async () => {
    await rdSpace('/work/app', 'app')
    const { workspace } = await start('a', '/work/app')
    expect(workspace).toBe((await herdr.state()).workspaces[0]?.workspace_id as string)
    expect((await herdr.state()).workspaces).toHaveLength(1)
  })

  test('a space with the same name for another path is not this repo', async () => {
    await rdSpace('/work/other/app', 'app')
    const { workspace } = await start('a', '/work/app')
    const state = await herdr.state()
    expect(state.workspaces).toHaveLength(2)
    expect(workspace).toBe(state.workspaces[1]?.workspace_id as string)
  })

  test("a fan worker's worktree names its main checkout as the space and lands in it", async () => {
    const lead = await start('lead', '/work/app')
    const fan = await start('fan-1', '/work/app/.claude/worktrees/w1', { space: '/work/app' })
    expect(fan.workspace).toBe(lead.workspace)
    const state = await herdr.state()
    expect(state.workspaces).toHaveLength(1)
    // The agent still runs in the worktree.
    expect(state.panes.find((p) => p.pane_id === fan.session)?.cwd).toBe('/work/app/.claude/worktrees/w1')
  })

  test("a fan worker's space made first is found again by the repo itself", async () => {
    const fan = await start('fan-1', '/work/app/.claude/worktrees/w1', { space: '/work/app' })
    expect(await labels()).toEqual(['app'])
    expect((await start('lead', '/work/app')).workspace).toBe(fan.workspace)
  })

  test('without a space, the repo is the space (a worktree alone is its own, named after itself)', async () => {
    await start('a', '/work/app/.claude/worktrees/w1')
    expect(await labels()).toEqual(['w1'])
  })

  test('new_space makes a second space for a path that has one, and a retry goes back into it', async () => {
    const first = await start('a', '/work/app')
    const own = await start('b', '/work/app', { newSpace: true })
    expect(own.workspace).not.toBe(first.workspace)
    expect((await herdr.state()).workspaces).toHaveLength(2)

    // The same key again finds its tab: no third space, no second tab.
    const again = await start('b', '/work/app', { newSpace: true })
    expect(again).toEqual(own)
    expect((await herdr.state()).workspaces).toHaveLength(2)
    expect((await herdr.state()).tabs.filter((t) => t.label === 'b')).toHaveLength(1)
  })

  test('new_space is not needed for the first space of a path, and later plain spawns use the first one', async () => {
    const own = await start('a', '/work/app', { newSpace: true })
    expect((await herdr.state()).workspaces).toHaveLength(1)
    expect((await start('b', '/work/app')).workspace).toBe(own.workspace)
  })

  test('the pane gets the spawn role in FACTORY_ROLE, with the session and the account', async () => {
    await start('a', '/work/app', { role: 'wave' })
    const env = (await herdr.state()).panes[0]?.env ?? []
    expect(env).toContain('FACTORY_ROLE=wave')
    expect(env).toContain('FACTORY_SESSION=a')
    expect(env).toContain('CLAUDE_ACCOUNT_PICKED=a')
  })

  test('the result names the pane, the tab and the space', async () => {
    const result = await start('a', '/work/app')
    const state = await herdr.state()
    expect(result).toEqual({
      session: state.panes[0]?.pane_id as string,
      tab: state.tabs[0]?.tab_id as string,
      workspace: state.workspaces[0]?.workspace_id as string,
    })
  })
})
