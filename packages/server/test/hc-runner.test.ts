import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HcRunner, tabId, terminalName } from '../src/hc-runner.ts'
import { agentName, RunnerError, stageFork, type StartInput, UncertainTyping } from '../src/runner.ts'
import { FakeClock } from './support/clock.ts'
import { createFakeHc, type FakeHc } from './support/hc.ts'

let hc: FakeHc
let clock: FakeClock
let runner: HcRunner
const input: StartInput = {
  key: 'spawn-1',
  repo: '/work/repo',
  role: 'worker',
  prompt: 'do it',
  account: 'a',
  tier: 'sonnet',
  effort: 'high',
}

beforeAll(async () => {
  hc = await createFakeHc()
})
afterAll(() => hc.cleanup())

const makeRunner = (extra: Partial<ConstructorParameters<typeof HcRunner>[0]> = {}) =>
  new HcRunner({
    bin: hc.bin,
    clock,
    pretrustBin: hc.pretrustBin,
    accountsFile: hc.accountsFile,
    home: '/home/me',
    deliverWaitMs: 3_000,
    ...extra,
  })

beforeEach(async () => {
  clock = new FakeClock()
  runner = makeRunner()
  await hc.reset()
})

const failure = async (r: HcRunner = runner, i = input): Promise<RunnerError> => {
  const error = await r.start(i).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(RunnerError)
  return error as RunnerError
}
const count = async (method: string) => (await hc.callsOf(method)).length
const run = async (n = 0): Promise<Record<string, unknown>> => {
  const asked = (await hc.state()).runs[n]
  if (!asked) throw new Error(`no terminal.run number ${n}`)
  return asked.params
}

describe('hc adapter: a close', () => {
  test('ends the agent and takes its terminals away; a second close, or a spawn with none, finds nothing to do', async () => {
    await runner.start(input)
    await runner.close(input.key)
    expect((await hc.state()).terminals).toEqual([])
    await runner.close(input.key)
    await runner.close('never-started')
    expect(await count('terminal.kill')).toBe(1)
  })

  test('a terminal already finished is removed without a kill', async () => {
    const { session } = await runner.start(input)
    await hc.finish?.(session)
    await runner.close(input.key)
    expect((await hc.state()).terminals).toEqual([])
  })
})

describe('hc adapter: a fork of an archived session', () => {
  test('puts the transcript back under the account’s project directory and resumes it as a fork', async () => {
    const home = mkdtempSync('/tmp/factory-fork-')
    const archive = join(home, 'archived.jsonl')
    writeFileSync(archive, 'the session')
    const forking = makeRunner({ home })
    await forking.start({ ...input, repo: home, fork: { session: 'abc-1', archive } })
    const { argv } = (await run()) as { argv: string[] }
    expect(argv.slice(-4)).toEqual(['--resume', 'abc-1', '--fork-session', 'do it'])
    const dir = realpathSync(home).replace(/[^A-Za-z0-9]/g, '-')
    expect(readFileSync(join(home, '.claude', 'projects', dir, 'abc-1.jsonl'), 'utf8')).toBe('the session')
    rmSync(home, { recursive: true, force: true })
  })

  test('a session a fork is writing is not replaced by a second fork', async () => {
    const home = mkdtempSync('/tmp/factory-fork-')
    const archive = join(home, 'archived.jsonl')
    writeFileSync(archive, 'the session')
    await stageFork({ key: 'a', repo: home, fork: { session: 's', archive } }, {}, home)
    const dir = join(home, '.claude', 'projects', realpathSync(home).replace(/[^A-Za-z0-9]/g, '-'))
    writeFileSync(join(dir, 's.jsonl'), 'it went on')
    await stageFork({ key: 'b', repo: home, fork: { session: 's', archive } }, {}, home)
    expect(readFileSync(join(dir, 's.jsonl'), 'utf8')).toBe('it went on')
    rmSync(home, { recursive: true, force: true })
  })

  test('an archive that is gone is a failed try, not a session without its past', async () => {
    const home = mkdtempSync('/tmp/factory-fork-')
    const forking = makeRunner({ home })
    const error = await failure(forking, { ...input, repo: home, fork: { session: 'abc', archive: '/nowhere.jsonl' } })
    expect(error.message).toContain('cannot be put back')
    expect(await count('terminal.run')).toBe(0)
    rmSync(home, { recursive: true, force: true })
  })
})

describe('hc adapter: a start', () => {
  test('runs Claude Code in a terminal of the spawn, with the prompt as its last argument', async () => {
    const { session } = await runner.start(input)
    const state = await hc.state()
    expect(state.terminals).toHaveLength(1)
    expect(session).toBe(state.terminals[0]?.address as string)
    expect(state.terminals[0]).toMatchObject({ cwd: '/work/repo', keep: true, name: 'spawn-1', state: 'live' })
    expect(state.terminals[0]?.argv).toEqual([
      'claude',
      '--dangerously-skip-permissions',
      '--model',
      'sonnet',
      '--effort',
      'high',
      'do it',
    ])
    expect(await hc.pretrustCalls()).toEqual(['/work/repo'])
    // Nothing is typed: the prompt went in with the program.
    expect(state.sent).toEqual([])
  })

  test('the program is an option, so a stub can stand in for claude', async () => {
    await makeRunner({ claudeBin: '/stub/claude' }).start(input)
    expect((await run()).argv).toEqual(expect.arrayContaining(['/stub/claude']))
    expect(((await run()).argv as string[])[0]).toBe('/stub/claude')
  })

  test('a repo path never seen before is trusted before the terminal is run, and a failing trust runs nothing', async () => {
    await runner.start({ ...input, key: 'first', repo: '/work/brand-new-repo' })
    await runner.start({ ...input, key: 'second', repo: '/work/another-new-repo' })
    expect(await hc.pretrustOrder()).toEqual(['0 /work/brand-new-repo', '1 /work/another-new-repo'])

    await hc.reset()
    await hc.setPretrustExit(1)
    const error = await failure(runner, { ...input, key: 'untrusted', repo: '/work/untrusted-repo' })
    expect(error.message).toContain('/work/untrusted-repo')
    expect(await count('terminal.run')).toBe(0)
    expect((await hc.state()).terminals).toHaveLength(0)
  })

  test('a session resumed by id is trusted first, too, and runs `claude --resume <id> <prompt>`', async () => {
    await runner.start({ ...input, resume: 'claude-session-1', prompt: 'carry on' })
    expect(await hc.pretrustOrder()).toEqual(['0 /work/repo'])
    expect(((await run()).argv as string[]).slice(-3)).toEqual(['--resume', 'claude-session-1', 'carry on'])
  })

  test("the account's config directory is in the terminal's env, absent for the default account, never empty", async () => {
    await runner.start({ ...input, key: 'on-b', account: 'b' })
    await runner.start({ ...input, key: 'on-a', account: 'a' })
    expect((await run(0)).env).toEqual({
      CLAUDE_CONFIG_DIR: '/home/me/.claude-b',
      CLAUDE_ACCOUNT_PICKED: 'b',
      USAGE_LANE: 'wave',
      FACTORY_SESSION: 'on-b',
      FACTORY_ROLE: 'worker',
    })
    expect((await run(1)).env).toEqual({
      CLAUDE_ACCOUNT_PICKED: 'a',
      USAGE_LANE: 'wave',
      FACTORY_SESSION: 'on-a',
      FACTORY_ROLE: 'worker',
    })
    for (const { params } of (await hc.state()).runs) {
      for (const value of Object.values(params.env as Record<string, string>)) expect(value).not.toBe('')
    }
  })

  test("the role's tier and effort are what the agent starts with", async () => {
    await runner.start({ ...input, tier: 'opus', effort: 'max' })
    expect(((await run()).argv as string[]).slice(1, 6)).toEqual([
      '--dangerously-skip-permissions',
      '--model',
      'opus',
      '--effort',
      'max',
    ])
  })

  test('the prompt arrives byte for byte, newlines and quotes included', async () => {
    const prompt = `line one\n  "quoted" 'single' $(not run) \`nor this\`\n- a list item\n`
    await runner.start({ ...input, prompt })
    expect(((await run()).argv as string[]).at(-1)).toBe(prompt)
  })

  test('a prompt cannot start with "-": it would be read as an option, and no retry can fix that', async () => {
    expect(await failure(runner, { ...input, prompt: '--help' })).toMatchObject({ permanent: true })
    expect(await hc.calls()).toEqual([])
  })

  test('every run has a cwd, the repo, even when the space is another path', async () => {
    await runner.start(input)
    await runner.start({ ...input, key: 'fan', repo: '/work/repo/.claude/worktrees/w1', space: '/work/repo' })
    for (const { params } of (await hc.state()).runs) expect(typeof params.cwd).toBe('string')
    expect((await run(1)).cwd).toBe('/work/repo/.claude/worktrees/w1')
  })

  test('a key that looks like an address still gets a name hc accepts', async () => {
    expect(terminalName('t7')).not.toMatch(/^t\d/)
    await runner.start({ ...input, key: 't7' })
    expect((await hc.state()).terminals).toHaveLength(1)
  })
})

describe('hc adapter: where the terminal goes', () => {
  test('a tab carries its space and tab as labels, has no parent and is kept', async () => {
    const result = await runner.start(input)
    const params = await run()
    expect(params).toMatchObject({ no_parent: true, keep: true, name: 'spawn-1' })
    expect(params.labels).toEqual({
      'factory.key': 'spawn-1',
      'herdr.space': result.workspace,
      'herdr.tab': tabId('spawn-1'),
      'factory.tab_name': 'spawn-1',
    })
    expect(result.tab).toBe(tabId('spawn-1'))
    expect(result.workspace).toMatch(/^sp-repo-[0-9a-f]{12}$/)
    expect(params).not.toHaveProperty('parent')
  })

  test.each(['worker', 'mechanical', 'deep'])(
    'a %s with a known parent terminal is its hidden child: parent, no labels but the key, no notes',
    async (role) => {
      await runner.start({ ...input, key: 'lead', role: 'lead' })
      const result = await runner.start({ ...input, key: 'kid', role, parentTerminal: 't1' })
      const params = await run(1)
      expect(params).toMatchObject({ parent: 't1', outlive_parent: true, no_notify: true, keep: true })
      expect(params.labels).toEqual({ 'factory.key': 'kid' })
      expect(params).not.toHaveProperty('no_parent')
      expect(result.session).toBe('t2')
      expect((await hc.state()).terminals[1]).toMatchObject({ parent: 't1', notify: false })
    },
  )

  test('a worker whose parent terminal is unknown is a tab', async () => {
    await runner.start(input)
    expect(await run()).toMatchObject({ no_parent: true })
  })

  test.each(['wave', 'lead', 'mother'])('a %s is a tab even when it has a parent terminal', async (role) => {
    await runner.start({ ...input, key: 'lead0', role: 'lead' })
    await runner.start({ ...input, key: 'x', role, parentTerminal: 't1' })
    expect(await run(1)).toMatchObject({ no_parent: true })
  })

  test('a spawn that asks for a space of its own is a tab, even a worker with a known parent', async () => {
    await runner.start({ ...input, key: 'lead', role: 'lead' })
    await runner.start({ ...input, key: 'apart', parentTerminal: 't1', newSpace: true })
    const params = await run(1)
    expect(params).toMatchObject({ no_parent: true })
    expect(params).not.toHaveProperty('parent')
  })

  const ROLES = ['worker', 'mechanical', 'deep', 'wave', 'lead', 'mother']
  const WORKER_ROLES = new Set(['worker', 'mechanical', 'deep'])

  describe.each(ROLES)('role %s', (role) => {
    test.each([undefined, 'tab', 'child'] as const)('placement %p with a known parent terminal', async (placement) => {
      await runner.start({ ...input, key: 'boss', role: 'mother' })
      const result = await runner.start({ ...input, key: 'x', role, placement, parentTerminal: 't1' })
      const params = await run(1)
      const child = placement === 'child' || (placement === undefined && WORKER_ROLES.has(role))
      if (!child) {
        expect(params).toMatchObject({ no_parent: true })
        expect(params).not.toHaveProperty('parent')
        expect(result.tab).toBe(tabId('x'))
        return
      }
      // Whatever the role: outlives its parent, never types into it, wears no tab label.
      expect(params).toMatchObject({ parent: 't1', outlive_parent: true, no_notify: true, keep: true })
      expect(params).not.toHaveProperty('no_parent')
      expect(params.labels).toEqual({ 'factory.key': 'x' })
      expect(result.tab).toBeNull()
      expect((await hc.state()).terminals[1]).toMatchObject({ parent: 't1', notify: false })
    })

    test('placement child with no parent terminal is a tab', async () => {
      const result = await runner.start({ ...input, key: 'x', role, placement: 'child' })
      expect(await run()).toMatchObject({ no_parent: true })
      expect(result.tab).toBe(tabId('x'))
    })

    test('placement child with a parent terminal that is gone is a tab', async () => {
      const result = await runner.start({ ...input, key: 'x', role, placement: 'child', parentTerminal: 't99' })
      expect(await run()).toMatchObject({ no_parent: true })
      expect(result.tab).toBe(tabId('x'))
    })
  })

  test('placement child with a space of its own is a tab: a hidden child has no space', async () => {
    await runner.start({ ...input, key: 'boss', role: 'mother' })
    await runner.start({ ...input, key: 'x', role: 'lead', placement: 'child', parentTerminal: 't1', newSpace: true })
    expect(await run(1)).toMatchObject({ no_parent: true })
  })

  test("a hidden worker has no tab of its own: its tab is null and its space is its parent's", async () => {
    const lead = await runner.start({ ...input, key: 'lead', role: 'lead' })
    const kid = await runner.start({ ...input, key: 'kid', parentTerminal: lead.session })
    expect(kid).toEqual({ session: 't2', tab: null, workspace: lead.workspace })
    // A parent with no space of its own (a plain terminal) gives none.
    await hc.mutate((state) => {
      const t = state.terminals[0]
      if (t) t.labels = { 'factory.key': 'lead' }
    })
    const other = await runner.start({ ...input, key: 'kid-2', parentTerminal: lead.session })
    expect(other).toMatchObject({ tab: null, workspace: null })
  })

  test('a parent terminal that is gone makes this try a tab instead of an error', async () => {
    const result = await runner.start({ ...input, key: 'orphan', parentTerminal: 't99' })
    expect(result.tab).toBe(tabId('orphan'))
    expect(await count('terminal.run')).toBe(2)
    expect((await run(0)).labels).toMatchObject({ 'herdr.tab': tabId('orphan') })
    expect((await hc.state()).terminals).toHaveLength(1)
  })

  test('a hidden child of a hidden child has the space of the nearest ancestor that has one', async () => {
    const mother = await runner.start({ ...input, key: 'mother', role: 'mother' })
    const lead = await runner.start({
      ...input,
      key: 'lead',
      role: 'lead',
      placement: 'child',
      parentTerminal: mother.session,
    })
    const wave = await runner.start({
      ...input,
      key: 'wave',
      role: 'wave',
      placement: 'child',
      parentTerminal: lead.session,
    })
    expect(lead).toMatchObject({ tab: null, workspace: mother.workspace })
    expect(wave).toMatchObject({ tab: null, workspace: mother.workspace })
  })

  test('a parent that is not a terminal of this core (a classic pane) is ignored', async () => {
    await runner.start({ ...input, parentTerminal: 'w1:p3' })
    expect(await run()).toMatchObject({ no_parent: true })
  })
})

describe('hc adapter: naming the tab', () => {
  const space = (name: string) => ({
    spaces: [
      {
        id: 'sp-x',
        folder: '/work/repo',
        extra: { kept: true },
        tabs: [
          { id: tabId('spawn-1'), name, where: 'repo / 3' },
          { id: 'tb-other', name: 'other' },
        ],
      },
    ],
  })

  test('an entry the app already has gets the spawn key as its name, nothing else of the document changes', async () => {
    await hc.setDoc('herdr-app', space('3'))
    await runner.start(input)
    const doc = (await hc.state()).docs['herdr-app']
    expect(doc?.version).toBe(2)
    expect(doc?.value).toEqual(space('spawn-1'))
  })

  test('no entry yet (the app has not adopted the tab): only the space is seeded, no tab is written', async () => {
    await runner.start(input)
    expect(await count('doc.set')).toBe(1)
    const doc = (await hc.state()).docs['herdr-app']?.value as { spaces: { tabs: unknown[] }[] } | undefined
    expect(doc?.spaces.map((s) => s.tabs)).toEqual([[]])
    expect((await run()).labels).toMatchObject({ 'factory.tab_name': 'spawn-1' })
  })

  test('a conflict reads the document again and writes against the new version', async () => {
    await hc.setDoc('herdr-app', space('3'))
    await hc.plan('doc.set:conflict')
    await runner.start(input)
    expect(await count('doc.set')).toBe(2)
    expect((await hc.state()).docs['herdr-app']?.value).toEqual(space('spawn-1'))
  })

  test('it gives up after three conflicts and the start still succeeds', async () => {
    await hc.setDoc('herdr-app', space('3'))
    await hc.plan('doc.set:conflict', 'doc.set:conflict', 'doc.set:conflict', 'doc.set:conflict')
    await runner.start(input)
    expect(await count('doc.set')).toBe(3)
  })

  test('a document that cannot be written never fails the start', async () => {
    await hc.setDoc('herdr-app', space('3'))
    await hc.plan('doc.set:exit1')
    await runner.start(input)
    expect((await hc.state()).terminals).toHaveLength(1)
  })

  test('a document of another shape is left alone', async () => {
    await hc.setDoc('herdr-app', { spaces: 'none' })
    await runner.start(input)
    expect(await count('doc.set')).toBe(0)
  })

  test('a hidden worker has no tab to name', async () => {
    await runner.start({ ...input, key: 'lead', role: 'lead' })
    await hc.setDoc('herdr-app', space('3'))
    const before = await count('doc.set')
    await runner.start({ ...input, key: 'spawn-1', parentTerminal: 't1' })
    expect(await count('doc.set')).toBe(before)
  })
})

describe('hc adapter: idempotence by looking, not by exit code', () => {
  test('a second start of the same key runs nothing and sends nothing', async () => {
    const first = await runner.start(input)
    const second = await runner.start(input)
    expect(second).toEqual(first)
    const state = await hc.state()
    expect(state.terminals).toHaveLength(1)
    expect(state.sent).toEqual([])
    expect(await count('terminal.run')).toBe(1)
    expect(await hc.pretrustCalls()).toHaveLength(1)
  })

  test('a hidden worker is found again as well', async () => {
    await runner.start({ ...input, key: 'lead', role: 'lead' })
    const first = await runner.start({ ...input, key: 'kid', parentTerminal: 't1' })
    expect(await runner.start({ ...input, key: 'kid', parentTerminal: 't1' })).toEqual(first)
    expect(await count('terminal.run')).toBe(2)
  })

  test('a start whose reply was lost carries on with the terminal that was made', async () => {
    await hc.plan('terminal.run:drop')
    await failure()
    expect((await hc.state()).terminals).toHaveLength(1)
    const result = await runner.start(input)
    const state = await hc.state()
    expect(state.terminals).toHaveLength(1)
    expect(result.session).toBe(state.terminals[0]?.address as string)
    expect(await count('terminal.run')).toBe(1)
  })

  test('a live terminal slow to report is started unconfirmed, not failed, and never started again', async () => {
    await hc.plan('terminal.run:silent')
    const result = await runner.start(input)
    expect(result.session).toBe('t1')
    await hc.setStatus('t1', 'working')
    expect(await runner.start(input)).toEqual(result)
    expect(await count('terminal.run')).toBe(1)
  })

  test('a terminal that reported a finished turn counts as started', async () => {
    await runner.start(input)
    await hc.setStatus('t1', 'done')
    await runner.start(input)
    expect(await count('terminal.run')).toBe(1)
    expect((await hc.state()).sent).toEqual([])
  })

  test('a blocked agent has started: the start does not type into it', async () => {
    await runner.start(input)
    await hc.setStatus('t1', 'blocked')
    await runner.start(input)
    expect((await hc.state()).sent).toEqual([])
  })

  test('a terminal the core put a shell into after the program was killed is abandoned: removed, and the spawn started afresh', async () => {
    await runner.start(input)
    await hc.kill9('t1')
    const again = await runner.start(input)
    const state = await hc.state()
    expect(again.session).not.toBe('t1')
    expect(state.terminals.map((t) => t.address)).toEqual([again.session])
    expect(state.terminals[0]?.argv[0]).toBe('claude')
    expect(await count('terminal.kill')).toBe(1)
    expect(await count('terminal.rm')).toBe(1)
    expect(await count('terminal.run')).toBe(2)
    expect(await hc.pretrustCalls()).toHaveLength(2)
  })

  test('a finished terminal that did its work is started: the prompt is not run a second time', async () => {
    // The reply of the run was lost; the agent reported, worked and finished before the retry.
    await hc.plan('terminal.run:drop')
    await failure()
    await hc.setStatus('t1', 'working')
    await hc.finish('t1', 0)
    const result = await runner.start(input)
    expect(result).toMatchObject({ session: 't1', tab: tabId('spawn-1') })
    expect(await count('terminal.run')).toBe(1)
    expect(await count('terminal.rm')).toBe(0)
    expect((await hc.state()).terminals.map((t) => t.address)).toEqual(['t1'])
    // Also when it only has a finished turn on record.
    await hc.reset()
    await hc.plan('terminal.run:silent')
    await runner.start(input)
    await hc.mutate((state) => {
      const t = state.terminals[0]
      if (t) Object.assign(t, { state: 'finished', turn: 1, status: null })
    })
    expect(await runner.start(input)).toMatchObject({ session: 't1' })
    expect(await count('terminal.run')).toBe(1)
  })

  test('a finished terminal that never reported is removed and the spawn started again', async () => {
    await hc.plan('terminal.run:silent')
    await runner.start(input)
    await hc.finish('t1', 1)
    const again = await runner.start(input)
    const state = await hc.state()
    expect(state.terminals.map((t) => t.address)).toEqual([again.session])
    expect(again.session).not.toBe('t1')
    expect(await count('terminal.rm')).toBe(1)
    expect(await count('terminal.run')).toBe(2)
    expect(await hc.pretrustCalls()).toHaveLength(2)
  })

  test('the same key on another account after the first one ended runs with that account', async () => {
    await hc.plan('terminal.run:silent')
    await runner.start({ ...input, account: 'a' })
    await hc.finish('t1', 1)
    await runner.start({ ...input, account: 'b' })
    expect((await run(1)).env).toMatchObject({ CLAUDE_ACCOUNT_PICKED: 'b', CLAUDE_CONFIG_DIR: '/home/me/.claude-b' })
    expect((await hc.state()).terminals).toHaveLength(1)
  })

  test('a terminal still alive keeps the account it started on', async () => {
    await hc.plan('terminal.run:silent')
    await runner.start({ ...input, account: 'a' })
    await runner.start({ ...input, account: 'b' }).catch(() => {})
    expect(await count('terminal.run')).toBe(1)
    expect((await run()).env).toMatchObject({ CLAUDE_ACCOUNT_PICKED: 'a' })
  })

  test('another spawn with the same name of a terminal that is not ours is a name clash, retried later', async () => {
    await hc.mutate((state) => {
      state.terminals.push({
        address: 't90',
        argv: ['zsh'],
        cwd: '/',
        keep: false,
        labels: {},
        name: 'spawn-1',
        notify: true,
        parent: null,
        state: 'live',
        status: null,
        reported: false,
        turn: 0,
      })
    })
    const error = await failure()
    expect(error.message).toContain('name_taken')
    expect(error.permanent).toBe(false)
  })
})

describe('hc adapter: failures are transient errors for the tick to retry', () => {
  test('a non-zero exit fails the start before anything is created', async () => {
    await hc.plan('terminal.list:exit1')
    expect(await failure()).toMatchObject({ permanent: false })
    expect((await hc.state()).terminals).toHaveLength(0)
    await runner.start(input)
    expect((await hc.state()).terminals).toHaveLength(1)
  })

  test('stdout that is not a JSON-RPC reply fails the call', async () => {
    await hc.plan('terminal.list:garbage')
    expect((await failure()).message).toContain('without a reply')
  })

  test('an error body from the core is an error, with its kind', async () => {
    await hc.plan('terminal.run:error')
    const error = await failure()
    expect(error.message).toContain('unavailable')
    expect(error.permanent).toBe(false)
    expect((await hc.state()).terminals).toHaveLength(0)
  })

  test('a hung hc is killed at the process timeout', async () => {
    await hc.plan('terminal.list:hang')
    const started = Date.now()
    const error = await failure(makeRunner({ processTimeoutMs: 400 }))
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(error).toMatchObject({ permanent: false })
    expect(error.message).toContain('timed out')
    await runner.start(input)
    expect((await hc.state()).terminals).toHaveLength(1)
  })

  test('a missing hc binary is permanent', async () => {
    expect(await failure(makeRunner({ bin: '/nonexistent/hc' }))).toMatchObject({ permanent: true })
  })

  test('an account that is not in the registry is permanent and calls nothing', async () => {
    expect(await failure(runner, { ...input, account: 'zz' })).toMatchObject({ permanent: true })
    expect(await hc.calls()).toEqual([])
  })

  test('an unreadable registry is transient', async () => {
    expect(await failure(makeRunner({ accountsFile: '/nonexistent/accounts.json' }))).toMatchObject({
      permanent: false,
    })
  })

  test('a failing folder pre-trust stops the start before the terminal is run', async () => {
    await hc.setPretrustExit(1)
    expect(await failure()).toMatchObject({ permanent: false })
    expect(await count('terminal.run')).toBe(0)
    await hc.setPretrustExit(0)
    await runner.start(input)
    expect((await hc.state()).terminals).toHaveLength(1)
  })

  test('a finished terminal stays until the pre-trust has passed', async () => {
    await hc.plan('terminal.run:silent')
    await runner.start(input)
    await hc.finish('t1', 1)
    await hc.setPretrustExit(1)
    await failure()
    expect(await count('terminal.rm')).toBe(0)
  })

  test('the start budget bounds all steps together', async () => {
    await hc.plan('terminal.run:silent')
    const error = await failure(makeRunner({ startBudgetMs: 2_500, deliverWaitMs: 60_000 }))
    expect(error.message).toContain('budget')
    expect(clock.sleeps.length).toBeLessThanOrEqual(3)
  })

  test("hc is not handed the factory's own secrets", async () => {
    process.env.FACTORY_TOKEN = 'secret-token-for-the-test'
    try {
      const probe = `${hc.bin}-env`
      await Bun.write(
        probe,
        `#!/bin/sh\nprintenv FACTORY_TOKEN DATABASE_URL FACTORY_DB_PASSWORD > '${hc.bin}.env'\nexit 1\n`,
      )
      await Bun.$`chmod +x ${probe}`
      await failure(makeRunner({ bin: probe }))
      expect(await Bun.file(`${hc.bin}.env`).text()).toBe('')
    } finally {
      delete process.env.FACTORY_TOKEN
    }
  })

  test('another core is chosen with HC_SESSION, and only when asked', async () => {
    const probe = `${hc.bin}-session`
    await Bun.write(probe, `#!/bin/sh\necho "[$HC_SESSION]" > '${hc.bin}.session'\nexit 1\n`)
    await Bun.$`chmod +x ${probe}`
    await failure(makeRunner({ bin: probe, session: 'scratch' }))
    expect(await Bun.file(`${hc.bin}.session`).text()).toBe('[scratch]\n')
  })
})

describe('hc adapter: type', () => {
  const ask = (text = 'carry on') => runner.type({ pane: 't1', text })

  test('types into an idle agent, guarded so a change of state in between types nothing', async () => {
    await runner.start(input)
    await hc.setStatus('t1', 'idle')
    expect(await ask()).toBe('typed')
    expect((await hc.state()).sent).toEqual([{ terminal: 't1', text: 'carry on', if: 'idle' }])
  })

  test('types into an agent that is done', async () => {
    await runner.start(input)
    await hc.setStatus('t1', 'done')
    expect(await ask()).toBe('typed')
    expect((await hc.state()).sent).toEqual([{ terminal: 't1', text: 'carry on' }])
  })

  test.each(['working', 'blocked', 'error'])('is busy while the agent is %s, and types nothing', async (word) => {
    await runner.start(input)
    await hc.setStatus('t1', word)
    expect(await ask()).toBe('busy')
    expect((await hc.state()).sent).toEqual([])
    expect(await count('terminal.send')).toBe(0)
  })

  test('is busy for a program that has said nothing', async () => {
    await hc.plan('terminal.run:silent')
    await runner.start(input)
    expect(await ask()).toBe('busy')
    expect(await count('terminal.send')).toBe(0)
  })

  test('the core refusing a blocked program (it changed in between) is busy, nothing typed', async () => {
    await runner.start(input)
    await hc.setStatus('t1', 'done')
    // The state read says done; by the send the agent asks a question.
    await hc.mutate((state) => {
      const t = state.terminals[0]
      if (t) t.status = { app: 'claude-code', state: 'blocked' }
    })
    await hc.plan('terminal.get:ok')
    expect(await ask()).toBe('busy')
    expect((await hc.state()).sent).toEqual([])
  })

  test('an error body is a refusal: an error, nothing was typed', async () => {
    await runner.start(input)
    await hc.setStatus('t1', 'idle')
    await hc.plan('terminal.get:ok', 'terminal.send:error')
    const error = await ask().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RunnerError)
    expect(error).not.toBeInstanceOf(UncertainTyping)
    expect((await hc.state()).sent).toEqual([])
  })

  test('a call that died after the text went in is uncertain', async () => {
    await runner.start(input)
    await hc.setStatus('t1', 'idle')
    await hc.plan('terminal.get:ok', 'terminal.send:drop')
    expect(await ask().catch((e: unknown) => e)).toBeInstanceOf(UncertainTyping)
    expect((await hc.state()).sent).toHaveLength(1)
  })

  test('a call that timed out is uncertain', async () => {
    await runner.start(input)
    await hc.setStatus('t1', 'idle')
    await hc.plan('terminal.get:ok', 'terminal.send:hang')
    const slow = makeRunner({ processTimeoutMs: 400 })
    expect(await slow.type({ pane: 't1', text: 'x' }).catch((e: unknown) => e)).toBeInstanceOf(UncertainTyping)
  })

  test('a terminal that is gone or has finished is an error, nothing typed', async () => {
    await runner.start(input)
    await hc.finish('t1')
    expect(await ask().catch((e: unknown) => e)).toBeInstanceOf(RunnerError)
    expect(await runner.type({ pane: 't99', text: 'x' }).catch((e: unknown) => e)).toBeInstanceOf(RunnerError)
    expect((await hc.state()).sent).toEqual([])
  })

  test('a state that cannot be read is an error, never read as idle', async () => {
    await runner.start(input)
    await hc.plan('terminal.get:exit1')
    const error = await ask().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RunnerError)
    expect(error).not.toBeInstanceOf(UncertainTyping)
  })
})

describe('terminal names', () => {
  test('a clean key is kept', () => expect(terminalName('wave-1')).toBe('wave-1'))
  test('the rest is made a valid name that keeps keys apart', () => {
    const a = terminalName('Repo:Wave.1')
    expect(a).toMatch(/^[a-z][a-z0-9-]{0,31}$/)
    expect(a).not.toBe(terminalName('repo:wave.1'))
  })
  test('an address-like key and the escaped form of another key never share a name', async () => {
    expect(terminalName('t7')).not.toBe(terminalName('f-t7'))
    expect(terminalName('t7')).toMatch(/^[a-z0-9][a-z0-9._-]{0,31}$/)
    await runner.start({ ...input, key: 't7' })
    await runner.start({ ...input, key: 'f-t7' })
    expect((await hc.state()).terminals).toHaveLength(2)
  })
  test('nothing that hc would take for an address', () => {
    for (const key of ['t7', 't77x', 'T7', 't1-abc']) expect(terminalName(key)).not.toMatch(/^t\d/)
  })
})

describe('agent names', () => {
  test('a clean key is kept', () => expect(agentName('wave-1')).toBe('wave-1'))
  test('the rest is made a valid name with a hash that keeps keys apart', () => {
    const a = agentName('Repo:Wave.1')
    const b = agentName('repo:wave.1')
    expect(a).toMatch(/^[a-z][a-z0-9-]{0,31}$/)
    expect(a).not.toBe(b)
  })
  test('a long key is clipped to 32 characters', () => {
    const name = agentName('a-very-long-spawn-key-that-keeps-going-and-going')
    expect(name.length).toBeLessThanOrEqual(32)
    expect(name).not.toBe(agentName('a-very-long-spawn-key-that-keeps-going-and-more'))
  })
  test('a key starting with a digit gets a letter first', () => expect(agentName('1abc')).toMatch(/^f-1abc/))
})
