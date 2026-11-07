import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { systemClock } from '../src/clock.ts'
import { DEFAULT_SLOT_RUN_MS } from '@software-factory/contract'
import { serveHooks } from '../src/http.ts'
import { listSlots, releaseSlot, SLOT_LEASE_MS, slotLines, touchSlot, WAITER_TTL_MS } from '../src/slots.ts'
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

describe('the run limit of a slot', () => {
  const project = (name: string, repo: string, run?: string) =>
    db.sql`
      INSERT INTO factory.projects (name, repo, manifest, make_targets, synced_at, created_at)
      VALUES (${name}, ${repo}, ${run ? { slots: { run } } : null}, NULL, ${clock.now()}, ${clock.now()})`
  const grant = (id: string, extra: { cwd?: string; limitMs?: number } = {}) =>
    touchSlot(db.sql, { id, name: id, slots: 4, ...extra }, clock.now())

  test('the default when nothing says otherwise', async () => {
    expect((await grant('a')).runMs).toBe(DEFAULT_SLOT_RUN_MS)
    expect((await grant('b', { cwd: '/nowhere/at/all' })).runMs).toBe(DEFAULT_SLOT_RUN_MS)
  })

  test("the caller's limitMs beats the manifest", async () => {
    await project('p', '/work/p', '45m')
    expect((await grant('a', { cwd: '/work/p', limitMs: 5_000 })).runMs).toBe(5_000)
  })

  test('the manifest of the project whose repo is the cwd or a parent of it, a worktree included', async () => {
    await project('p', '/work/p', '45m')
    await project('other', '/work/p-other', '10m')
    expect((await grant('a', { cwd: '/work/p' })).runMs).toBe(45 * 60_000)
    expect((await grant('b', { cwd: '/work/p/.claude/worktrees/x' })).runMs).toBe(45 * 60_000)
    // A sibling whose name only starts the same is not inside the repo.
    expect((await grant('c', { cwd: '/work/p-other/src' })).runMs).toBe(10 * 60_000)
    expect((await grant('d', { cwd: '/work/pp' })).runMs).toBe(DEFAULT_SLOT_RUN_MS)
  })

  test('the longest repo wins, and a project without the key gives the default', async () => {
    await project('outer', '/work', '1h')
    await project('inner', '/work/inner', '2h')
    await project('plain', '/work/plain')
    expect((await grant('a', { cwd: '/work/inner/x' })).runMs).toBe(2 * 3_600_000)
    expect((await grant('b', { cwd: '/work/else' })).runMs).toBe(3_600_000)
    expect((await grant('c', { cwd: '/work/plain' })).runMs).toBe(DEFAULT_SLOT_RUN_MS)
  })

  test('a renewal keeps the stored value', async () => {
    await project('p', '/work/p', '45m')
    expect((await grant('a', { cwd: '/work/p' })).runMs).toBe(45 * 60_000)
    await db.sql`UPDATE factory.projects SET manifest = ${{ slots: { run: '5m' } }}`
    expect((await grant('a', { cwd: '/work/p' })).runMs).toBe(45 * 60_000)
    expect((await grant('a', { limitMs: 1_000 })).runMs).toBe(45 * 60_000)
  })

  test('a line once a held slot is past half its limit, naming holder and limit, none for a lapsed lease', async () => {
    await grant('first', { limitMs: 30 * 60_000 })
    expect(await slotLines(db.sql, clock.now())).toEqual([])
    const hold = async (ms: number) => {
      for (let t = 0; t < ms; t += 10_000) {
        clock.advance(10_000)
        await grant('first') // renews
      }
    }
    await hold(14 * 60_000)
    expect(await slotLines(db.sql, clock.now())).toEqual([])
    await hold(6 * 60_000)
    expect(await slotLines(db.sql, clock.now())).toEqual(['test slot 1 held by "first" for 20 min, limit 30 min'])
    clock.advance(SLOT_LEASE_MS + 1)
    expect(await slotLines(db.sql, clock.now())).toEqual([])
  })

  test('a lease from before the columns has no line', async () => {
    await grant('old', { limitMs: 60_000 })
    await db.sql`UPDATE factory.slots SET granted_at = NULL, run_ms = NULL`
    clock.advance(10_000)
    expect(await slotLines(db.sql, clock.now())).toEqual([])
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

  test('a SIGINT sent to the wrapper alone reaches the command and gives the slot back', async () => {
    const proc = slotRun(['--', 'sleep', '30'])
    await until(async () => (await held()) === 1)
    proc.kill('SIGINT')
    const out = await finish(proc)
    expect(out.code).toBe(130)
    await until(async () => (await listSlots(db.sql)).length === 0)
  })

  /** A command that leaves a background `sleep` behind and writes its pid to `file`. */
  const hung = (file: string, trap = '') => ['--', 'sh', '-c', `${trap}sleep 300 & echo $! > ${file}; wait`]
  const dead = (pid: number) => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  }

  test('a command past the run limit is killed with its children, exit 124, the slot is free', async () => {
    const pidfile = join(dir, 'hung.pid')
    const t0 = Date.now()
    const out = await finish(slotRun(hung(pidfile), { FACTORY_SLOT_RUN_MS: '700' }))
    expect(out.code).toBe(124)
    expect(out.stderr).toBe(
      'factory: the command ran past the test-slot run limit of 700 ms (FACTORY_SLOT_RUN_MS, or slots.run in project.yaml); killed its process group\n',
    )
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(await held()).toBe(0)
    expect(await listSlots(db.sql)).toEqual([])
    const pid = Number(readFileSync(pidfile, 'utf8').trim())
    await until(async () => dead(pid), 3_000)
  }, 30_000)

  test('a command within the limit is unaffected', async () => {
    const out = await finish(slotRun(['--', 'sh', '-c', 'echo out; exit 3'], { FACTORY_SLOT_RUN_MS: '20000' }))
    expect(out).toEqual({ stdout: 'out\n', stderr: '', code: 3 })
  })

  test('a command that ignores SIGTERM is killed after the grace', async () => {
    const pidfile = join(dir, 'stubborn.pid')
    const out = await finish(
      slotRun(hung(pidfile, "trap '' TERM; "), { FACTORY_SLOT_RUN_MS: '600', FACTORY_SLOT_KILL_GRACE_MS: '300' }),
    )
    expect(out.code).toBe(124)
    expect(await held()).toBe(0)
    await until(async () => dead(Number(readFileSync(pidfile, 'utf8').trim())), 3_000)
  }, 30_000)

  test('fail open: with no server it runs the command with one line on stderr', async () => {
    const out = await finish(slotRun(['--', 'echo', 'ran'], { FACTORY_SOCKET: join(dir, 'nobody.sock') }))
    expect(out.stdout).toBe('ran\n')
    expect(out.code).toBe(0)
    expect(out.stderr.trim().split('\n')).toHaveLength(1)
    expect(out.stderr).toContain('running without one')
  })

  test('closed on contention: with no slot within FACTORY_SLOT_WAIT_MS it exits 75 without running the command', async () => {
    const a = slotRun(['--', 'sleep', '4'])
    const b = slotRun(['--', 'sleep', '4'])
    await until(async () => (await held()) === 2)
    const late = await finish(slotRun(['--', 'echo', 'anyway'], { FACTORY_SLOT_WAIT_MS: '600' }))
    expect(late.stdout).toBe('')
    expect(late.code).toBe(75)
    expect(late.stderr.trim().split('\n')).toHaveLength(1)
    expect(late.stderr).toContain('no test slot within')
    // The one that gave up is out of the line, not a holder.
    expect(await held()).toBe(2)
    expect((await listSlots(db.sql)).filter((s) => s.slot === null)).toEqual([])
    a.kill()
    b.kill()
    await Promise.all([a.exited, b.exited])
  }, 30_000)

  test('FACTORY_SLOT_OPEN=1: with no slot within the wait it runs the command anyway', async () => {
    const a = slotRun(['--', 'sleep', '4'])
    const b = slotRun(['--', 'sleep', '4'])
    await until(async () => (await held()) === 2)
    const late = await finish(
      slotRun(['--', 'echo', 'anyway'], { FACTORY_SLOT_WAIT_MS: '600', FACTORY_SLOT_OPEN: '1' }),
    )
    expect(late.stdout).toBe('anyway\n')
    expect(late.code).toBe(0)
    expect(late.stderr.trim().split('\n')).toHaveLength(1)
    expect(late.stderr).toContain('running without one')
    a.kill()
    b.kill()
    await Promise.all([a.exited, b.exited])
  }, 30_000)

  test('a command is required', async () => {
    const out = await finish(slotRun([]))
    expect(out.code).toBe(2)
  })
})
