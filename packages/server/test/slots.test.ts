import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { systemClock } from '../src/clock.ts'
import { serveHooks } from '../src/http.ts'
import { listSlots, releaseSlot, SLOT_LEASE_MS, touchSlot, WAITER_TTL_MS } from '../src/slots.ts'
import { TEST_ROLES, TEST_ROOT, TEST_TOKEN } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

let db: TestDb
let clock: FakeClock
beforeAll(async () => {
  db = await startTestDb()
})
afterAll(() => db.stop())
beforeEach(async () => {
  await db.reset()
  clock = new FakeClock()
})

const ask = (id: string, slots = 2) => touchSlot(db.sql, { id, name: id, slots }, clock.now())

describe('the slot semaphore (FL7)', () => {
  test('the first callers up to the limit get a slot each, the next one waits', async () => {
    expect(await ask('a')).toMatchObject({ granted: true, slot: 1 })
    expect(await ask('b')).toMatchObject({ granted: true, slot: 2 })
    expect(await ask('c')).toMatchObject({ granted: false, slot: null, ahead: 0 })
    expect(await ask('d')).toMatchObject({ granted: false, ahead: 1 })
  })

  test('a slot given back goes to the caller that asked first', async () => {
    await ask('a')
    await ask('b')
    await ask('c')
    clock.advance(10)
    await ask('d')
    expect(await releaseSlot(db.sql, 'a')).toBe(true)
    // d asks first after the release, but c has waited longer.
    expect(await ask('d')).toMatchObject({ granted: false, ahead: 1 })
    expect(await ask('c')).toMatchObject({ granted: true, slot: 1 })
  })

  test('the same caller asking again is a renewal, not a second slot', async () => {
    expect(await ask('a')).toMatchObject({ granted: true, slot: 1 })
    expect(await ask('a')).toMatchObject({ granted: true, slot: 1 })
    expect(await db.sql`SELECT id FROM factory.slots`).toHaveLength(1)
  })

  test('a lease that is not renewed expires and frees its slot', async () => {
    await ask('a')
    await ask('b')
    expect(await ask('c')).toMatchObject({ granted: false })
    clock.advance(SLOT_LEASE_MS - 1)
    await ask('b') // b renews
    expect(await ask('c')).toMatchObject({ granted: false })
    clock.advance(2)
    // a's lease is past, b's is not
    expect(await ask('c')).toMatchObject({ granted: true, slot: 1 })
    expect((await listSlots(db.sql)).map((s) => s.id)).toEqual(['c', 'b'])
  })

  test('renewing keeps a slot for as long as the holder renews', async () => {
    await ask('a')
    for (let i = 0; i < 5; i++) {
      clock.advance(SLOT_LEASE_MS - 1_000)
      expect(await ask('a')).toMatchObject({ granted: true, slot: 1 })
    }
  })

  test('a waiter that stops asking leaves the line', async () => {
    await ask('a', 1)
    await ask('gone', 1)
    clock.advance(WAITER_TTL_MS - 1_000)
    await ask('b', 1)
    clock.advance(2_000)
    await ask('a', 1) // a renews; gone has not asked for longer than the window
    expect(await ask('b', 1)).toMatchObject({ granted: false, ahead: 0 })
    expect((await listSlots(db.sql)).map((s) => s.id)).toEqual(['a', 'b'])
  })

  test('giving back what was never held says so', async () => {
    expect(await releaseSlot(db.sql, 'nobody')).toBe(false)
  })

  test('concurrent callers never hold more than the limit', async () => {
    const answers = await Promise.all(Array.from({ length: 8 }, (_, i) => ask(`c${i}`, 3)))
    expect(answers.filter((a) => a.granted)).toHaveLength(3)
    expect(new Set(answers.filter((a) => a.granted).map((a) => a.slot)).size).toBe(3)
  })
})

describe('factory slot run, against the real socket', () => {
  const BIN = join(import.meta.dir, '..', '..', 'cli', 'bin', 'factory.ts')
  let dir: string
  let socket: string
  let hooks: ReturnType<typeof serveHooks>
  beforeAll(() => {
    dir = mkdtempSync('/tmp/factory-slots-')
    socket = join(dir, 'h.sock')
    hooks = serveHooks({
      sql: db.sql,
      clock: systemClock,
      token: TEST_TOKEN,
      socketPath: socket,
      repoRoots: [TEST_ROOT],
      roles: TEST_ROLES,
      slots: 2,
    })
  })
  afterAll(async () => {
    await hooks.stop(true)
    rmSync(dir, { recursive: true, force: true })
  })

  /** `factory slot run …` as a process, the way `make` runs it. */
  const slotRun = (args: string[], env: Record<string, string> = {}) =>
    Bun.spawn(['bun', BIN, 'slot', 'run', ...args], {
      env: { ...process.env, FACTORY_TOKEN: '', FACTORY_SOCKET: socket, FACTORY_SLOT_POLL_MS: '100', ...env },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  const finish = async (proc: ReturnType<typeof slotRun>) => {
    const [stdout, stderr, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
    return { stdout, stderr, code }
  }
  const held = async () => (await listSlots(db.sql)).filter((s) => s.slot !== null).length
  const until = async (condition: () => Promise<boolean>, ms = 15_000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await condition()) return
      await Bun.sleep(50)
    }
    throw new Error('condition not reached')
  }

  test('two run at once, a third waits for one of them, and every slot is given back', async () => {
    const t0 = Date.now()
    const one = slotRun(['--name', 'one', '--', 'sleep', '2'])
    const two = slotRun(['--name', 'two', '--', 'sleep', '2'])
    await until(async () => (await held()) === 2)
    const three = slotRun(['--name', 'three', '--', 'echo', 'third'])
    await until(async () => (await listSlots(db.sql)).some((s) => s.name === 'three' && s.slot === null))
    expect(await held()).toBe(2)
    const out = await finish(three)
    // It could not start before one of the first two ended.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_900)
    expect(out).toEqual({ stdout: 'third\n', stderr: '', code: 0 })
    expect((await finish(one)).code).toBe(0)
    expect((await finish(two)).code).toBe(0)
    expect(await listSlots(db.sql)).toEqual([])
  }, 30_000)

  test("exit code, stdout and stderr are the command's own", async () => {
    const out = await finish(slotRun(['--', 'sh', '-c', 'echo out; echo err >&2; exit 7']))
    expect(out).toEqual({ stdout: 'out\n', stderr: 'err\n', code: 7 })
    expect(await listSlots(db.sql)).toEqual([])
  })

  test('a command that cannot start is 127 and gives the slot back', async () => {
    const out = await finish(slotRun(['--', '/nonexistent/command']))
    expect(out.code).toBe(127)
    expect(out.stderr).toContain('cannot run')
    expect(await listSlots(db.sql)).toEqual([])
  })

  test('a signal ends the command, the slot is given back, the exit code is 128 plus the signal', async () => {
    const proc = slotRun(['--', 'sleep', '30'])
    await until(async () => (await held()) === 1)
    proc.kill('SIGTERM')
    const out = await finish(proc)
    expect(out.code).toBe(143)
    await until(async () => (await listSlots(db.sql)).length === 0)
  })

  test('fail open: with no server it runs the command with one line on stderr', async () => {
    const out = await finish(slotRun(['--', 'echo', 'ran'], { FACTORY_SOCKET: join(dir, 'nobody.sock') }))
    expect(out.stdout).toBe('ran\n')
    expect(out.code).toBe(0)
    expect(out.stderr.trim().split('\n')).toHaveLength(1)
    expect(out.stderr).toContain('running without one')
  })

  test('fail open: with no slot within FACTORY_SLOT_WAIT_MS it runs the command anyway', async () => {
    const a = slotRun(['--', 'sleep', '4'])
    const b = slotRun(['--', 'sleep', '4'])
    await until(async () => (await held()) === 2)
    const late = await finish(slotRun(['--', 'echo', 'anyway'], { FACTORY_SLOT_WAIT_MS: '600' }))
    expect(late.stdout).toBe('anyway\n')
    expect(late.code).toBe(0)
    expect(late.stderr.trim().split('\n')).toHaveLength(1)
    expect(late.stderr).toContain('no test slot within')
    // The one that gave up is out of the line, not a holder.
    expect(await held()).toBe(2)
    expect((await listSlots(db.sql)).filter((s) => s.slot === null)).toEqual([])
    a.kill()
    b.kill()
    await Promise.all([a.exited, b.exited])
  }, 30_000)

  test('a command is required', async () => {
    const out = await finish(slotRun([]))
    expect(out.code).toBe(2)
  })
})
