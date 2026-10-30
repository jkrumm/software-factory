import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { recordReading } from '../src/capacity.ts'
import { HerdrRunner, RunnerError, type Runner, type StartInput } from '../src/runner.ts'
import { createSpawn } from '../src/spawns.ts'
import { claimDue, DEFAULT_LEASE_MS, MAX_ATTEMPTS, RETRY_DELAY, startTicker, tick } from '../src/tick.ts'
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
  await recordReading(
    db.sql,
    'a',
    { weeklyUsed: 1, fiveHourUsed: 1, resetsAt: new Date(clock.now().getTime() + 3_600_000) },
    clock.now(),
  )
})

const addSpawn = (key: string) => createSpawn(db.sql, { key, repo: '/work/repo', prompt: 'do it' }, clock.now())
const spawnRow = async (key: string) => {
  const [row] = await db.sql`
    SELECT status, attempts, session, error, resume_at, claimed_at FROM factory.spawns WHERE key = ${key}`
  return row as {
    status: string
    attempts: number
    session: string | null
    error: string | null
    resume_at: Date | null
    claimed_at: Date | null
  }
}
const deps = (runner: Runner, extra: { batch?: number } = {}) => ({ sql: db.sql, runner, clock, ...extra })
const herdrRunner = () => new HerdrRunner({ bin: herdr.bin, clock })

/** A runner whose calls finish when told to. */
function gatedRunner() {
  const waiting = new Map<string, () => void>()
  const entered: string[] = []
  const runner: Runner = {
    async start(input) {
      entered.push(input.key)
      await new Promise<void>((resolve) => waiting.set(input.key, resolve))
      return { session: `pane-${input.key}`, attempts: 1 }
    },
  }
  const release = (key: string) => waiting.get(key)?.()
  const until = async (key: string) => {
    for (let i = 0; i < 200 && !entered.includes(key); i++) await Bun.sleep(10)
    expect(entered).toContain(key)
  }
  return { runner, release, until, entered }
}

describe('failures', () => {
  test('a permanent refusal marks the spawn failed and does not stop the others', async () => {
    await addSpawn('bad')
    await addSpawn('good')
    const real = herdrRunner()
    const runner: Runner = {
      start: (input) =>
        input.key === 'bad' ? Promise.reject(new RunnerError('herdr refused bad', true, 1)) : real.start(input),
    }

    expect(await tick(deps(runner))).toMatchObject({ failed: ['bad'], started: ['good'], errors: [] })
    expect(await spawnRow('bad')).toMatchObject({ status: 'failed', attempts: 1 })
    expect(await spawnRow('good')).toMatchObject({ status: 'started', attempts: 1 })
    // A failed spawn is final: later ticks leave it alone.
    expect(await tick(deps(runner))).toMatchObject({ failed: [], started: [], skipped: 0 })
  })

  test('retries exhausted in the runner put the spawn back with a delay, then fail it at the attempt cap', async () => {
    await addSpawn('flaky')
    await herdr.plan(...Array<number>(6 * MAX_ATTEMPTS).fill(1))
    const runner = herdrRunner()

    expect(await tick(deps(runner))).toMatchObject({ retrying: ['flaky'], failed: [] })
    expect(clock.sleeps).toEqual([500, 1000, 2000, 4000, 8000])
    const first = await spawnRow('flaky')
    expect(first).toMatchObject({ status: 'queued', attempts: 1, claimed_at: null })
    expect(first.error).toContain('exit 1')
    // The delay after the runner's own sleeps (which moved the fake clock by 15.5 s).
    expect(first.resume_at?.getTime()).toBe(clock.now().getTime() + RETRY_DELAY.baseMs)

    // Not due yet.
    expect(await tick(deps(runner))).toMatchObject({ retrying: [], started: [], failed: [] })

    clock.advance(RETRY_DELAY.baseMs)
    expect(await tick(deps(runner))).toMatchObject({ retrying: ['flaky'] })
    expect(await spawnRow('flaky')).toMatchObject({ status: 'queued', attempts: 2 })

    clock.advance(2 * RETRY_DELAY.baseMs)
    expect(await tick(deps(runner))).toMatchObject({ failed: ['flaky'], retrying: [] })
    expect(await spawnRow('flaky')).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS })
    expect(await herdr.calls()).toHaveLength(6 * MAX_ATTEMPTS)
  })

  // finding 3: a non-RunnerError used to leave the spawn pending and retried every tick, forever
  test('an unexpected error is a failed attempt too: delayed, capped, then failed with its message', async () => {
    await addSpawn('boom')
    let calls = 0
    const runner: Runner = {
      async start() {
        calls++
        throw new Error('disk on fire')
      },
    }

    expect(await tick(deps(runner))).toMatchObject({ retrying: ['boom'], errors: [] })
    expect(await tick(deps(runner))).toMatchObject({ retrying: [] })
    expect(calls).toBe(1)

    clock.advance(RETRY_DELAY.baseMs)
    await tick(deps(runner))
    clock.advance(2 * RETRY_DELAY.baseMs)
    expect(await tick(deps(runner))).toMatchObject({ failed: ['boom'] })
    expect(await spawnRow('boom')).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, error: 'disk on fire' })
    expect(calls).toBe(MAX_ATTEMPTS)
    clock.advance(24 * 3_600_000)
    await tick(deps(runner))
    expect(calls).toBe(MAX_ATTEMPTS)
  })

  test('a spawn that keeps failing does not starve the one behind it when the batch is one', async () => {
    await addSpawn('bad')
    clock.advance(1000)
    await addSpawn('good')
    await herdr.plan(...Array<number>(6).fill(1))
    const runner = herdrRunner()

    expect(await tick(deps(runner, { batch: 1 }))).toMatchObject({ retrying: ['bad'], started: [] })
    // 'bad' now sleeps until its retry time; the next pass reaches 'good'.
    expect(await tick(deps(runner, { batch: 1 }))).toMatchObject({ started: ['good'] })
  })

  test('waiting spawns sort after queued ones', async () => {
    await db.sql`
      INSERT INTO factory.spawns (key, repo, prompt, status, resume_at, created_at)
      VALUES ('old-waiting', '/r', 'p', 'waiting', ${clock.now()}, ${new Date(clock.now().getTime() - 1000)})`
    await addSpawn('queued')
    const { claims } = await claimDue({ ...deps(herdrRunner()), batch: 1 })
    expect(claims.map((c) => c.key)).toEqual(['queued'])
  })
})

describe('the Runner is never called inside a transaction (finding 1)', () => {
  test('the claim is committed and unlocked while the Runner runs', async () => {
    await addSpawn('s1')
    let seen: unknown
    const runner: Runner = {
      async start(input) {
        // NOWAIT fails at once if a transaction still holds the row; this is another connection.
        const [row] = await db.sql`
          SELECT status, attempts, account FROM factory.spawns WHERE key = ${input.key} FOR UPDATE NOWAIT`
        seen = row
        return { session: 'pane-s1', attempts: 1 }
      },
    }
    expect(await tick(deps(runner))).toMatchObject({ started: ['s1'], errors: [] })
    expect(seen).toMatchObject({ status: 'starting', attempts: 1, account: 'a' })
  })

  test('a Runner that has not returned does not hold up the other spawns or the pool', async () => {
    await addSpawn('slow')
    await addSpawn('fast')
    const { runner, release, until } = gatedRunner()

    const pass = tick(deps(runner))
    await until('slow')
    await until('fast')
    release('fast')
    for (let i = 0; i < 200 && (await spawnRow('fast')).status !== 'started'; i++) await Bun.sleep(10)
    expect(await spawnRow('fast')).toMatchObject({ status: 'started', session: 'pane-fast' })
    expect(await spawnRow('slow')).toMatchObject({ status: 'starting' })

    release('slow')
    expect(await pass).toMatchObject({ started: expect.arrayContaining(['slow', 'fast']) })
  })
})

describe('replay and crashes (finding 3)', () => {
  test('a crash after the Runner call and before the record: the replay stores the real pane and counts both attempts', async () => {
    await addSpawn('s1')
    // The first tick dies between the Runner call and its record: claim, start the pane, record nothing.
    const { claims } = await claimDue(deps(herdrRunner()))
    expect(claims.map((c) => c.key)).toEqual(['s1'])
    await herdrRunner().start({ key: 's1', repo: '/work/repo', prompt: 'do it' })
    expect(await herdr.panes()).toEqual(['s1'])
    expect(await spawnRow('s1')).toMatchObject({ status: 'starting', attempts: 1, session: null })

    // Inside the lease the claim is respected.
    expect(await tick(deps(herdrRunner()))).toMatchObject({ started: [], skipped: 0 })
    expect(await herdr.calls()).toEqual(['s1'])

    clock.advance(DEFAULT_LEASE_MS)
    expect(await tick(deps(herdrRunner()))).toMatchObject({ started: ['s1'], errors: [] })
    expect(await herdr.panes()).toEqual(['s1'])
    expect(await herdr.calls()).toEqual(['s1', 's1'])
    // The second call found the name (exit 3) and its output names the pane.
    expect(await spawnRow('s1')).toMatchObject({ status: 'started', attempts: 2, session: 'pane-s1' })
  })

  test('claims that keep dying stop at the attempt cap and the spawn fails', async () => {
    await addSpawn('s1')
    for (let n = 1; n <= MAX_ATTEMPTS; n++) {
      const { claims } = await claimDue(deps(herdrRunner()))
      expect(claims).toHaveLength(1)
      expect(await spawnRow('s1')).toMatchObject({ status: 'starting', attempts: n })
      clock.advance(DEFAULT_LEASE_MS)
    }
    expect(await claimDue(deps(herdrRunner()))).toMatchObject({ claims: [], failed: ['s1'] })
    expect(await spawnRow('s1')).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS })
    expect((await spawnRow('s1')).error).toContain('gave up after 3 attempts')
    expect(await herdr.calls()).toEqual([])
  })

  test('a result that finds its row no longer starting changes nothing', async () => {
    await addSpawn('s1')
    const runner: Runner = {
      async start(input) {
        // The record's UPDATE will find nothing to do: the row is no longer `starting`.
        await db.sql`UPDATE factory.spawns SET status = 'failed' WHERE key = ${input.key}`
        return { session: 'pane-s1', attempts: 1 }
      },
    }
    expect(await tick(deps(runner))).toMatchObject({ started: [], errors: [expect.stringContaining('claim was lost')] })
    expect(await spawnRow('s1')).toMatchObject({ status: 'failed', session: null })
  })
})

describe('reclaiming a claim', () => {
  test('keeps its account when that account has no reading any more', async () => {
    await addSpawn('s1')
    await claimDue(deps(herdrRunner()))
    await db.sql`DELETE FROM factory.capacity_readings`
    clock.advance(DEFAULT_LEASE_MS)
    const { claims, skipped } = await claimDue(deps(herdrRunner()))
    expect(skipped).toBe(0)
    expect(claims).toMatchObject([{ key: 's1', account: 'a', attempts: 2 }])
  })
})

describe('concurrent ticks', () => {
  test('two ticks at once start a due spawn exactly once', async () => {
    await addSpawn('s1')
    const starts: string[] = []
    const { runner: gated, release, until } = gatedRunner()
    const runner: Runner = {
      start(input) {
        starts.push(input.key)
        return gated.start(input)
      },
    }

    // Tick A claims the row and is held inside the Runner; tick B finds nothing due.
    const a = tick(deps(runner))
    await until('s1')
    expect(await tick(deps(runner))).toMatchObject({ started: [], skipped: 0, errors: [] })

    release('s1')
    expect(await a).toMatchObject({ started: ['s1'], errors: [] })
    expect(starts).toEqual(['s1'])
    expect(await spawnRow('s1')).toMatchObject({ status: 'started', attempts: 1, session: 'pane-s1' })
  })

  test('two ticks racing over several spawns start each exactly once', async () => {
    const keys = Array.from({ length: 6 }, (_, i) => `s${i}`)
    for (const key of keys) await addSpawn(key)
    const runner = herdrRunner()

    const [a, b] = await Promise.all([tick(deps(runner)), tick(deps(runner))])
    expect([...a.started, ...b.started].sort()).toEqual(keys)
    expect((await herdr.calls()).sort()).toEqual(keys)
    expect((await herdr.panes()).sort()).toEqual(keys)
  })
})

describe('the ticker', () => {
  // finding 5: stop() used to return at once and the process exited under a start in flight
  test('stop waits for the tick in flight, so its result is recorded before the pool closes', async () => {
    await addSpawn('s1')
    const { runner, release, until } = gatedRunner()
    const ticker = startTicker(deps(runner), 60_000)
    await until('s1')

    let stopped = false
    const stopping = ticker.stop().then(() => {
      stopped = true
    })
    await Bun.sleep(50)
    expect(stopped).toBe(false)

    release('s1')
    await stopping
    expect(await spawnRow('s1')).toMatchObject({ status: 'started', session: 'pane-s1' })
  })

  test('after stop no new pass starts', async () => {
    const calls: StartInput[] = []
    const runner: Runner = {
      async start(input) {
        calls.push(input)
        return { session: 'x', attempts: 1 }
      },
    }
    const ticker = startTicker(deps(runner), 10)
    await ticker.stop()
    await addSpawn('late')
    await Bun.sleep(60)
    expect(calls).toEqual([])
  })

  test('a pass that throws is logged and the ticker keeps going', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const broken = { sql: undefined, runner: herdrRunner(), clock } as unknown as Parameters<typeof startTicker>[0]
      const ticker = startTicker(broken, 10)
      await Bun.sleep(60)
      await ticker.stop()
      expect(logged.mock.calls.length).toBeGreaterThan(1)
    } finally {
      logged.mockRestore()
    }
  })
})
