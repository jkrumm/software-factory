import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { agentName, HerdrRunner, RunnerError } from '../src/runner.ts'
import { FakeClock } from './support/clock.ts'
import { createFakeHerdr, type FakeHerdr } from './support/herdr.ts'

let herdr: FakeHerdr
let clock: FakeClock
let runner: HerdrRunner
const input = { key: 'spawn-1', repo: '/work/repo', prompt: 'do it', account: 'a' }

beforeAll(async () => {
  herdr = await createFakeHerdr()
})
afterAll(() => herdr.cleanup())

const makeRunner = (extra: Partial<ConstructorParameters<typeof HerdrRunner>[0]> = {}) =>
  new HerdrRunner({
    bin: herdr.bin,
    clock,
    pretrustBin: herdr.pretrustBin,
    accountsFile: herdr.accountsFile,
    home: '/home/me',
    deliverWaitMs: 3_000,
    ...extra,
  })

beforeEach(async () => {
  clock = new FakeClock()
  runner = makeRunner()
  await herdr.reset()
})

const failure = async (r: HerdrRunner = runner, i = input): Promise<RunnerError> => {
  const error = await r.start(i).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(RunnerError)
  return error as RunnerError
}
const count = async (prefix: string) => (await herdr.calls()).filter((c) => c.startsWith(prefix)).length

describe('herdr adapter: a start', () => {
  test('creates the space and tab, starts Claude Code in it and hands it the prompt', async () => {
    const { session } = await runner.start(input)
    const state = await herdr.state()
    expect(state.workspaces.map((w) => w.label)).toEqual(['repo'])
    expect(state.tabs.map((t) => t.label)).toEqual(['spawn-1'])
    expect(session).toBe(state.panes[0]?.pane_id as string)
    expect(state.agents).toHaveLength(1)
    expect(state.agents[0]).toMatchObject({ pane_id: session, agent_status: 'working', interactive_ready: true })
    expect(state.agents[0]?.argv).toEqual(['claude', '--dangerously-skip-permissions', '--model', 'sonnet'])
    expect(state.prompts).toEqual([{ pane: session, text: 'do it' }])
    expect(await herdr.pretrustCalls()).toEqual(['/work/repo'])
  })

  test("the account's config directory reaches the pane through --env, the default account sets none", async () => {
    await runner.start({ ...input, key: 'on-b', account: 'b' })
    await runner.start({ ...input, key: 'on-a', account: 'a' })
    const [b, a] = (await herdr.state()).panes
    expect(b?.env).toEqual(['CLAUDE_CONFIG_DIR=/home/me/.claude-b', 'CLAUDE_ACCOUNT_PICKED=b', 'USAGE_LANE=wave'])
    expect(a?.env).toEqual(['CLAUDE_ACCOUNT_PICKED=a', 'USAGE_LANE=wave'])
  })

  test('the model and effort are passed on when set', async () => {
    await makeRunner({ model: 'opus', effort: 'high' }).start(input)
    expect((await herdr.state()).agents[0]?.argv).toEqual([
      'claude',
      '--dangerously-skip-permissions',
      '--model',
      'opus',
      '--effort',
      'high',
    ])
  })

  test('a second spawn in the same repo adds a tab to the existing space', async () => {
    await runner.start(input)
    await runner.start({ ...input, key: 'spawn-2' })
    const state = await herdr.state()
    expect(state.workspaces).toHaveLength(1)
    expect(state.tabs.map((t) => t.label)).toEqual(['spawn-1', 'spawn-2'])
    expect(await count('workspace create')).toBe(1)
    expect(await count('tab create')).toBe(1)
  })

  test('the prompt arrives byte for byte, newlines and quotes included', async () => {
    const prompt = `line one\n  "quoted" 'single' $(not run) \`nor this\`\n- a list item\n`
    await runner.start({ ...input, prompt })
    expect((await herdr.state()).prompts[0]?.text).toBe(prompt)
  })
})

describe('herdr adapter: idempotence by looking, not by exit code', () => {
  test('a second start of the same key creates nothing and types nothing', async () => {
    const first = await runner.start(input)
    const second = await runner.start(input)
    expect(second).toEqual(first)
    const state = await herdr.state()
    expect(state.tabs).toHaveLength(1)
    expect(state.agents).toHaveLength(1)
    expect(state.prompts).toHaveLength(1)
    expect(await count('agent start')).toBe(1)
    expect(await count('workspace create')).toBe(1)
    expect(await herdr.pretrustCalls()).toHaveLength(1)
  })

  test('a start that died after the tab was made carries on with the same tab', async () => {
    await herdr.plan('agent start:exit1')
    await failure()
    expect((await herdr.state()).tabs).toHaveLength(1)
    await runner.start(input)
    const state = await herdr.state()
    expect(state.tabs).toHaveLength(1)
    expect(state.agents).toHaveLength(1)
    expect(state.prompts).toHaveLength(1)
  })

  test('a start that died after the prompt was typed does not type it again', async () => {
    await runner.start(input)
    // what a reclaimed claim sees: the agent is already working on the prompt
    await runner.start(input)
    await runner.start(input)
    expect((await herdr.state()).prompts).toHaveLength(1)
  })

  test('an agent that finished its turn (done) counts as prompted', async () => {
    await runner.start(input)
    const path = herdr.bin.replace(/herdr$/, 'state.json')
    const state = JSON.parse(await Bun.file(path).text())
    state.agents[0].agent_status = 'done'
    state.agents[0].completion_seq = 7
    await Bun.write(path, JSON.stringify(state))
    await runner.start(input)
    expect((await herdr.state()).prompts).toHaveLength(1)
  })
})

describe('herdr adapter: failures are transient errors for the tick to retry', () => {
  test('a non-zero exit fails the start before anything is created', async () => {
    await herdr.plan('tab list:exit1')
    expect(await failure()).toMatchObject({ permanent: false })
    expect((await herdr.state()).tabs).toHaveLength(0)
    await runner.start(input)
    expect((await herdr.state()).agents).toHaveLength(1)
  })

  test('stdout that is not herdr JSON fails the call', async () => {
    await herdr.plan('tab list:garbage')
    expect((await failure()).message).toContain('unexpected')
  })

  test('a hung herdr is killed at the process timeout', async () => {
    await herdr.plan('tab list:hang')
    const started = Date.now()
    const error = await failure(makeRunner({ processTimeoutMs: 400 }))
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(error).toMatchObject({ permanent: false })
    expect(error.message).toContain('timed out')
    await runner.start(input)
    expect((await herdr.state()).agents).toHaveLength(1)
  })

  test('a missing herdr binary is permanent', async () => {
    expect(await failure(makeRunner({ bin: '/nonexistent/herdr' }))).toMatchObject({ permanent: true })
  })

  test('an account that is not in the registry is permanent and creates nothing', async () => {
    expect(await failure(runner, { ...input, account: 'zz' })).toMatchObject({ permanent: true })
    expect(await herdr.calls()).toEqual([])
  })

  test('an unreadable registry is transient', async () => {
    expect(await failure(makeRunner({ accountsFile: '/nonexistent/accounts.json' }))).toMatchObject({
      permanent: false,
    })
  })

  test('a failing folder pre-trust stops the start before the agent is launched', async () => {
    await herdr.setPretrustExit(1)
    expect(await failure()).toMatchObject({ permanent: false })
    expect(await count('agent start')).toBe(0)
    await herdr.setPretrustExit(0)
    await runner.start(input)
    expect((await herdr.state()).agents).toHaveLength(1)
  })

  test('a pane that is busy is retried after a second', async () => {
    await herdr.plan('agent start:busy', 'agent start:busy')
    await runner.start(input)
    expect(clock.sleeps.slice(0, 2)).toEqual([1000, 1000])
    expect((await herdr.state()).agents).toHaveLength(1)
  })

  test('a pane that stays busy ends the start', async () => {
    await herdr.plan(...Array<string>(12).fill('agent start:busy'))
    expect((await failure()).message).toContain('agent_pane_busy')
  })

  test('an agent that never becomes ready is not started: its tab is closed so the next try begins clean', async () => {
    await herdr.plan('agent start:notready')
    expect((await failure()).message).toContain('agent_not_ready')
    // the half-launched agent is there on the next look: its tab is closed and the try fails
    expect((await failure()).message).toContain('never became ready')
    expect((await herdr.state()).tabs).toHaveLength(0)
    await runner.start(input)
    const state = await herdr.state()
    expect(state.agents.filter((a) => a.interactive_ready)).toHaveLength(1)
    expect(state.prompts).toHaveLength(1)
  })

  test('a tab without a running agent is never reported as started', async () => {
    await herdr.plan('agent start:exit1')
    await failure()
    expect((await herdr.state()).tabs).toHaveLength(1)
    expect((await herdr.state()).agents).toHaveLength(0)
  })

  test('the start budget bounds all steps together', async () => {
    await herdr.plan(...Array<string>(12).fill('agent start:busy'))
    const error = await failure(makeRunner({ startBudgetMs: 3_500 }))
    expect(error.message).toContain('budget')
    expect(clock.sleeps.length).toBeLessThanOrEqual(4)
  })
})

describe('herdr adapter: a retry', () => {
  test('on another account makes a tab without an agent again, so the pane has that account', async () => {
    await herdr.plan('agent start:exit1')
    await failure(runner, { ...input, account: 'a' })
    expect((await herdr.state()).panes[0]?.env).toContain('CLAUDE_ACCOUNT_PICKED=a')

    await runner.start({ ...input, account: 'b' })
    const state = await herdr.state()
    expect(state.tabs.map((t) => t.label)).toEqual(['spawn-1'])
    expect(state.panes).toHaveLength(1)
    expect(state.panes[0]?.env).toContain('CLAUDE_ACCOUNT_PICKED=b')
    expect(state.agents).toHaveLength(1)
  })

  test('never prompts an agent that is blocked, and does not call it started', async () => {
    await runner.start(input)
    const path = herdr.bin.replace(/herdr$/, 'state.json')
    const state = JSON.parse(await Bun.file(path).text())
    state.agents[0].agent_status = 'blocked'
    await Bun.write(path, JSON.stringify(state))
    expect((await failure()).message).toContain('blocked, not ready for a prompt')
    expect((await herdr.state()).prompts).toHaveLength(1)
  })
})

describe('herdr adapter: prompt delivery', () => {
  test('a prompt the agent ignores is sent once more after the window, and only once more', async () => {
    await herdr.plan('agent prompt:drop')
    await runner.start(input)
    const state = await herdr.state()
    expect(state.prompts).toHaveLength(2)
    expect(state.agents[0]?.agent_status).toBe('working')
    expect(clock.sleeps.filter((ms) => ms === 1000).length).toBeGreaterThanOrEqual(2)
  })

  test('two ignored sends end in an error, and a later try sends again', async () => {
    await herdr.plan('agent prompt:drop', 'agent prompt:drop')
    expect((await failure()).message).toContain('no state change after two sends')
    expect((await herdr.state()).prompts).toHaveLength(2)
    await runner.start(input)
    expect((await herdr.state()).prompts).toHaveLength(3)
  })

  test('a rejection in the body (exit 0) is an error, not a delivery', async () => {
    await herdr.plan('agent prompt:error')
    expect((await failure()).message).toContain('agent_blocked')
    expect((await herdr.state()).prompts).toHaveLength(0)
    await runner.start(input)
    expect((await herdr.state()).prompts).toHaveLength(1)
  })

  test('an unreadable state after the send is reported, not answered with another send', async () => {
    // the first read (before the send) works, every read after it fails
    await herdr.plan('agent get:ok', ...Array<string>(3).fill('agent get:unreadable'))
    expect((await failure()).message).toContain('unconfirmed')
    expect((await herdr.state()).prompts).toHaveLength(1)
    await runner.start(input)
    expect((await herdr.state()).prompts).toHaveLength(1)
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
