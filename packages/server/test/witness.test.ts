import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HcClient } from '../src/hc.ts'
import { HcEvents } from '../src/hc-events.ts'
import { HcRunner } from '../src/hc-runner.ts'
import { agentName } from '../src/runner.ts'
import { getSession, recordEvent } from '../src/sessions.ts'
import { type AgentSeen, gitProbe, type RunnerChange, type RunnerView, startWitness, witness } from '../src/witness.ts'
import { FakeClock } from './support/clock.ts'
import { createFakeHc, type FakeHc } from './support/hc.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

// A stream test starts a few processes of its own.
setDefaultTimeout(30_000)

let db: TestDb
let hc: FakeHc
let clock: FakeClock

beforeAll(async () => {
  db = await startTestDb()
  hc = await createFakeHc()
})
afterAll(async () => {
  await hc.cleanup()
  await db.stop()
})
beforeEach(async () => {
  await db.reset()
  await hc.reset()
  clock = new FakeClock()
})

const SERVER_1 = `100@${'a'.repeat(32)}`
const SERVER_2 = `200@${'b'.repeat(32)}`

/** The runner as the test says it is. */
class FakeView implements RunnerView {
  list: AgentSeen[] = []
  server: string | undefined = SERVER_1
  down = false
  listeners = new Set<(change: RunnerChange) => void>()
  async agents(): Promise<AgentSeen[]> {
    if (this.down) throw new Error('hc terminal.list: timed out without a reply')
    return this.list
  }
  async serverId() {
    return this.server
  }
  watch(listener: (change: RunnerChange) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  announce(change: RunnerChange) {
    for (const listener of this.listeners) listener(change)
  }
}

const view = new FakeView()
beforeEach(() => {
  view.list = []
  view.server = SERVER_1
  view.down = false
  view.listeners.clear()
})
let probed: string[] = []
let changed: Date | undefined
beforeEach(() => {
  probed = []
  changed = undefined
})
const probe = async (cwd: string) => {
  probed.push(cwd)
  return changed
}
const pass = () => witness({ sql: db.sql, runner: view, clock, probe })
const state = async (id: string) => (await getSession(db.sql, id, clock.now()))?.state
const emit = (session: string, kind: 'session_started' | 'turn_started' | 'session_ended', at: Date, payload = {}) =>
  recordEvent(db.sql, { key: `${session}:${kind}:${at.toISOString()}`, session, kind, at, payload })
const agent = (over: Partial<AgentSeen> = {}): AgentSeen => ({ paneId: 't1', status: 'idle', ...over })
const minutes = (n: number) => new Date(clock.now().getTime() - n * 60_000)

describe('the witness', () => {
  test("records each agent's status against its session, found by factory key, Claude session id, name or pane", async () => {
    await emit('by-id', 'session_started', minutes(10), { claudeSessionId: 'c-1' })
    await emit('rd-agent', 'session_started', minutes(10), { claudeSessionId: 'c-2' })
    await emit('spawn-key', 'session_started', minutes(10), {})
    await db.sql`UPDATE factory.sessions SET pane = 't9' WHERE id = 'spawn-key'`
    view.list = [
      agent({ paneId: 't1', claudeSessionId: 'c-1', status: 'working', name: 'something-else' }),
      agent({ paneId: 't2', name: 'rd-agent', status: 'idle' }),
      agent({ paneId: 't9', status: 'blocked' }),
    ]
    await pass()
    const rows = await db.sql`SELECT id, pane, agent_status, agent_seen_at FROM factory.sessions ORDER BY id`
    expect(rows.map((r: { id: string; pane: string; agent_status: string }) => [r.id, r.pane, r.agent_status])).toEqual(
      [
        ['by-id', 't1', 'working'],
        ['rd-agent', 't2', 'idle'],
        ['spawn-key', 't9', 'blocked'],
      ],
    )
    expect(rows[0]?.agent_seen_at).toEqual(clock.now())
  })

  test('a spawn key is found by the name the runner gave its agent (clipped and lowercased)', async () => {
    await emit('Spawn_Key.1', 'session_started', minutes(5), {})
    view.list = [agent({ name: agentName('Spawn_Key.1'), status: 'working' })]
    await pass()
    expect((await getSession(db.sql, 'Spawn_Key.1', clock.now()))?.agentStatus).toBe('working')
  })

  test('the first reading of the server is not a restart; a change is the event runner_restarted, once', async () => {
    expect((await pass()).restarted).toBe(false)
    expect((await pass()).restarted).toBe(false)
    view.server = SERVER_2
    expect((await pass()).restarted).toBe(true)
    expect((await pass()).restarted).toBe(false)
    const events = await db.sql`SELECT key, session, kind, payload FROM factory.events`
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      session: '_runner',
      kind: 'runner_restarted',
      payload: { from: SERVER_1, to: SERVER_2 },
    })
    // The pseudo-session is not a session of the factory.
    expect(await db.sql`SELECT 1 FROM factory.sessions WHERE id = '_runner'`).toHaveLength(0)
  })

  test('a session whose pane is gone becomes dead, after two passes without it', async () => {
    await emit('s', 'session_started', minutes(30), { claudeSessionId: 'c-1' })
    await emit('s', 'turn_started', minutes(20))
    view.list = [agent({ claudeSessionId: 'c-1', status: 'working' })]
    await pass()
    expect(await state('s')).toBe('working')

    view.list = []
    await pass()
    expect(await state('s')).toBe('working')
    const result = await pass()
    expect(result.gone).toEqual(['s'])
    expect(await state('s')).toBe('dead')
    // Once: later passes add nothing.
    await pass()
    expect(await db.sql`SELECT 1 FROM factory.events WHERE kind = 'pane_gone'`).toHaveLength(1)
  })

  test('a pane that came back between the two passes is not gone', async () => {
    await emit('s', 'session_started', minutes(30), { claudeSessionId: 'c-1' })
    view.list = [agent({ claudeSessionId: 'c-1' })]
    await pass()
    view.list = []
    await pass()
    view.list = [agent({ claudeSessionId: 'c-1' })]
    await pass()
    view.list = []
    await pass()
    expect(await state('s')).toBe('idle')
  })

  test('the pass in which the runner restarted counts no pane as missing: its terminals are still coming back', async () => {
    await emit('s', 'session_started', minutes(30), { claudeSessionId: 'c-1' })
    view.list = [agent({ claudeSessionId: 'c-1' })]
    await pass()
    view.list = []
    view.server = SERVER_2
    await pass()
    await pass()
    expect(await state('s')).toBe('idle')
    await pass()
    expect(await state('s')).toBe('dead')
  })

  test('a session the runner never showed is not declared dead, and an ended one is left alone', async () => {
    await emit('never-seen', 'session_started', minutes(30), {})
    await emit('ended', 'session_started', minutes(30), { claudeSessionId: 'c-9' })
    await db.sql`UPDATE factory.sessions SET pane = 't5' WHERE id = 'ended'`
    await emit('ended', 'session_ended', minutes(5))
    for (let i = 0; i < 4; i++) await pass()
    expect(await state('never-seen')).toBe('idle')
    expect(await db.sql`SELECT 1 FROM factory.events WHERE kind = 'pane_gone'`).toHaveLength(0)
  })

  test('a runner that does not answer records nothing', async () => {
    await emit('s', 'session_started', minutes(30), { claudeSessionId: 'c-1' })
    view.list = [agent({ claudeSessionId: 'c-1', status: 'working' })]
    await pass()
    view.down = true
    view.server = `999@${'c'.repeat(32)}`
    // oxlint-disable-next-line typescript/await-thenable -- bun types `rejects` matchers as void; they return a promise
    await expect(pass()).rejects.toThrow('timed out')
    view.down = false
    view.list = []
    expect(await db.sql`SELECT 1 FROM factory.events WHERE kind = 'runner_restarted'`).toHaveLength(0)
  })

  test('a pane reported gone that comes back is alive again; going again is a second event', async () => {
    await emit('s', 'session_started', minutes(30), { claudeSessionId: 'c-1' })
    view.list = [agent({ claudeSessionId: 'c-1' })]
    await pass()
    view.list = []
    await pass()
    await pass()
    expect(await state('s')).toBe('dead')

    clock.advance(60_000)
    view.list = [agent({ claudeSessionId: 'c-1', status: 'idle' })]
    await pass()
    expect(await state('s')).toBe('idle')

    clock.advance(60_000)
    view.list = []
    await pass()
    await pass()
    expect(await state('s')).toBe('dead')
    expect(await db.sql`SELECT key FROM factory.events WHERE kind = 'pane_gone' ORDER BY id`).toHaveLength(2)
  })

  test('a session a hook revived after pane_gone is watched again: a real disappearance is a second pane_gone', async () => {
    await emit('s', 'session_started', minutes(30), { claudeSessionId: 'c-1' })
    view.list = [agent({ claudeSessionId: 'c-1' })]
    await pass()
    view.list = []
    await pass()
    await pass()
    expect(await state('s')).toBe('dead')

    clock.advance(60_000)
    await emit('s', 'turn_started', new Date(clock.now().getTime()))
    expect(await state('s')).toBe('working')
    // the runner never matches it again, and the pane really is gone.
    clock.advance(60_000)
    await pass()
    await pass()
    expect(await db.sql`SELECT 1 FROM factory.events WHERE kind = 'pane_gone'`).toHaveLength(2)
    expect(await state('s')).toBe('dead')
  })

  test('a runner that cannot be identified counts nobody as missing', async () => {
    await emit('s', 'session_started', minutes(30), { claudeSessionId: 'c-1' })
    view.list = [agent({ claudeSessionId: 'c-1' })]
    await pass()
    view.list = []
    view.server = undefined
    for (let i = 0; i < 4; i++) await pass()
    expect(await state('s')).toBe('idle')
  })

  test('stuck: working, the runner working, and a worktree that has not moved for 45 minutes', async () => {
    await emit('s', 'session_started', minutes(120), { claudeSessionId: 'c-1', cwd: '/work/tree' })
    await emit('s', 'turn_started', minutes(100))
    view.list = [agent({ claudeSessionId: 'c-1', status: 'working' })]

    changed = minutes(10)
    await pass()
    expect(probed).toEqual(['/work/tree'])
    expect(await state('s')).toBe('working')

    changed = minutes(50)
    clock.advance(40 * 60_000)
    await pass()
    expect(await state('s')).toBe('stuck')

    // the runner says the agent is idle: the hooks and the runner disagree, which is not stuck.
    view.list = [agent({ claudeSessionId: 'c-1', status: 'idle' })]
    await pass()
    expect(await state('s')).toBe('working')
  })

  test('the worktree is only probed for an agent that is working', async () => {
    await emit('s', 'session_started', minutes(5), { claudeSessionId: 'c-1', cwd: '/work/tree' })
    view.list = [agent({ claudeSessionId: 'c-1', status: 'idle' })]
    await pass()
    expect(probed).toEqual([])
  })
})

describe('the witness and the legacy server identity', () => {
  test('the first pass after the change of format records no restart, then a change does', async () => {
    // What migration 010 copied from the old witness: `pid@start time`.
    await db.sql`INSERT INTO factory.witness (name, value, at) VALUES ('runner_server', '63271@Sun Oct 11 14:11:39 2026', ${clock.now()})`
    expect((await pass()).restarted).toBe(false)
    expect(await db.sql`SELECT value FROM factory.witness WHERE name = 'runner_server'`).toEqual([{ value: SERVER_1 }])
    view.server = SERVER_2
    expect((await pass()).restarted).toBe(true)
    expect(await db.sql`SELECT 1 FROM factory.events WHERE kind = 'runner_restarted'`).toHaveLength(1)
  })

  test('a session is found by the factory.key label first, then by its terminal', async () => {
    await emit('spawn-a', 'session_started', minutes(10), {})
    await emit('spawn-b', 'session_started', minutes(10), {})
    await db.sql`UPDATE factory.sessions SET pane = 't2' WHERE id = 'spawn-b'`
    view.list = [
      agent({ paneId: 't7', factoryKey: 'spawn-a', status: 'working', name: 'other' }),
      agent({ paneId: 't2', status: 'idle' }),
    ]
    await pass()
    const rows = await db.sql`SELECT id, pane, agent_status, herdr_status FROM factory.sessions ORDER BY id`
    expect(rows).toEqual([
      { id: 'spawn-a', pane: 't7', agent_status: 'working', herdr_status: 'working' },
      { id: 'spawn-b', pane: 't2', agent_status: 'idle', herdr_status: 'idle' },
    ])
  })

  test("an address another session's key is on is not this session's: addresses are reused after a core is wiped", async () => {
    await emit('old', 'session_started', minutes(10), {})
    await db.sql`UPDATE factory.sessions SET pane = 't3' WHERE id = 'old'`
    view.list = [agent({ paneId: 't3', factoryKey: 'newcomer', status: 'working' })]
    await pass()
    expect((await db.sql`SELECT agent_status FROM factory.sessions WHERE id = 'old'`)[0]?.agent_status).toBeNull()
    // A terminal with no key at all (an `rd` one) is still found by its address.
    view.list = [agent({ paneId: 't3', status: 'idle' })]
    await pass()
    expect((await db.sql`SELECT agent_status FROM factory.sessions WHERE id = 'old'`)[0]?.agent_status).toBe('idle')
  })

  test("a terminal with another session's key is never matched to this one: not by name, Claude session id or address", async () => {
    await emit('mine', 'session_started', minutes(10), { claudeSessionId: 'c-mine' })
    await db.sql`UPDATE factory.sessions SET pane = 't4' WHERE id = 'mine'`
    const theirs = { factoryKey: 'theirs', status: 'working' }
    view.list = [
      agent({ ...theirs, paneId: 't9', name: 'mine' }),
      agent({ ...theirs, paneId: 't8', claudeSessionId: 'c-mine' }),
      agent({ ...theirs, paneId: 't4' }),
    ]
    await pass()
    expect((await db.sql`SELECT agent_status FROM factory.sessions WHERE id = 'mine'`)[0]?.agent_status).toBeNull()
    // Without a key of its own the same terminal is found by each of them.
    for (const found of [
      agent({ paneId: 't9', name: 'mine' }),
      agent({ paneId: 't8', claudeSessionId: 'c-mine' }),
      agent({ paneId: 't4' }),
    ]) {
      await db.sql`UPDATE factory.sessions SET agent_status = NULL, pane = 't4' WHERE id = 'mine'`
      view.list = [{ ...found, status: 'idle' }]
      await pass()
      expect((await db.sql`SELECT agent_status FROM factory.sessions WHERE id = 'mine'`)[0]?.agent_status).toBe('idle')
    }
  })

  test('the session carries the new names and, for one release, the old ones with the same values', async () => {
    await emit('s', 'session_started', minutes(10), {})
    view.list = [agent({ factoryKey: 's', status: 'working' })]
    await pass()
    const session = await getSession(db.sql, 's', clock.now())
    expect(session).toMatchObject({ agentStatus: 'working', herdrStatus: 'working' })
    expect(session?.agentSeenAt).toBe(clock.now().toISOString())
    expect(session?.herdrSeenAt).toBe(session?.agentSeenAt as string)
  })

  test('an agent that has said nothing yet has no status', async () => {
    await emit('s', 'session_started', minutes(10), {})
    view.list = [agent({ factoryKey: 's', status: null })]
    await pass()
    expect((await db.sql`SELECT agent_status FROM factory.sessions WHERE id = 's'`)[0]?.agent_status).toBeNull()
  })

  test('a pane that is not a terminal of this core (a classic herdr pane) is never counted missing', async () => {
    await emit('rd', 'session_started', minutes(30), {})
    await db.sql`UPDATE factory.sessions SET pane = 'w3:p1' WHERE id = 'rd'`
    for (let i = 0; i < 4; i++) await pass()
    expect(await db.sql`SELECT 1 FROM factory.events WHERE kind = 'pane_gone'`).toHaveLength(0)
  })
})

describe('the witness between passes', () => {
  const settle = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 100 && !(await check()); i++) await Bun.sleep(20)
    expect(await check()).toBe(true)
  }
  const agentRow = async (id: string) =>
    (await db.sql`SELECT agent_status, herdr_status, agent_seen_at FROM factory.sessions WHERE id = ${id}`)[0]

  test('a status the runner announces is stored at once, in both columns, without a pass', async () => {
    await emit('s', 'session_started', minutes(10), {})
    view.list = [agent({ factoryKey: 's', status: 'idle' })]
    const running = startWitness({ sql: db.sql, runner: view, clock, probe }, 3_600_000, 30)
    try {
      await settle(async () => (await agentRow('s'))?.agent_status === 'idle')
      clock.advance(5_000)
      view.announce({ kind: 'status', agent: agent({ factoryKey: 's', status: 'blocked' }) })
      await settle(async () => (await agentRow('s'))?.agent_status === 'blocked')
      expect(await agentRow('s')).toMatchObject({ herdr_status: 'blocked', agent_seen_at: clock.now() })
    } finally {
      await running.stop()
    }
  })

  test("a status event of a terminal with another session's key does not reach a session on that address", async () => {
    await emit('mine', 'session_started', minutes(10), {})
    await emit('theirs', 'session_started', minutes(10), {})
    await db.sql`UPDATE factory.sessions SET pane = 't4' WHERE id IN ('mine', 'theirs')`
    const running = startWitness({ sql: db.sql, runner: view, clock, probe }, 3_600_000, 30)
    try {
      view.announce({ kind: 'status', agent: agent({ paneId: 't4', factoryKey: 'theirs', status: 'blocked' }) })
      await settle(async () => (await agentRow('theirs'))?.agent_status === 'blocked')
      expect((await agentRow('mine'))?.agent_status).toBeNull()
    } finally {
      await running.stop()
    }
  })

  test('a terminal that is gone asks for a pass; one no session has is ignored', async () => {
    await emit('s', 'session_started', minutes(30), { claudeSessionId: 'c-1' })
    view.list = [agent({ claudeSessionId: 'c-1', status: 'working' })]
    let passes = 0
    const counting: RunnerView = {
      agents: () => {
        passes++
        return view.agents()
      },
      serverId: () => view.serverId(),
      watch: (l) => view.watch(l),
    }
    const running = startWitness({ sql: db.sql, runner: counting, clock, probe }, 3_600_000, 30)
    try {
      await settle(async () => passes === 1)
      view.announce({ kind: 'gone', paneId: 't99' })
      await Bun.sleep(150)
      expect(passes).toBe(1)

      view.list = []
      view.announce({ kind: 'gone', paneId: 't1', factoryKey: 's' })
      view.announce({ kind: 'gone', paneId: 't1', factoryKey: 's' })
      await settle(async () => passes === 2)
      await Bun.sleep(150)
      // A burst is one pass.
      expect(passes).toBe(2)
      expect((await db.sql`SELECT pane_misses FROM factory.sessions WHERE id = 's'`)[0]?.pane_misses).toBe(1)

      view.announce({ kind: 'restart' })
      await settle(async () => passes === 3)
    } finally {
      await running.stop()
    }
  })
})

describe('the hc adapter (HcEvents)', () => {
  const client = () => new HcClient({ bin: hc.bin })
  const runner = () =>
    new HcRunner({
      bin: hc.bin,
      clock,
      pretrustBin: hc.pretrustBin,
      accountsFile: hc.accountsFile,
      home: '/home/me',
      deliverWaitMs: 3_000,
    })
  const spawn = (key = 'spawn-1') =>
    runner().start({
      key,
      repo: '/work/repo',
      role: 'lead',
      prompt: 'go',
      account: 'a',
      tier: 'sonnet',
      effort: 'high',
    })
  const until = async (check: () => boolean | Promise<boolean>, ms = 5_000) => {
    const end = Date.now() + ms
    while (Date.now() < end && !(await check())) await Bun.sleep(15)
    expect(await check()).toBe(true)
  }
  let events: HcEvents | undefined
  const stream = (extra: Partial<ConstructorParameters<typeof HcEvents>[0]> = {}) => {
    events = new HcEvents({ client: client(), backoffMs: 30, maxBackoffMs: 120, ...extra })
    events.start()
    return events
  }
  const changes = (e: HcEvents) => {
    const seen: RunnerChange[] = []
    e.watch((c) => seen.push(c))
    return seen
  }
  beforeEach(async () => {
    await events?.stop()
    events = undefined
  })
  afterAll(async () => {
    await events?.stop()
  })

  test('lists the claude agents through hc, by address, name, factory key, status and directory', async () => {
    const { session } = await spawn()
    const agents = await new HcEvents({ client: client() }).agents()
    expect(agents).toEqual([
      { paneId: session, name: 'spawn-1', factoryKey: 'spawn-1', status: 'working', cwd: '/work/repo' },
    ])
  })

  test('a finished terminal, and one the core put a shell into, are no agent', async () => {
    const one = await spawn('one')
    const two = await spawn('two')
    const three = await spawn('three')
    await hc.finish(one.session)
    await hc.kill9(two.session)
    const agents = await new HcEvents({ client: client() }).agents()
    expect(agents.map((a) => a.paneId)).toEqual([three.session])
  })

  test('an agent that has not said anything yet is still an agent, with no status', async () => {
    await hc.plan('terminal.run:silent')
    const { session } = await spawn().catch(() => ({ session: 't1' }))
    const agents = await new HcEvents({ client: client() }).agents()
    expect(agents).toMatchObject([{ paneId: session, status: null }])
  })

  test('a record that does not parse fails the whole list, naming the issue', async () => {
    await spawn()
    await hc.plan('terminal.list:malformed')
    // oxlint-disable-next-line typescript/await-thenable -- bun types `rejects` matchers as void; they return a promise
    await expect(new HcEvents({ client: client() }).agents()).rejects.toThrow('does not parse: address')
  })

  test('a snapshot with a record that does not parse is no snapshot: logged once, retried with the backoff, then whole', async () => {
    await spawn()
    const logged: string[] = []
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args.join(' ')))
    try {
      await hc.plan('events.subscribe:malformed', 'events.subscribe:malformed')
      const e = stream()
      await until(async () => (await hc.callsOf('events.subscribe')).length >= 3)
      await until(() => e.streaming)
      expect(logged.filter((l) => l.includes('does not parse'))).toHaveLength(1)
      expect(logged[0]).toContain('address')
      expect((await e.agents()).length).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })

  test('when the refresh after a line that could not be read fails, the cache is cold until one works', async () => {
    const { session } = await spawn()
    const e = stream()
    await until(() => e.streaming)
    await until(async () => (await hc.callsOf('server.status')).length >= 1)
    await Bun.sleep(300)
    const spy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await hc.mutate((state) => {
        const t = state.terminals.find((x) => x.address === session)
        if (t) t.status = { app: 'claude-code', state: 'idle' }
      })
      await hc.plan('terminal.list:exit1')
      const lists = (await hc.callsOf('terminal.list')).length
      await hc.emitRaw('{"jsonrpc":"2.0","method":"event","params":{"data":{"labe')
      await until(async () => (await hc.callsOf('terminal.list')).length > lists)
      await until(() => !e.streaming)
      // Cold: the answer comes from the core, not from a map that may have a hole.
      expect((await e.agents())[0]?.status).toBe('idle')

      await hc.emitRaw('{"jsonrpc":"2.0","method":"event","params":{"data":{"labe')
      await until(() => e.streaming)
    } finally {
      spy.mockRestore()
    }
  })

  test('a core that hangs is cut off at the timeout, garbage is an error, and the server id is undefined', async () => {
    await hc.plan('terminal.list:hang')
    // oxlint-disable-next-line typescript/await-thenable -- bun types `rejects` matchers as void; they return a promise
    await expect(new HcEvents({ client: client(), timeoutMs: 300 }).agents()).rejects.toThrow('timed out')
    await hc.plan('terminal.list:garbage')
    // oxlint-disable-next-line typescript/await-thenable -- bun types `rejects` matchers as void; they return a promise
    await expect(new HcEvents({ client: client() }).agents()).rejects.toThrow('without a reply')
    await hc.plan('server.status:exit1')
    expect(await new HcEvents({ client: client() }).serverId()).toBeUndefined()
  })

  test('the server is the core pid and its id', async () => {
    expect(await new HcEvents({ client: client() }).serverId()).toBe(`4242@${'0123456789abcdef'.repeat(2)}`)
  })

  test('a missing hc binary is an error, not a crash of the stream loop', async () => {
    const e = new HcEvents({ client: new HcClient({ bin: '/nonexistent/hc' }), backoffMs: 20, maxBackoffMs: 40 })
    e.start()
    await Bun.sleep(150)
    await e.stop()
    // oxlint-disable-next-line typescript/await-thenable -- bun types `rejects` matchers as void; they return a promise
    await expect(e.agents()).rejects.toThrow()
  })

  test('the stream keeps the cache: a status, a death and a removal arrive as events, without a list', async () => {
    const { session } = await spawn()
    const e = stream()
    const seen = changes(e)
    await until(() => e.streaming)
    // Let the reads that follow the snapshot finish; from here on everything must come from the stream.
    await until(async () => (await hc.callsOf('server.status')).length >= 1)
    await Bun.sleep(300)
    const lists = (await hc.callsOf('terminal.list')).length

    await hc.setStatus(session, 'blocked')
    await until(async () => (await e.agents())[0]?.status === 'blocked')
    expect(seen).toContainEqual({
      kind: 'status',
      agent: { paneId: session, name: 'spawn-1', factoryKey: 'spawn-1', status: 'blocked', cwd: '/work/repo' },
    })

    await hc.kill9(session)
    await until(async () => (await e.agents()).length === 0)
    expect(seen).toContainEqual({ kind: 'gone', paneId: session, factoryKey: 'spawn-1' })
    expect((await hc.callsOf('terminal.list')).length).toBe(lists)

    // A new terminal is a `created` event, then its status.
    const other = await spawn('other')
    await until(async () => (await e.agents()).some((a) => a.paneId === other.session))

    await hc.finish(other.session)
    await until(async () => (await e.agents()).length === 0)
    expect(seen.filter((c) => c.kind === 'gone')).toHaveLength(3)
  })

  test('a core restart ends the stream: it reconnects, announces the restart once and the cache is whole again', async () => {
    const { session } = await spawn()
    const e = stream()
    const seen = changes(e)
    await until(() => e.streaming)
    // The identity is read right after the snapshot; a restart before that has nothing to compare with.
    await until(async () => (await hc.callsOf('server.status')).length >= 1)
    await Bun.sleep(200)
    expect(seen.filter((c) => c.kind === 'restart')).toHaveLength(0)

    await hc.restartCore()
    await until(() => seen.some((c) => c.kind === 'restart'))
    await Bun.sleep(150)
    expect(seen.filter((c) => c.kind === 'restart')).toHaveLength(1)
    expect((await e.agents()).map((a) => a.paneId)).toEqual([session])
    expect(await e.serverId()).toBe(`4243@${'0123456789abcdef'.repeat(2)}`)
    // And the new stream is live: a change after the restart arrives.
    await hc.setStatus(session, 'idle')
    await until(async () => (await e.agents())[0]?.status === 'idle')
  })

  test('a stream that cannot start is retried with a growing wait, and agents() asks the core directly meanwhile', async () => {
    await spawn()
    await hc.plan('events.subscribe:exit1', 'events.subscribe:exit1')
    const e = stream()
    expect((await e.agents()).length).toBe(1)
    await until(async () => (await hc.callsOf('events.subscribe')).length >= 3)
  })

  test('a truncated line is dropped and the state is read again', async () => {
    const { session } = await spawn()
    const e = stream()
    await until(() => e.streaming)
    // The reads that follow the snapshot are done before the line comes: the one that follows the line is then the only
    // one left, and it is what must bring the status in.
    await until(async () => (await hc.callsOf('server.status')).length >= 1)
    await Bun.sleep(300)
    await hc.mutate((state) => {
      const t = state.terminals.find((x) => x.address === session)
      if (t) t.status = { app: 'claude-code', state: 'idle' }
    })
    expect((await e.agents())[0]?.status).toBe('working')
    const lists = (await hc.callsOf('terminal.list')).length
    await hc.emitRaw('{"jsonrpc":"2.0","method":"event","params":{"data":{"labe')
    await until(async () => (await hc.callsOf('terminal.list')).length > lists)
    await until(async () => (await e.agents())[0]?.status === 'idle')
  })

  test('a list that was read before an event does not undo it: a terminal removed or finished meanwhile stays so', async () => {
    const a = await spawn('a')
    const b = await spawn('b')
    const c = await spawn('c')
    const e = stream()
    await until(() => e.streaming)
    await until(async () => (await hc.callsOf('server.status')).length >= 1)
    await Bun.sleep(300)

    // The refresh's answer is a picture of this moment, delivered 400 ms late.
    await hc.plan('terminal.list:slow')
    const lists = (await hc.callsOf('terminal.list')).length
    await hc.emitRaw('{"jsonrpc":"2.0","method":"event","params":{"data":{"labe')
    await until(async () => (await hc.callsOf('terminal.list')).length > lists)
    await hc.finish(a.session)
    await hc.remove(b.session)
    await hc.setStatus(c.session, 'blocked')
    await until(async () => (await e.agents()).length === 1)

    // The late answer arrives and still lists a and b as running agents.
    await Bun.sleep(700)
    const agents = await e.agents()
    expect(agents.map((x) => [x.paneId, x.status])).toEqual([[c.session, 'blocked']])
  })

  test('a list that is older than a new stream is dropped whole', async () => {
    const a = await spawn('a')
    const e = stream()
    await until(() => e.streaming)
    await until(async () => (await hc.callsOf('server.status')).length >= 1)
    await Bun.sleep(300)
    await hc.plan('terminal.list:slow')
    const lists = (await hc.callsOf('terminal.list')).length
    await hc.emitRaw('{"jsonrpc":"2.0","method":"event","params":{"data":{"labe')
    await until(async () => (await hc.callsOf('terminal.list')).length > lists)
    // The core restarts: the new stream's snapshot is the truth, and the old picture must not replace it.
    await hc.finish(a.session)
    await hc.restartCore()
    await Bun.sleep(900)
    expect(await e.agents()).toEqual([])
  })

  test('a subscriber that fell behind (`missed`) takes the terminals of the snapshot as the truth', async () => {
    const { session } = await spawn()
    const e = stream()
    await until(() => e.streaming)
    await hc.emitRaw(JSON.stringify({ jsonrpc: '2.0', method: 'missed', params: { seq: 500, terminals: [] } }))
    await until(async () => (await e.agents()).length === 0)
    // Events at or below the snapshot's sequence are old news; later ones count.
    await hc.announce('status', session, { records: {}, reported: true, status: { state: 'working' } })
    expect((await e.agents()).length).toBe(0)
  })

  test('a tab the app has adopted since is named after its spawn on the next document event, once', async () => {
    const { tab } = await spawn()
    const e = stream()
    await until(() => e.streaming)
    expect(await hc.callsOf('doc.set')).toHaveLength(0)

    // The app adopts the tab: its entry appears in the document, under a number.
    const sets = (await hc.callsOf('doc.set')).length
    await hc.setDoc('herdr-app', { spaces: [{ id: 'sp-x', folder: '/work/repo', tabs: [{ id: tab, name: '3' }] }] })
    await hc.announce('doc', undefined, { name: 'herdr-app', version: 1 })
    await until(async () => (await hc.callsOf('doc.set')).length === sets + 1)
    const doc = (await hc.state()).docs['herdr-app']?.value as { spaces: { tabs: { name: string }[] }[] }
    expect(doc.spaces[0]?.tabs[0]?.name).toBe('spawn-1')
    // Its own write comes back as an event and finds nothing left to do.
    await Bun.sleep(200)
    expect(await hc.callsOf('doc.set')).toHaveLength(sets + 1)
  })

  test('a failing document never reaches the stream loop', async () => {
    const { tab, session } = await spawn()
    const e = stream()
    await until(() => e.streaming)
    await hc.setDoc('herdr-app', { spaces: [{ id: 'sp-x', tabs: [{ id: tab, name: '3' }] }] })
    await hc.plan('doc.get:exit1', 'doc.get:garbage')
    await hc.announce('doc', undefined, { name: 'herdr-app', version: 1 })
    await hc.setStatus(session, 'idle')
    await until(async () => (await e.agents())[0]?.status === 'idle')
  })
})

describe('the worktree probe', () => {
  test('a cwd inside the worktree still finds the changed files, and git gets no server secrets', async () => {
    const dir = await mkdtemp('/tmp/factory-git-')
    try {
      const git = (...args: string[]) =>
        Bun.spawn(['git', '-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
          stdout: 'ignore',
          stderr: 'ignore',
        }).exited
      await git('init', '-q')
      await mkdir(join(dir, 'deep/er'), { recursive: true })
      await writeFile(join(dir, 'deep/er/a.txt'), 'a')
      await git('add', '.')
      await git('commit', '-q', '-m', 'one', '--date=2020-01-01T00:00:00Z')
      const old = new Date('2020-01-01T00:00:00Z')
      await utimes(join(dir, 'deep/er/a.txt'), old, old)
      await writeFile(join(dir, 'deep/er/a.txt'), 'changed now')
      const changed = await gitProbe(join(dir, 'deep/er'))
      expect(changed && Date.now() - changed.getTime() < 60_000).toBe(true)

      // The child's environment, as git sees it.
      const spy = join(dir, 'spy-git')
      await writeFile(spy, `#!/bin/sh\nenv > '${dir}/git-env'\nexec git "$@"\n`)
      await chmod(spy, 0o755)
      process.env.FACTORY_TOKEN = 'secret-token-for-the-test'
      process.env.DATABASE_URL = 'postgres://secret'
      try {
        await gitProbe(dir, spy)
      } finally {
        delete process.env.FACTORY_TOKEN
        delete process.env.DATABASE_URL
      }
      const seen = await readFile(join(dir, 'git-env'), 'utf8')
      expect(seen).toContain('GIT_OPTIONAL_LOCKS=0')
      expect(seen).not.toContain('FACTORY_TOKEN')
      expect(seen).not.toContain('DATABASE_URL')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('the newest of the last commit and the files git lists as changed', async () => {
    const dir = await mkdtemp('/tmp/factory-git-')
    try {
      const git = (...args: string[]) =>
        Bun.spawn(['git', '-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
          stdout: 'ignore',
          stderr: 'ignore',
        }).exited
      await git('init', '-q')
      await writeFile(join(dir, 'a.txt'), 'a')
      await git('add', '.')
      await git('commit', '-q', '-m', 'one')
      const committed = await gitProbe(dir)
      expect(committed).toBeInstanceOf(Date)

      await Bun.sleep(1100)
      await writeFile(join(dir, 'b.txt'), 'untracked and new')
      const edited = await gitProbe(dir)
      expect(edited && committed && edited.getTime() > committed.getTime()).toBe(true)
      expect(await gitProbe('/tmp/definitely-not-a-worktree-dir')).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
