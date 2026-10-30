// Gameday F1-5: the database restored from last night's dump, on a scratch cluster and a fake herdr.
// The world: sessions working in panes, spawns, recorded prompts and a declared wait; a dump taken at one moment; more
// of everything after it; the server stops, the dump is restored into a database of its own, a new server starts on it
// against the same herdr and the same spool directory. What the tests read is what the new server does to the panes
// that are still there.
import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { EMPTY_SUMMARY, type EventKind, nextKey, parseSpool, summarize } from '@software-factory/contract/spool'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { migrate } from '../src/db.ts'
import { QuotaPoller } from '../src/quota.ts'
import { HerdrRunner } from '../src/runner.ts'
import { declareWait, getSession } from '../src/sessions.ts'
import { createSpawn } from '../src/spawns.ts'
import { SpoolReplayer } from '../src/spool.ts'
import { tick } from '../src/tick.ts'
import { FakeClock } from './support/clock.ts'
import { createFakeHerdr, type FakeHerdr, type FakeState } from './support/herdr.ts'
import { startTestDb, type TestDb } from './support/pg.ts'
import { FakeQuotaSource, usage, WORKER } from './support/quota.ts'

const ACCOUNTS = ['a', 'b', 'c', 'd', 'e', 'f']
const REPO = '/work/repo'

let db: TestDb
let herdr: FakeHerdr
let clock: FakeClock
let source: FakeQuotaSource
let spoolDir: string
let scratch: string
const pools: SQL[] = []

beforeAll(async () => {
  db = await startTestDb()
  herdr = await createFakeHerdr()
  scratch = await mkdtemp('/tmp/factory-restore-')
})
afterAll(async () => {
  for (const pool of pools) await pool.close().catch(() => {})
  await herdr.cleanup()
  await db.stop()
  await rm(scratch, { recursive: true, force: true })
})

// --- the scratch cluster's own tools ---------------------------------------------------------------------------------

function pgTool(name: string): string {
  const dir = process.env.PG_BIN_DIR
  if (dir) return join(dir, name)
  return Bun.which(name) ?? join('/usr/lib/postgresql', '17', 'bin', name)
}

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'pipe' })
  const [stderr, code] = await Promise.all([proc.stderr.text(), proc.exited])
  if (code !== 0) throw new Error(`${cmd.join(' ')} exited ${code}: ${stderr}`)
}

/** `-h <socket dir> -p <port> -U factory` of the scratch cluster, taken from the socket path the harness reports. */
const connection = (): string[] => ['-h', dirname(db.path), '-p', db.path.split('.').pop() as string, '-U', 'factory']

const connect = (database: string): SQL => {
  const pool = new SQL({ adapter: 'postgres', path: db.path, username: 'factory', database, max: 4 })
  pools.push(pool)
  return pool
}

const dump = (file: string) =>
  run([pgTool('pg_dump'), ...connection(), '-d', 'postgres', '--schema=factory', '-f', file])

/** The dump restored into a database of its own: the live one is never touched. */
async function restore(file: string, name: string): Promise<SQL> {
  await db.sql.unsafe(`CREATE DATABASE ${name}`)
  await run([pgTool('psql'), ...connection(), '-d', name, '-q', '-v', 'ON_ERROR_STOP=1', '-f', file])
  return connect(name)
}

// --- one server process: its pool, its spool reader, its runner -----------------------------------------------------

class Server {
  readonly quota: QuotaPoller
  readonly spool: SpoolReplayer
  readonly runner: HerdrRunner

  constructor(readonly sql: SQL) {
    this.quota = new QuotaPoller({ sql, clock, source })
    this.spool = new SpoolReplayer({ sql, dir: spoolDir, now: () => clock.now() })
    this.runner = new HerdrRunner({
      bin: herdr.bin,
      clock,
      pretrustBin: herdr.pretrustBin,
      accountsFile: herdr.accountsFile,
      home: '/home/me',
      deliverWaitMs: 3_000,
    })
  }

  async boot(): Promise<void> {
    await migrate(this.sql)
    await this.quota.poll()
  }

  async pass(times = 1): Promise<void> {
    for (let i = 0; i < times; i++) {
      clock.advance(5_000)
      const result = await tick({ sql: this.sql, runner: this.runner, clock, spool: this.spool, quota: this.quota })
      expect(result.errors).toEqual([])
    }
  }

  spawn(key: string, extra: { parent?: string } = {}) {
    return createSpawn(this.sql, { key, repo: REPO, prompt: `work on ${key}`, ...WORKER, ...extra }, clock.now())
  }
}

// --- the hooks: lines appended to the spool, numbered the way the hook numbers them -------------------------------

async function hook(session: string, kind: EventKind, payload: Record<string, unknown> = {}): Promise<void> {
  const file = join(spoolDir, `${session}.jsonl`)
  const lines = parseSpool(await readFile(file, 'utf8').catch(() => ''))
  const key = nextKey(summarize(EMPTY_SUMMARY, lines), session, kind)
  clock.advance(1_000)
  await appendFile(file, `${JSON.stringify({ key, session, kind, at: clock.now().toISOString(), payload })}\n`)
}

const started = (session: string) => hook(session, 'session_started', { claudeSessionId: `claude-${session}` })

const view = async (): Promise<FakeState> => herdr.state()
const tabsOf = (state: FakeState, key: string) => state.tabs.filter((t) => t.label === key)
const paneOf = (state: FakeState, key: string) => {
  const tab = tabsOf(state, key)[0]
  return state.panes.find((p) => p.tab_id === tab?.tab_id)?.pane_id
}
const promptsOf = (state: FakeState, key: string) => state.prompts.filter((p) => p.pane === paneOf(state, key))

// --- the world --------------------------------------------------------------------------------------------------------

interface World {
  before: FakeState
  after: FakeState
  restored: Server
  /** the dump was taken with these in it */
  atDump: { wakeRows: number; spawns: string[] }
  /** the restored database before the new server touched anything */
  loaded: { spawns: string[]; wakeRows: number }
  /** the client of `b` asks again after the restart, as one that never got an answer would */
  retriedB: { created: boolean }
}

let world: World

async function build(): Promise<World> {
  clock = new FakeClock()
  source = new FakeQuotaSource()
  source.readings = ACCOUNTS.map((account) => ({
    account,
    ...usage(1, 1, new Date(clock.now().getTime() + 1_000 * 3_600_000)),
  }))
  spoolDir = join(scratch, 'spool')
  await mkdir(spoolDir)

  const old = new Server(db.sql)
  await old.boot()

  // Before the dump: `a` works, `o` orchestrates `k1` and waits on its workers, `k1` works.
  await old.spawn('a')
  await old.spawn('o')
  await old.spawn('k1', { parent: 'o' })
  await old.pass()
  for (const key of ['a', 'o', 'k1']) {
    await started(key)
    await hook(key, 'turn_started')
  }
  await declareWait(old.sql, 'o', { on: 'workers' }, clock.now())
  await hook('o', 'turn_ended')
  await herdr.setAgentStatus(paneOf(await view(), 'o') as string, 'idle')
  // `c` is queued with an account and has not started when the dump is taken.
  await old.spawn('c')
  const dumpFile = join(scratch, 'last-night.sql')
  await dump(dumpFile)
  const [{ n: wakeRows }] = await old.sql`SELECT count(*)::int AS n FROM factory.prompts WHERE id LIKE 'wake:%'`
  const atDump = {
    wakeRows: wakeRows as number,
    spawns: (await old.sql`SELECT key FROM factory.spawns ORDER BY key`).map((r: { key: string }) => r.key),
  }

  // After the dump: `c` and `b` start, `c` runs to its end and its tab is closed, `k1` finishes, `o` is woken, carries
  // on and clears its wait, `a` works another turn.
  clock.advance(60_000)
  await old.quota.poll()
  await old.spawn('b')
  await old.pass()
  await started('b')
  await hook('b', 'turn_started')
  await started('c')
  await hook('c', 'turn_started')
  await hook('c', 'turn_ended')
  await hook('c', 'session_ended')
  const tab = tabsOf(await view(), 'c')[0]
  if (tab) await run([herdr.bin, 'tab', 'close', tab.tab_id])
  await hook('a', 'turn_ended')
  await hook('a', 'turn_started')
  await hook('k1', 'turn_ended')
  await old.pass() // the wake rule records its note and types it into `o`
  await hook('o', 'turn_started')
  await old.pass() // delivered
  await declareWait(old.sql, 'o', { done: true }, clock.now())
  await hook('o', 'turn_ended')
  await herdr.setAgentStatus(paneOf(await view(), 'o') as string, 'idle')
  const before = await view()

  // The server stops. The dump is restored into a database of its own and a new server starts on it.
  const restoredSql = await restore(dumpFile, 'restored')
  const loadedRows = await restoredSql`SELECT key FROM factory.spawns ORDER BY key`
  const [{ n: loadedWake }] = await restoredSql`SELECT count(*)::int AS n FROM factory.prompts WHERE id LIKE 'wake:%'`
  const restored = new Server(restoredSql)
  await restored.boot()
  const retriedB = await restored.spawn('b')
  await restored.pass(3)
  return {
    before,
    after: await view(),
    restored,
    atDump,
    loaded: { spawns: loadedRows.map((r: { key: string }) => r.key), wakeRows: loadedWake as number },
    retriedB: { created: retriedB.created },
  }
}

beforeAll(async () => {
  world = await build()
}, 120_000)

describe('the database restored from an earlier dump', () => {
  test('the dump holds what was known at its moment and nothing after it', () => {
    expect(world.atDump.wakeRows).toBe(0)
    expect(world.loaded.wakeRows).toBe(0)
    expect(world.loaded.spawns).toEqual(world.atDump.spawns)
    // `b` was created after the dump: its row is gone, its pane is not.
    expect(world.loaded.spawns).not.toContain('b')
    expect(tabsOf(world.before, 'b')).toHaveLength(1)
  })

  test('the panes that were running are found again: one tab, one agent, one first prompt for each key', () => {
    for (const key of ['a', 'o', 'k1', 'b']) {
      const tabs = tabsOf(world.after, key)
      expect(tabs).toHaveLength(1)
      const pane = paneOf(world.after, key)
      expect(world.after.agents.filter((a) => a.pane_id === pane)).toHaveLength(1)
      expect(tabs[0]?.tab_id).toBe(tabsOf(world.before, key)[0]?.tab_id as string)
      expect(promptsOf(world.after, key)[0]?.text).toBe(`work on ${key}`)
    }
  })

  test('a client that asks again for a spawn whose row was lost gets its running pane back, with no second tab or prompt', () => {
    expect(world.retriedB.created).toBe(true)
    expect(tabsOf(world.after, 'b')).toHaveLength(1)
    expect(promptsOf(world.after, 'b')).toHaveLength(1)
    expect(world.after.agents.filter((a) => a.pane_id === paneOf(world.after, 'b'))).toHaveLength(1)
  })

  test('the restored server starts no agent in a pane that already has one, and opens no extra space', () => {
    expect(world.after.workspaces).toEqual(world.before.workspaces)
    for (const key of ['a', 'o', 'k1', 'b']) expect(tabsOf(world.after, key)).toEqual(tabsOf(world.before, key))
  })

  test('the spool brings the sessions back to what the panes did after the dump', async () => {
    const at = world.restored.sql
    const states = Object.fromEntries(
      await Promise.all(
        ['a', 'b', 'c', 'k1'].map(async (id) => [id, (await getSession(at, id, clock.now()))?.state] as const),
      ),
    )
    expect(states).toEqual({ a: 'working', b: 'working', c: 'dead', k1: 'idle' })
  })

  test('replaying the spool a second time (another restart) stores nothing new', async () => {
    const sql = world.restored.sql
    const [{ n: first }] = await sql`SELECT count(*)::int AS n FROM factory.events`
    const again = new SpoolReplayer({ sql, dir: spoolDir, now: () => clock.now() })
    expect((await again.replay()).lines).toBeGreaterThan(0)
    const [{ n: second }] = await sql`SELECT count(*)::int AS n FROM factory.events`
    expect(second).toBe(first)
  })

  test('no identifier outside the database comes from one of its sequences', async () => {
    // Event keys are session, kind and turn, counted from the spool; tab labels are spawn keys; prompt ids are a rule's
    // key or a note's own. The events' bigserial is never written into a pane, a prompt or a key.
    const sql = world.restored.sql
    const keys: { key: string }[] = await sql`SELECT key FROM factory.events WHERE session <> '_herdr'`
    const spooled = new Set<string>()
    for (const key of ['a', 'o', 'k1', 'b', 'c']) {
      for (const line of parseSpool(await readFile(join(spoolDir, `${key}.jsonl`), 'utf8'))) spooled.add(line.key)
    }
    const databaseOnly = keys.filter((k) => !spooled.has(k.key)).map((k) => k.key)
    expect(databaseOnly.every((k) => /^o:wait_declared:[0-9a-f-]{36}$/.test(k))).toBe(true)
    const labels = world.after.tabs.map((t) => t.label).filter((label) => label !== '1')
    expect(labels.every((label) => ['a', 'b', 'c', 'k1', 'o'].includes(label))).toBe(true)
  })

  // --- the two places where the restored server does something twice ---------------------------------------------

  test.failing('a spawn that ran and finished after the dump is not started again from its stale queued row', () => {
    // `c` was `queued` at the dump, started, worked, ended and had its tab closed afterwards. The restored row says
    // queued, the spool says the session lived and ended; the restored server starts it a second time.
    expect(tabsOf(world.after, 'c')).toHaveLength(0)
  })

  test.failing('a wake note that was typed and delivered after the dump is not typed again', () => {
    // `o` was woken, cleared its wait and went on. The wait's clearing and the note's row were database-only facts
    // after the dump: the restored database has the wait open and no note, and the wake rule asks again.
    expect(promptsOf(world.after, 'o')).toHaveLength(2)
  })
})

describe('the spool is not the whole history once it has been rotated', () => {
  test.failing('events of a rotated spool file that came after the dump are gone for good', async () => {
    const dir = join(scratch, 'rotating')
    await mkdir(dir)
    const real = () => new Date()
    const line = (session: string, kind: EventKind, key: string, at: Date) =>
      `${JSON.stringify({ key, session, kind, at: at.toISOString(), payload: {} })}\n`
    const file = join(dir, 'r.jsonl')
    const t0 = new Date(Date.now() - 60_000)

    const live = connect('postgres')
    const first = new SpoolReplayer({ sql: live, dir, now: real, rotateBytes: 1, quietMs: 0 })
    await appendFile(file, line('r', 'session_started', 'r:session_started:0', t0))
    await first.replay()
    const dumpFile = join(scratch, 'rotating.sql')
    await dump(dumpFile)

    // After the dump the session works two turns; the spool file is rotated (its lines stored, the file retired).
    await appendFile(file, line('r', 'turn_started', 'r:turn_started:1', new Date(t0.getTime() + 1_000)))
    await appendFile(file, line('r', 'turn_ended', 'r:turn_ended:1', new Date(t0.getTime() + 2_000)))
    const rotated = await first.replay()
    expect(rotated.rotated).toEqual(['r.jsonl'])

    // The restored database replays what is left of the spool: nothing, the lines were in the retired file.
    const sql = await restore(dumpFile, 'restored_rotated')
    const second = new SpoolReplayer({ sql, dir, now: real, rotateBytes: 1_000_000 })
    await second.replay()
    const kinds = (await sql`SELECT kind FROM factory.events WHERE session = 'r' ORDER BY id`).map(
      (r: { kind: string }) => r.kind,
    )
    expect(kinds).toEqual(['session_started', 'turn_started', 'turn_ended'])
  })
})
