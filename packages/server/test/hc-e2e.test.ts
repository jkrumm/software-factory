import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { systemClock } from '../src/clock.ts'
import { HcClient } from '../src/hc.ts'
import { HcEvents } from '../src/hc-events.ts'
import { HcRunner } from '../src/hc-runner.ts'
import type { StartInput } from '../src/runner.ts'
import { getSession, recordEvent } from '../src/sessions.ts'
import { witness } from '../src/witness.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

// Opt-in: `HC_E2E=1 bun test test/hc-e2e.test.ts` runs the HcRunner against a real herdr-core of its own (a scratch
// session with scratch XDG directories, stopped afterwards) and a stub in place of claude. It never touches the
// default core. `HC_E2E_BIN` names the hc binary (default `hc`).
const enabled = process.env.HC_E2E === '1'
const bin = process.env.HC_E2E_BIN ?? 'hc'
const XDG = ['XDG_RUNTIME_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'] as const

let dir: string
let db: TestDb | undefined
let runner: HcRunner
const saved: Record<string, string | undefined> = {}
const session = `factory-e2e-${process.pid}`
const input: StartInput = {
  key: 'e2e-1',
  repo: tmpdir(),
  role: 'lead',
  prompt: 'do it',
  account: 'a',
  tier: 'sonnet',
  effort: 'high',
}

const scratch = (): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  HC_SESSION: session,
  XDG_RUNTIME_DIR: join(dir, 'run'),
  XDG_DATA_HOME: join(dir, 'data'),
  XDG_CONFIG_HOME: join(dir, 'config'),
  XDG_STATE_HOME: join(dir, 'state'),
})

async function hc(...args: string[]): Promise<string> {
  const proc = Bun.spawn([bin, ...args], { env: scratch(), stdout: 'pipe', stderr: 'pipe' })
  const [out] = await Promise.all([proc.stdout.text(), proc.exited])
  return out
}

beforeAll(async () => {
  if (!enabled) return
  db = await startTestDb()
  dir = await mkdtemp('/tmp/factory-hc-e2e-') // short: the core's socket path must fit a unix socket's limit
  const env = scratch()
  for (const name of XDG) {
    saved[name] = process.env[name]
    process.env[name] = env[name]
  }
  await Promise.all(XDG.map((name) => mkdir(env[name] as string, { recursive: true, mode: 0o700 })))
  // `hc connect` does not start a core by itself; `server status` does.
  await hc('server', 'status')
  // The stub stands in for claude: it records its arguments and environment, says it is working (OSC 7501), and stays.
  const claude = join(dir, 'claude')
  await writeFile(
    claude,
    `#!/bin/sh\necho "ARGV: $*" > '${dir}'/args.$$\necho "CCD=[\${CLAUDE_CONFIG_DIR-unset}] FS=$FACTORY_SESSION" >> '${dir}'/args.$$\nprintf '\\033]7501;state=working\\007'\nsleep 120\n`,
  )
  await chmod(claude, 0o755)
  const accountsFile = join(dir, 'accounts.json')
  await writeFile(accountsFile, JSON.stringify({ accounts: { a: { dir: null } } }))
  runner = new HcRunner({
    bin,
    session,
    claudeBin: claude,
    clock: systemClock,
    pretrustBin: '/usr/bin/true',
    accountsFile,
    deliverWaitMs: 10_000,
  })
})

afterAll(async () => {
  if (!enabled) return
  // Only ever the scratch session: its own socket lives in the scratch XDG_RUNTIME_DIR.
  await hc('server', 'stop')
  await db?.stop()
  for (const name of XDG) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  await rm(dir, { recursive: true, force: true })
})

describe.skipIf(!enabled)('HcRunner against a real herdr-core (HC_E2E=1)', () => {
  test('starts the stub as a labelled tab, finds it again, and starts afresh once it is removed', async () => {
    const first = await runner.start(input)
    const list = JSON.parse(await hc('ls', '--json')) as { address: string }[] | { terminals: { address: string }[] }
    const terminals = Array.isArray(list) ? list : list.terminals
    expect(terminals.map((t) => t.address)).toContain(first.session)

    const got = JSON.parse(await hc('get', first.session)) as {
      labels: Record<string, string>
      cwd: string
      reported: boolean
      parent: string | null
      argv: string[]
    }
    expect(got.reported).toBe(true)
    expect(got.parent).toBeNull()
    expect(got.cwd).toBe(input.repo)
    expect(got.labels).toMatchObject({
      'factory.key': 'e2e-1',
      'herdr.space': first.workspace,
      'herdr.tab': first.tab,
    })
    expect(got.argv.at(-1)).toBe('do it')

    expect(await runner.start(input)).toEqual(first)

    // It reported and then ended: its prompt ran, so it is the started agent, not one to run again.
    await hc('kill', first.session)
    expect(await runner.start(input)).toEqual(first)
    await hc('rm', first.session)
    const again = await runner.start(input)
    expect(again.session).not.toBe(first.session)
    expect(await runner.type({ pane: again.session, text: 'x' })).toBe('busy')
  }, 60_000)

  test('a worker with a parent terminal is its hidden child', async () => {
    const lead = await runner.start({ ...input, key: 'e2e-lead' })
    const kid = await runner.start({ ...input, key: 'e2e-kid', role: 'worker', parentTerminal: lead.session })
    const got = JSON.parse(await hc('get', kid.session)) as { parent: string; labels: Record<string, string> }
    expect(got.parent).toBe(lead.session)
    expect(got.labels).toEqual({ 'factory.key': 'e2e-kid' })
  }, 60_000)

  describe('the witness on the event stream', () => {
    const until = async (check: () => boolean | Promise<boolean>, ms = 15_000) => {
      const end = Date.now() + ms
      while (Date.now() < end && !(await check())) await Bun.sleep(50)
      expect(await check()).toBe(true)
    }
    const sql = () => (db as TestDb).sql
    const pass = (events: HcEvents) =>
      witness({ sql: sql(), runner: events, clock: systemClock, probe: async () => undefined })
    const register = async (key: string, address: string) => {
      const at = new Date(Date.now() - 600_000)
      await recordEvent(sql(), {
        key: `${key}:started`,
        session: key,
        kind: 'session_started',
        at,
        payload: { claudeSessionId: `claude-${key}`, pane: address },
      })
    }
    const state = async (key: string) => (await getSession(sql(), key, new Date()))?.state

    test('kill -9 of the program: the kept terminal is a shell, and two passes later the pane is gone', async () => {
      await (db as TestDb).reset()
      const { session: address } = await runner.start({ ...input, key: 'e2e-w' })
      await register('e2e-w', address)
      const events = new HcEvents({ client: new HcClient({ bin, session }), backoffMs: 100, maxBackoffMs: 500 })
      events.start()
      try {
        await until(() => events.streaming)
        expect(await pass(events)).toMatchObject({ seen: expect.any(Number), restarted: false, gone: [] })
        expect((await getSession(sql(), 'e2e-w', new Date()))?.agentStatus).toBe('working')

        const got = JSON.parse(await hc('get', address)) as { pid: number }
        process.kill(got.pid, 'SIGKILL')
        await until(async () => !(await events.agents()).some((a) => a.paneId === address))

        expect((await pass(events)).gone).toEqual([])
        expect((await pass(events)).gone).toEqual(['e2e-w'])
        expect(await state('e2e-w')).toBe('dead')
      } finally {
        await events.stop()
      }
    }, 60_000)

    test('a core restart is one runner_restarted, and a session that was working is still there afterwards', async () => {
      await (db as TestDb).reset()
      const { session: address } = await runner.start({ ...input, key: 'e2e-r' })
      await register('e2e-r', address)
      const events = new HcEvents({ client: new HcClient({ bin, session }), backoffMs: 100, maxBackoffMs: 500 })
      const changes: string[] = []
      events.watch((c) => changes.push(c.kind))
      events.start()
      try {
        await until(() => events.streaming)
        await Bun.sleep(500)
        expect((await pass(events)).restarted).toBe(false)

        await hc('server', 'restart')
        await until(() => changes.includes('restart'))
        await until(() => events.streaming)
        expect((await pass(events)).restarted).toBe(true)
        expect((await pass(events)).restarted).toBe(false)
        expect((await pass(events)).restarted).toBe(false)

        const restarts = await sql()`SELECT session, kind FROM factory.events WHERE kind = 'runner_restarted'`
        expect(restarts).toEqual([{ session: '_runner', kind: 'runner_restarted' }])
        expect(changes.filter((c) => c === 'restart')).toHaveLength(1)
        expect(await state('e2e-r')).not.toBe('dead')
        expect((await getSession(sql(), 'e2e-r', new Date()))?.agentStatus).toBe('working')
      } finally {
        await events.stop()
      }
    }, 90_000)
  })
})
