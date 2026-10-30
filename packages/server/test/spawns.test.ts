import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { HerdrRunner } from '../src/runner.ts'
import { tick } from '../src/tick.ts'
import { startApp, type TestApp } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { createFakeHerdr, type FakeHerdr } from './support/herdr.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

let db: TestDb
let herdr: FakeHerdr
let app: TestApp
const clock = new FakeClock()

beforeAll(async () => {
  db = await startTestDb()
  herdr = await createFakeHerdr()
  app = startApp({ sql: db.sql, clock })
})
afterAll(async () => {
  await app.stop()
  await herdr.cleanup()
  await db.stop()
})
beforeEach(async () => {
  await db.reset()
  await herdr.reset()
})

const runTick = () => tick({ sql: db.sql, clock, runner: new HerdrRunner({ bin: herdr.bin, clock }) })
const inHours = (h: number) => new Date(clock.now().getTime() + h * 3_600_000).toISOString()
const reading = (account: string, weeklyUsed: number, fiveHourUsed: number, resetsAt: string) =>
  app.send('PUT', `/capacity/${account}`, { weeklyUsed, fiveHourUsed, resetsAt })
const spawn = (key: string) => app.send('POST', '/spawns', { key, repo: '/work/repo', prompt: 'do it' })
const status = async (key: string) => (await app.get(`/spawns/${key}`)).json() as Promise<Record<string, unknown>>

describe('a spawn with capacity', () => {
  test('is stored for an account and starts on the next tick', async () => {
    await reading('a', 10, 10, inHours(2))
    const res = await spawn('s1')
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ key: 's1', status: 'queued', account: 'a', resumeAt: null, attempts: 0 })
    expect(await herdr.panes()).toEqual([])

    expect(await runTick()).toMatchObject({ started: ['s1'], failed: [], errors: [] })
    expect(await status('s1')).toMatchObject({ status: 'started', account: 'a', attempts: 1, session: 'pane-s1' })
    expect(await herdr.panes()).toEqual(['s1'])

    // Nothing left to do.
    expect(await runTick()).toMatchObject({ started: [] })
    expect(await herdr.calls()).toEqual(['s1'])
  })

  test('takes the least-used eligible account', async () => {
    await reading('busy', 80, 10, inHours(2))
    await reading('quiet', 20, 10, inHours(2))
    expect(await (await spawn('s1')).json()).toMatchObject({ account: 'quiet' })
  })

  test('a repeated key returns the existing row', async () => {
    await reading('a', 10, 10, inHours(2))
    await spawn('s1')
    await runTick()
    const again = await spawn('s1')
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ key: 's1', status: 'started', session: 'pane-s1' })
  })
})

describe('eligibility', () => {
  test.each([
    ['weekly 94', 94, 0, true],
    ['weekly 95', 95, 0, false],
    ['five-hour 84', 0, 84, true],
    ['five-hour 85', 0, 85, false],
  ])('%s', async (_name, weekly, fiveHour, eligible) => {
    await reading('a', weekly, fiveHour, inHours(1))
    expect(await (await spawn('s')).json()).toMatchObject({ status: eligible ? 'queued' : 'waiting' })
  })

  test('only the latest reading of an account counts', async () => {
    await reading('a', 99, 0, inHours(1))
    await reading('a', 10, 0, inHours(1))
    expect(await (await spawn('s')).json()).toMatchObject({ status: 'queued', account: 'a' })
  })
})

describe('a spawn without capacity', () => {
  test('waits with resume_at at the earliest reset, then starts after a new reading', async () => {
    await reading('a', 96, 0, inHours(5))
    await reading('b', 10, 90, inHours(2))
    const res = await spawn('s1')
    expect(await res.json()).toMatchObject({ status: 'waiting', account: null, resumeAt: inHours(2) })

    // Not due yet: the tick does not even look at it.
    expect(await runTick()).toMatchObject({ started: [], skipped: 0 })
    expect(await herdr.calls()).toEqual([])

    // A new reading wakes it before resume_at.
    await reading('b', 10, 20, inHours(2))
    expect(await runTick()).toMatchObject({ started: ['s1'] })
    expect(await status('s1')).toMatchObject({ status: 'started', account: 'b', attempts: 1 })
  })

  // finding 2: resume_at passing is not capacity
  test('when resume_at passes with the readings still over the limit it keeps waiting, then starts on a fresh reading', async () => {
    const resetA = inHours(5)
    await reading('a', 96, 0, resetA)
    await reading('b', 10, 90, inHours(2))
    await spawn('s1')

    clock.advance(2 * 3_600_000 - 1)
    expect(await runTick()).toMatchObject({ started: [], skipped: 0 })

    clock.advance(1)
    expect(await runTick()).toMatchObject({ started: [], skipped: 1 })
    expect(await herdr.calls()).toEqual([])
    // Back to waiting, due at the next reset still ahead.
    expect(await status('s1')).toMatchObject({ status: 'waiting', account: null, resumeAt: resetA })

    await reading('b', 10, 20, inHours(7))
    expect(await runTick()).toMatchObject({ started: ['s1'] })
    expect(await status('s1')).toMatchObject({ status: 'started', account: 'b' })
  })

  test('a reading whose reset is already past gives no resume_at and never starts the spawn', async () => {
    await reading('a', 99, 0, inHours(-1))
    expect(await (await spawn('s1')).json()).toMatchObject({ status: 'waiting', account: null, resumeAt: null })

    clock.advance(24 * 3_600_000)
    expect(await runTick()).toMatchObject({ started: [], skipped: 0 })
    expect(await herdr.calls()).toEqual([])
    expect(await status('s1')).toMatchObject({ status: 'waiting' })
  })

  test('with no reading at all it waits with no resume_at until one arrives', async () => {
    expect(await (await spawn('s1')).json()).toMatchObject({ status: 'waiting', account: null, resumeAt: null })
    expect(await runTick()).toMatchObject({ started: [] })
    await reading('a', 1, 1, inHours(1))
    expect(await runTick()).toMatchObject({ started: ['s1'] })
  })
})

describe('capacity is checked again when the spawn starts', () => {
  // finding 2 and 10: a stored account is only a hint
  test('a queued spawn whose account has since run out waits instead of starting', async () => {
    await reading('a', 10, 10, inHours(2))
    expect(await (await spawn('s1')).json()).toMatchObject({ status: 'queued', account: 'a' })

    await reading('a', 99, 10, inHours(2))
    expect(await runTick()).toMatchObject({ started: [], skipped: 1 })
    expect(await herdr.calls()).toEqual([])
    expect(await status('s1')).toMatchObject({ status: 'waiting', account: null, resumeAt: inHours(2) })
  })

  test('a queued spawn moves to another eligible account', async () => {
    await reading('a', 10, 10, inHours(2))
    await spawn('s1')
    await reading('a', 99, 10, inHours(2))
    await reading('b', 50, 10, inHours(2))
    expect(await runTick()).toMatchObject({ started: ['s1'] })
    expect(await status('s1')).toMatchObject({ status: 'started', account: 'b' })
  })
})

describe('assignments count against the account', () => {
  // finding 10: ten spawns, a at 94 %, b at 95 %
  test('spawns beyond what the reading leaves room for wait instead of piling onto one account', async () => {
    await reading('a', 94, 10, inHours(2))
    await reading('b', 95, 10, inHours(2))
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => spawn(`s${i}`).then((r) => r.json())))
    const queued = results.filter((r) => (r as { status: string }).status === 'queued')
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ account: 'a' })

    expect(await runTick()).toMatchObject({ started: [queued[0] && (queued[0] as { key: string }).key] })
    expect(await herdr.calls()).toHaveLength(1)

    // The next reading shows the real use; assignments made before it no longer count.
    await reading('a', 94, 10, inHours(2))
    expect(await (await spawn('late')).json()).toMatchObject({ status: 'queued', account: 'a' })
  })

  test('spawns spread over accounts that are equally free', async () => {
    await reading('a', 10, 10, inHours(2))
    await reading('b', 10, 10, inHours(2))
    const accounts: string[] = []
    for (let i = 0; i < 6; i++) accounts.push(((await (await spawn(`s${i}`)).json()) as { account: string }).account)
    expect(accounts.filter((a) => a === 'a')).toHaveLength(3)
    expect(accounts.filter((a) => a === 'b')).toHaveLength(3)
  })

  test('the five-hour window limits how many spawns one reading can take', async () => {
    await reading('a', 0, 70, inHours(2))
    const statuses: string[] = []
    for (let i = 0; i < 5; i++) statuses.push(((await (await spawn(`s${i}`)).json()) as { status: string }).status)
    // 70 + 5 per spawn stays under 85 for three spawns.
    expect(statuses).toEqual(['queued', 'queued', 'queued', 'waiting', 'waiting'])
  })
})

describe('validation', () => {
  test('bad spawn and capacity bodies are 400', async () => {
    expect((await app.send('POST', '/spawns', { key: 'x' })).status).toBe(400)
    expect((await app.send('PUT', '/capacity/a', { weeklyUsed: 'lots' })).status).toBe(400)
    expect((await app.get('/spawns/unknown')).status).toBe(404)
  })

  // finding 8: any string used to become an account that pickEligible could choose
  test.each(['%20', 'a%20b', '-lead', 'x'.repeat(65), 'caf%C3%A9', '%E0%A4%A'])(
    'account name %p is a 400',
    async (name) => {
      const res = await app.send('PUT', `/capacity/${name}`, { weeklyUsed: 1, fiveHourUsed: 1, resetsAt: inHours(1) })
      expect(res.status).toBe(400)
      const [{ count }] = await db.sql`SELECT count(*)::int AS count FROM factory.capacity_readings`
      expect(count).toBe(0)
    },
  )

  test('a spawn without a prompt or with an oversized key is a 400', async () => {
    expect((await app.send('POST', '/spawns', { key: 'k', repo: '/r', prompt: '' })).status).toBe(400)
    expect((await app.send('POST', '/spawns', { key: 'k'.repeat(300), repo: '/r', prompt: 'p' })).status).toBe(400)
  })
})

describe('spawn keys and repos become command-line arguments', () => {
  test.each([
    ['a key that reads as a flag', { key: '--help', repo: '/r', prompt: 'p' }],
    ['a key with a space', { key: 'a b', repo: '/r', prompt: 'p' }],
    ['a relative repo', { key: 'k', repo: 'work/repo', prompt: 'p' }],
    ['a repo that reads as a flag', { key: 'k', repo: '--cwd', prompt: 'p' }],
  ])('%s is a 400', async (_name, body) => {
    expect((await app.send('POST', '/spawns', body)).status).toBe(400)
  })
})

describe('a new reading and a new spawn do not race', () => {
  test('a spawn created while readings arrive is never left without a wake-up', async () => {
    for (let i = 0; i < 20; i++) {
      await db.reset()
      const key = `r${i}`
      await Promise.all([spawn(key), reading('a', 1, 1, inHours(2))])
      const row = await status(key)
      // Either the reading came first (queued on it) or the spawn waited and the reading woke it: never stuck.
      if (row.status === 'waiting') expect(row.resumeAt).not.toBeNull()
      else expect(row.status).toBe('queued')
    }
  })
})

describe('GET /spawns', () => {
  test('lists the newest first with their status and error', async () => {
    await reading('a', 1, 1, inHours(1))
    await spawn('first')
    clock.advance(1000)
    await spawn('second')
    const body = (await (await app.get('/spawns')).json()) as { spawns: { key: string; error: null }[] }
    expect(body.spawns.map((s) => s.key)).toEqual(['second', 'first'])
    expect(body.spawns[0]).toMatchObject({ status: 'queued', error: null })
  })
})
