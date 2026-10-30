import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { recordReading } from '../src/capacity.ts'
import { DEFAULT_RETRY_BUDGET_MS } from '../src/config.ts'
import { HerdrRunner, RunnerError, type Runner, type StartInput } from '../src/runner.ts'
import { getSession } from '../src/sessions.ts'
import { createSpawn } from '../src/spawns.ts'
import { claimDue, DEFAULT_LEASE_MS, retryDelayMs, startTicker, tick } from '../src/tick.ts'
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
const herdrRunner = () =>
  new HerdrRunner({
    bin: herdr.bin,
    clock,
    pretrustBin: herdr.pretrustBin,
    accountsFile: herdr.accountsFile,
    home: '/home/me',
    deliverWaitMs: 3_000,
  })

/** A runner whose calls finish when told to. */
function gatedRunner() {
  const waiting = new Map<string, () => void>()
  const entered: string[] = []
  const runner: Runner = {
    async start(input) {
      entered.push(input.key)
      await new Promise<void>((resolve) => waiting.set(input.key, resolve))
      return { session: `pane-${input.key}` }
    },
  }
  const release = (key: string) => waiting.get(key)?.()
  const until = async (key: string) => {
    for (let i = 0; i < 200 && !entered.includes(key); i++) await Bun.sleep(10)
    expect(entered).toContain(key)
  }
  return { runner, release, until, entered }
}

describe('the session of a spawn', () => {
  const sessionState = async (key: string) => (await getSession(db.sql, key, clock.now()))?.state
  const sessionRows = (key: string) => db.sql`SELECT pane FROM factory.sessions WHERE id = ${key}`

  test('is `starting` from the claim on, and has its pane once the Runner returns it', async () => {
    await addSpawn('s1')
    let during: unknown
    const runner: Runner = {
      start: async () => {
        during = await sessionState('s1')
        return { session: 'w1:p1' }
      },
    }
    await tick(deps(runner))
    expect(during).toBe('starting')
    expect(await sessionRows('s1')).toEqual([{ pane: 'w1:p1' }])
    expect(await sessionState('s1')).toBe('starting')
  })

  test('a start that will be retried is still starting; one that failed for good never was a session', async () => {
    await addSpawn('retry')
    await addSpawn('bad')
    const runner: Runner = {
      start: (input) =>
        Promise.reject(input.key === 'bad' ? new RunnerError('refused', true) : new RunnerError('later', false)),
    }
    const quiet = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await tick(deps(runner))
    } finally {
      quiet.mockRestore()
    }
    expect(await sessionState('retry')).toBe('starting')
    expect(await sessionRows('bad')).toEqual([])
  })
})

describe('failures', () => {
  test('a permanent refusal marks the spawn failed and does not stop the others', async () => {
    await addSpawn('bad')
    await addSpawn('good')
    const real = herdrRunner()
    const runner: Runner = {
      start: (input) =>
        input.key === 'bad' ? Promise.reject(new RunnerError('herdr refused bad', true)) : real.start(input),
    }

    expect(await tick(deps(runner))).toMatchObject({ failed: ['bad'], started: ['good'], errors: [] })
    expect(await spawnRow('bad')).toMatchObject({ status: 'failed', attempts: 1 })
    expect(await spawnRow('good')).toMatchObject({ status: 'started', attempts: 1 })
    // A failed spawn is final: later ticks leave it alone.
    expect(await tick(deps(runner))).toMatchObject({ failed: [], started: [], skipped: 0 })
  })

  test('a failing start is retried with growing delays and stays retryable for the whole budget', async () => {
    await addSpawn('flaky')
    await herdr.plan(...Array<string>(40).fill('workspace list:exit1'))
    const runner = herdrRunner()
    const failed = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const first = clock.now()
      expect(await tick(deps(runner))).toMatchObject({ retrying: ['flaky'], failed: [] })
      const row = await spawnRow('flaky')
      expect(row).toMatchObject({ status: 'queued', attempts: 1, claimed_at: null })
      expect(row.error).toContain('exited 1')
      expect(row.resume_at?.getTime()).toBe(first.getTime() + retryDelayMs(1))

      // Not due yet.
      expect(await tick(deps(runner))).toMatchObject({ retrying: [], started: [], failed: [] })

      // Six failures and 17 minutes in: nowhere near the budget, so nothing fails.
      for (let n = 2; n <= 7; n++) {
        clock.advance(retryDelayMs(n - 1))
        expect(await tick(deps(runner))).toMatchObject({ retrying: ['flaky'], failed: [] })
        expect(await spawnRow('flaky')).toMatchObject({ status: 'queued', attempts: n })
      }
      expect(clock.now().getTime() - first.getTime()).toBeLessThan(DEFAULT_RETRY_BUDGET_MS)
      expect(failed).not.toHaveBeenCalled()

      // The budget runs out: the next claim fails the spawn without calling herdr, and says why.
      clock.advance(DEFAULT_RETRY_BUDGET_MS)
      const calls = (await herdr.calls()).length
      expect(await tick(deps(runner))).toMatchObject({ failed: ['flaky'], retrying: [] })
      expect((await herdr.calls()).length).toBe(calls)
      const done = await spawnRow('flaky')
      expect(done.status).toBe('failed')
      expect(done.error).toContain('30 min retry budget is spent after 7 attempts')
      expect(done.error).toContain('exited 1')
      expect(failed).toHaveBeenCalledWith('spawn failed', { key: 'flaky', reason: done.error })
    } finally {
      failed.mockRestore()
    }
  })

  test('herdr back after a few minutes: the spawn starts and nothing failed', async () => {
    await addSpawn('restart')
    await herdr.plan(...Array<string>(3).fill('workspace list:exit1'))
    const runner = herdrRunner()
    await tick(deps(runner))
    clock.advance(retryDelayMs(1))
    await tick(deps(runner))
    clock.advance(retryDelayMs(2))
    await tick(deps(runner))
    clock.advance(retryDelayMs(3))
    expect(await tick(deps(runner))).toMatchObject({ started: ['restart'] })
    expect(await spawnRow('restart')).toMatchObject({ status: 'started', attempts: 4, error: null })
  })

  test('an unexpected error is a failed attempt too: retried within the budget, then failed with its message', async () => {
    await addSpawn('boom')
    let calls = 0
    const runner: Runner = {
      async start() {
        calls++
        throw new Error('disk on fire')
      },
    }
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await tick(deps(runner))).toMatchObject({ retrying: ['boom'], errors: [] })
      expect(await tick(deps(runner))).toMatchObject({ retrying: [] })
      expect(calls).toBe(1)

      clock.advance(retryDelayMs(1))
      await tick(deps(runner))
      expect(calls).toBe(2)
      clock.advance(DEFAULT_RETRY_BUDGET_MS)
      expect(await tick(deps(runner))).toMatchObject({ failed: ['boom'] })
      expect((await spawnRow('boom')).error).toContain('disk on fire')
      expect(calls).toBe(2)
      clock.advance(24 * 3_600_000)
      await tick(deps(runner))
      expect(calls).toBe(2)
    } finally {
      logged.mockRestore()
    }
  })

  test('a start that fails on its last chance fails the spawn right then', async () => {
    await addSpawn('late')
    await db.sql`UPDATE factory.spawns SET first_claimed_at = ${new Date(clock.now().getTime() - DEFAULT_RETRY_BUDGET_MS + 1000)}, attempts = 5 WHERE key = 'late'`
    const runner: Runner = {
      async start() {
        clock.advance(2000)
        throw new Error('still down')
      },
    }
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await tick(deps(runner))).toMatchObject({ failed: ['late'] })
      expect((await spawnRow('late')).error).toContain('still down')
      expect(logged).toHaveBeenCalledWith('spawn failed', expect.objectContaining({ key: 'late' }))
    } finally {
      logged.mockRestore()
    }
  })

  test('waiting for capacity does not use the budget', async () => {
    await addSpawn('patient')
    await herdr.plan('workspace list:exit1')
    await tick(deps(herdrRunner()))
    expect((await spawnRow('patient')).status).toBe('queued')
    // every account is walled
    await db.sql`DELETE FROM factory.capacity_readings`
    await db.sql`UPDATE factory.spawns SET resume_at = NULL WHERE key = 'patient'`
    expect(await tick(deps(herdrRunner()))).toMatchObject({ skipped: 1 })
    expect((await db.sql`SELECT first_claimed_at FROM factory.spawns WHERE key = 'patient'`)[0]).toMatchObject({
      first_claimed_at: null,
    })
  })

  test('a spawn that keeps failing does not starve the one behind it when the batch is one', async () => {
    await addSpawn('bad')
    clock.advance(1000)
    await addSpawn('good')
    await herdr.plan('workspace list:exit1')
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
        return { session: 'pane-s1' }
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
  test('a crash after the Runner call and before the record: the replay finds the running agent and starts nothing twice', async () => {
    await addSpawn('s1')
    // The first tick dies between the Runner call and its record: claim, start the agent, record nothing.
    const { claims } = await claimDue(deps(herdrRunner()))
    expect(claims.map((c) => c.key)).toEqual(['s1'])
    const { session } = await herdrRunner().start({ key: 's1', repo: '/work/repo', prompt: 'do it', account: 'a' })
    expect(await spawnRow('s1')).toMatchObject({ status: 'starting', attempts: 1, session: null })

    // Inside the lease the claim is respected.
    const callsBefore = (await herdr.calls()).length
    expect(await tick(deps(herdrRunner()))).toMatchObject({ started: [], skipped: 0 })
    expect((await herdr.calls()).length).toBe(callsBefore)

    clock.advance(DEFAULT_LEASE_MS)
    expect(await tick(deps(herdrRunner()))).toMatchObject({ started: ['s1'], errors: [] })
    const state = await herdr.state()
    expect(state.tabs).toHaveLength(1)
    expect(state.agents).toHaveLength(1)
    expect(state.prompts).toHaveLength(1)
    expect(await spawnRow('s1')).toMatchObject({ status: 'started', attempts: 2, session })
  })

  test('claims that keep dying run into the retry budget and the spawn fails without calling herdr', async () => {
    await addSpawn('s1')
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      let result: Awaited<ReturnType<typeof claimDue>> = { claims: [], failed: [], skipped: 0 }
      for (let n = 1; n <= 20 && result.failed.length === 0; n++) {
        result = await claimDue(deps(herdrRunner()))
        if (result.failed.length === 0) {
          expect(result.claims).toHaveLength(1)
          expect(await spawnRow('s1')).toMatchObject({ status: 'starting', attempts: n })
          clock.advance(DEFAULT_LEASE_MS)
        }
      }
      expect(result).toMatchObject({ claims: [], failed: ['s1'] })
      const row = await spawnRow('s1')
      expect(row.status).toBe('failed')
      expect(row.error).toContain('30 min retry budget is spent')
      expect(await herdr.calls()).toEqual([])
    } finally {
      logged.mockRestore()
    }
  })

  test('a result that finds its row no longer starting changes nothing', async () => {
    await addSpawn('s1')
    const runner: Runner = {
      async start(input) {
        // The record's UPDATE will find nothing to do: the row is no longer `starting`.
        await db.sql`UPDATE factory.spawns SET status = 'failed' WHERE key = ${input.key}`
        return { session: 'pane-s1' }
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
    const state = await herdr.state()
    expect(state.tabs.map((t) => t.label).sort()).toEqual(keys)
    expect(state.workspaces).toHaveLength(1)
    expect(state.agents).toHaveLength(keys.length)
    expect(state.prompts).toHaveLength(keys.length)
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
        return { session: 'x' }
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
