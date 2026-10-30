import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentName, HerdrRunner } from '../src/runner.ts'
import { getSession, recordEvent } from '../src/sessions.ts'
import { type AgentSeen, gitProbe, HerdrCli, type HerdrView, witness } from '../src/witness.ts'
import { FakeClock } from './support/clock.ts'
import { createFakeHerdr, type FakeHerdr } from './support/herdr.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

let db: TestDb
let herdr: FakeHerdr
let clock: FakeClock

beforeAll(async () => {
  db = await startTestDb()
  herdr = await createFakeHerdr()
})
afterAll(async () => {
  await herdr.cleanup()
  await db.stop()
})
beforeEach(async () => {
  await db.reset()
  await herdr.reset()
  clock = new FakeClock()
})

/** herdr as the test says it is. */
class FakeView implements HerdrView {
  list: AgentSeen[] = []
  server: string | undefined = '100@Sun Oct 11 14:11:39 2026'
  down = false
  async agents(): Promise<AgentSeen[]> {
    if (this.down) throw new Error('herdr agent list timed out after 10000 ms')
    return this.list
  }
  async serverId() {
    return this.server
  }
}

const view = new FakeView()
beforeEach(() => {
  view.list = []
  view.server = '100@Sun Oct 11 14:11:39 2026'
  view.down = false
})
let probed: string[] = []
let changed: Date | undefined
beforeEach(() => {
  probed = []
  changed = undefined
})
const pass = () =>
  witness({
    sql: db.sql,
    herdr: view,
    clock,
    probe: async (cwd) => {
      probed.push(cwd)
      return changed
    },
  })
const state = async (id: string) => (await getSession(db.sql, id, clock.now()))?.state
const emit = (session: string, kind: 'session_started' | 'turn_started' | 'session_ended', at: Date, payload = {}) =>
  recordEvent(db.sql, { key: `${session}:${kind}:${at.toISOString()}`, session, kind, at, payload })
const agent = (over: Partial<AgentSeen> = {}): AgentSeen => ({ paneId: 'w1:p1', status: 'idle', ...over })
const minutes = (n: number) => new Date(clock.now().getTime() - n * 60_000)

describe('the witness', () => {
  test("records each agent's status against its session, found by Claude session id, name or pane", async () => {
    await emit('by-id', 'session_started', minutes(10), { claudeSessionId: 'c-1' })
    await emit('rd-agent', 'session_started', minutes(10), { claudeSessionId: 'c-2' })
    await emit('spawn-key', 'session_started', minutes(10), {})
    await db.sql`UPDATE factory.sessions SET pane = 'w1:p9' WHERE id = 'spawn-key'`
    view.list = [
      agent({ paneId: 'w1:p1', claudeSessionId: 'c-1', status: 'working', name: 'something-else' }),
      agent({ paneId: 'w1:p2', name: 'rd-agent', status: 'idle' }),
      agent({ paneId: 'w1:p9', status: 'blocked' }),
    ]
    await pass()
    const rows = await db.sql`SELECT id, pane, herdr_status, herdr_seen_at FROM factory.sessions ORDER BY id`
    expect(rows.map((r: { id: string; pane: string; herdr_status: string }) => [r.id, r.pane, r.herdr_status])).toEqual(
      [
        ['by-id', 'w1:p1', 'working'],
        ['rd-agent', 'w1:p2', 'idle'],
        ['spawn-key', 'w1:p9', 'blocked'],
      ],
    )
    expect(rows[0]?.herdr_seen_at).toEqual(clock.now())
  })

  test('a spawn key is found by the name herdr gave its agent (clipped and lowercased)', async () => {
    await emit('Spawn_Key.1', 'session_started', minutes(5), {})
    view.list = [agent({ name: agentName('Spawn_Key.1'), status: 'working' })]
    await pass()
    expect((await getSession(db.sql, 'Spawn_Key.1', clock.now()))?.herdrStatus).toBe('working')
  })

  test('the first reading of the herdr server is not a restart; a change is the event herdr_restarted, once', async () => {
    expect((await pass()).restarted).toBe(false)
    expect((await pass()).restarted).toBe(false)
    view.server = '200@Fri Oct 30 13:00:00 2026'
    expect((await pass()).restarted).toBe(true)
    expect((await pass()).restarted).toBe(false)
    const events = await db.sql`SELECT key, session, kind, payload FROM factory.events`
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      session: '_herdr',
      kind: 'herdr_restarted',
      payload: { from: '100@Sun Oct 11 14:11:39 2026', to: '200@Fri Oct 30 13:00:00 2026' },
    })
    // The pseudo-session is not a session of the factory.
    expect(await db.sql`SELECT 1 FROM factory.sessions WHERE id = '_herdr'`).toHaveLength(0)
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

  test('the pass in which herdr restarted counts no pane as missing: its panes are still coming back', async () => {
    await emit('s', 'session_started', minutes(30), { claudeSessionId: 'c-1' })
    view.list = [agent({ claudeSessionId: 'c-1' })]
    await pass()
    view.list = []
    view.server = '200@Fri Oct 30 13:00:00 2026'
    await pass()
    await pass()
    expect(await state('s')).toBe('idle')
    await pass()
    expect(await state('s')).toBe('dead')
  })

  test('a session herdr never showed is not declared dead, and an ended one is left alone', async () => {
    await emit('never-seen', 'session_started', minutes(30), {})
    await emit('ended', 'session_started', minutes(30), { claudeSessionId: 'c-9' })
    await db.sql`UPDATE factory.sessions SET pane = 'w1:p5' WHERE id = 'ended'`
    await emit('ended', 'session_ended', minutes(5))
    for (let i = 0; i < 4; i++) await pass()
    expect(await state('never-seen')).toBe('idle')
    expect(await db.sql`SELECT 1 FROM factory.events WHERE kind = 'pane_gone'`).toHaveLength(0)
  })

  test('a herdr that does not answer records nothing', async () => {
    await emit('s', 'session_started', minutes(30), { claudeSessionId: 'c-1' })
    view.list = [agent({ claudeSessionId: 'c-1', status: 'working' })]
    await pass()
    view.down = true
    view.server = '999@elsewhere'
    await expect(pass()).rejects.toThrow('timed out')
    view.down = false
    view.list = []
    expect(await db.sql`SELECT 1 FROM factory.events WHERE kind = 'herdr_restarted'`).toHaveLength(0)
  })

  test('stuck: working, herdr working, and a worktree that has not moved for 45 minutes', async () => {
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

    // herdr says the agent is idle: the hooks and herdr disagree, which is not stuck.
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

describe('the herdr adapter', () => {
  test('lists the claude agents through the herdr CLI', async () => {
    await herdr.reset()
    const runner = new HerdrRunner({
      bin: herdr.bin,
      clock,
      pretrustBin: herdr.pretrustBin,
      accountsFile: herdr.accountsFile,
      home: '/home/me',
      deliverWaitMs: 3_000,
    })
    const { session } = await runner.start({ key: 'spawn-1', repo: '/work/repo', prompt: 'go', account: 'a' })
    const agents = await new HerdrCli({ bin: herdr.bin }).agents()
    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({ paneId: session, name: 'spawn-1', status: 'working' })
  })

  test('a herdr that hangs is cut off at the process timeout, an error body is an error', async () => {
    await herdr.plan('agent list:hang')
    await expect(new HerdrCli({ bin: herdr.bin, timeoutMs: 300 }).agents()).rejects.toThrow('timed out after 300 ms')
    await herdr.plan('agent list:garbage')
    await expect(new HerdrCli({ bin: herdr.bin }).agents()).rejects.toThrow('unexpected')
  })

  test('the server is the `herdr server` process: pid and start time', async () => {
    const dir = await mkdtemp('/tmp/factory-ps-')
    try {
      const ps = join(dir, 'ps')
      await writeFile(
        ps,
        [
          '#!/bin/sh',
          "cat <<'EOF'",
          '63242     Sun Oct 11 14:11:39 2026 /usr/bin/python3 /x/herdr-server-start.py',
          '63271     Sun Oct 11 14:11:39 2026 /opt/homebrew/opt/herdr/bin/herdr server',
          '63300     Sun Oct 11 14:12:00 2026 herdr server stop',
          '96800     Fri Oct 30 13:40:01 2026 herdr agent wait x --until idle',
          'EOF',
        ].join('\n'),
      )
      await chmod(ps, 0o755)
      expect(await new HerdrCli({ bin: herdr.bin, psBin: ps }).serverId()).toBe('63271@Sun Oct 11 14:11:39 2026')
      expect(await new HerdrCli({ bin: herdr.bin, psBin: '/nonexistent/ps' }).serverId()).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('the worktree probe', () => {
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
