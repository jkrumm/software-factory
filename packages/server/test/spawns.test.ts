import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { HerdrRunner } from '../src/runner.ts'
import { tick } from '../src/tick.ts'
import { startApp, TEST_REPO, type TestApp } from './support/app.ts'
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

const runTick = () =>
  tick({
    sql: db.sql,
    clock,
    runner: new HerdrRunner({
      bin: herdr.bin,
      clock,
      pretrustBin: herdr.pretrustBin,
      accountsFile: herdr.accountsFile,
      home: '/home/me',
      deliverWaitMs: 3_000,
    }),
  })
const tabs = async () => (await herdr.state()).tabs.map((t) => t.label)
const inHours = (h: number) => new Date(clock.now().getTime() + h * 3_600_000).toISOString()
const reading = (account: string, weeklyUsed: number, fiveHourUsed: number, resetsAt: string) =>
  app.send('PUT', `/quota/accounts/${account}`, {
    weeklyUsed,
    fiveHourUsed,
    fiveHourResetsAt: resetsAt,
    weeklyResetsAt: resetsAt,
  })
const spawn = (key: string) => app.send('POST', '/spawns', { key, repo: TEST_REPO, prompt: 'do it' })
const status = async (key: string) => (await app.get(`/spawns/${key}`)).json() as Promise<Record<string, unknown>>

describe('a spawn with capacity', () => {
  test('is stored for an account and starts on the next tick', async () => {
    await reading('a', 10, 10, inHours(2))
    const res = await spawn('s1')
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ key: 's1', status: 'queued', account: 'a', resumeAt: null, attempts: 0 })
    expect(await tabs()).toEqual([])

    expect(await runTick()).toMatchObject({ started: ['s1'], failed: [], errors: [] })
    expect(await status('s1')).toMatchObject({
      status: 'started',
      account: 'a',
      attempts: 1,
      session: expect.stringMatching(/:p\d+$/),
    })
    expect(await tabs()).toEqual(['s1'])

    // Nothing left to do.
    const calls = (await herdr.calls()).length
    expect(await runTick()).toMatchObject({ started: [] })
    expect((await herdr.calls()).length).toBe(calls)
  })

  test('takes the least-used eligible account', async () => {
    await reading('busy', 80, 10, inHours(2))
    await reading('quiet', 20, 10, inHours(2))
    expect(await (await spawn('s1')).json()).toMatchObject({ account: 'quiet' })
  })

  test('a replay of a key answers with its row even when the role has left the table', async () => {
    await reading('a', 10, 10, inHours(2))
    await spawn('s1')
    const again = await app.send('POST', '/spawns', { key: 's1', repo: TEST_REPO, prompt: 'do it', role: 'retired' })
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ key: 's1', role: 'worker' })
  })

  test('a repeated key returns the existing row', async () => {
    await reading('a', 10, 10, inHours(2))
    await spawn('s1')
    await runTick()
    const again = await spawn('s1')
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ key: 's1', status: 'started', session: expect.stringMatching(/:p\d+$/) })
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
    const resetB = inHours(2)
    await reading('a', 96, 0, resetA)
    await reading('b', 10, 90, resetB)
    await spawn('s1')

    clock.advance(2 * 3_600_000 - 1)
    expect(await runTick()).toMatchObject({ started: [], skipped: 0 })

    clock.advance(1)
    // The poller has renewed both readings meanwhile; the numbers are the old ones.
    await reading('a', 96, 0, resetA)
    await reading('b', 10, 90, resetB)
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

describe('an account takes one spawn per sample', () => {
  // finding 10: ten spawns, a at 94 %, b at 95 %
  test('spawns beyond what the readings leave room for wait instead of piling onto one account', async () => {
    await reading('a', 94, 10, inHours(2))
    await reading('b', 95, 10, inHours(2))
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => spawn(`s${i}`).then((r) => r.json())))
    const queued = results.filter((r) => (r as { status: string }).status === 'queued')
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ account: 'a' })

    expect(await runTick()).toMatchObject({ started: [queued[0] && (queued[0] as { key: string }).key] })
    expect((await herdr.state()).agents).toHaveLength(1)
  })

  test('a queued spawn holds its account against any sample; a started one until a sample taken after its start', async () => {
    await reading('a', 10, 10, inHours(2))
    expect(await (await spawn('first')).json()).toMatchObject({ status: 'queued', account: 'a' })
    expect(await (await spawn('second')).json()).toMatchObject({ status: 'waiting', account: null })

    // No agent runs for the queued spawn yet, so a newer sample cannot show it.
    clock.advance(60_000)
    await reading('a', 10, 10, inHours(2))
    expect(await (await spawn('third')).json()).toMatchObject({ status: 'waiting' })

    // It starts. A sample whose picker data is older than the start does not show it.
    expect(await runTick()).toMatchObject({ started: ['first'] })
    clock.advance(60_000)
    await app.send('PUT', '/quota/accounts/a', {
      weeklyUsed: 10,
      fiveHourUsed: 10,
      fiveHourResetsAt: inHours(2),
      weeklyResetsAt: inHours(2),
      ageS: 120,
    })
    expect(await (await spawn('fourth')).json()).toMatchObject({ status: 'waiting' })

    // One taken after the start does: its numbers include what the first spawn used.
    await reading('a', 14, 12, inHours(2))
    expect(await (await spawn('fifth')).json()).toMatchObject({ status: 'queued', account: 'a' })
  })

  test('equally free accounts take one spawn each, the rest wait', async () => {
    await reading('a', 10, 10, inHours(2))
    await reading('b', 10, 10, inHours(2))
    const results: { status: string; account: string | null }[] = []
    for (let i = 0; i < 4; i++) results.push((await (await spawn(`s${i}`)).json()) as (typeof results)[number])
    expect(results.map((r) => [r.status, r.account])).toEqual([
      ['queued', 'a'],
      ['queued', 'b'],
      ['waiting', null],
      ['waiting', null],
    ])
  })

  test('a new sample wakes the waiting spawns that now have an account, and only those', async () => {
    await reading('a', 10, 10, inHours(2))
    await spawn('first')
    await spawn('second')
    await runTick()
    clock.advance(60_000)
    // Still taken: nothing is woken, so the waiting spawn keeps its resume_at.
    await app.send('PUT', '/quota/accounts/a', {
      weeklyUsed: 10,
      fiveHourUsed: 10,
      fiveHourResetsAt: inHours(2),
      weeklyResetsAt: inHours(2),
      ageS: 300,
    })
    expect(await status('second')).toMatchObject({ status: 'waiting', resumeAt: null })
    await reading('a', 12, 11, inHours(2))
    expect(await runTick()).toMatchObject({ started: ['second'] })
  })
})

describe('a spawn started again counts against its account again', () => {
  test('a requeued spawn is assigned when it is claimed, not when it first was', async () => {
    await reading('a', 10, 10, inHours(2))
    await spawn('s1')
    await db.sql`UPDATE factory.spawns SET status = 'failed', attempts = 4, error = 'gave up' WHERE key = 's1'`

    // A sample is taken after s1's first assignment; s1 is requeued and claimed after it.
    clock.advance(60_000)
    await reading('a', 10, 10, inHours(2))
    await app.send('POST', '/spawns/s1/requeue', {})
    expect(await runTick()).toMatchObject({ started: ['s1'] })

    // The sample does not show s1 yet, so the account takes no second spawn.
    expect(await (await spawn('s2')).json()).toMatchObject({ status: 'waiting', account: null })
  })

  test('a start that failed and is retried is assigned again too', async () => {
    await reading('a', 10, 10, inHours(2))
    await spawn('s1')
    await db.sql`UPDATE factory.spawns SET status = 'queued', attempts = 1, resume_at = ${clock.now()} WHERE key = 's1'`
    clock.advance(60_000)
    await reading('a', 10, 10, inHours(2))
    expect(await runTick()).toMatchObject({ started: ['s1'] })
    expect(await (await spawn('s2')).json()).toMatchObject({ status: 'waiting' })
  })
})

describe('validation', () => {
  test('bad spawn and quota bodies are 400', async () => {
    expect((await app.send('POST', '/spawns', { key: 'x' })).status).toBe(400)
    expect((await app.send('PUT', '/quota/accounts/a', { weeklyUsed: 'lots' })).status).toBe(400)
    expect((await app.get('/spawns/unknown')).status).toBe(404)
  })

  // finding 8: any string used to become an account that pickEligible could choose
  test.each(['%20', 'a%20b', '-lead', 'x'.repeat(65), 'caf%C3%A9', '%E0%A4%A'])(
    'account name %p is a 400',
    async (name) => {
      const res = await app.send('PUT', `/quota/accounts/${name}`, { weeklyUsed: 1, fiveHourUsed: 1 })
      expect(res.status).toBe(400)
      const [{ count }] = await db.sql`SELECT count(*)::int AS count FROM factory.quota_readings`
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
    await reading('b', 1, 1, inHours(1))
    await spawn('first')
    clock.advance(1000)
    await spawn('second')
    const body = (await (await app.get('/spawns')).json()) as { spawns: { key: string; error: null }[] }
    expect(body.spawns.map((s) => s.key)).toEqual(['second', 'first'])
    expect(body.spawns[0]).toMatchObject({ status: 'queued', error: null })
  })
})

describe('requeue', () => {
  const fail = (key: string) =>
    db.sql`UPDATE factory.spawns SET status = 'failed', attempts = 4, error = 'gave up', first_claimed_at = ${clock.now()} WHERE key = ${key}`
  const requeue = (key: string) => app.send('POST', `/spawns/${key}/requeue`, {})

  test('puts a failed spawn back in the queue with a fresh budget, and the next tick starts it', async () => {
    await reading('a', 10, 10, inHours(2))
    await spawn('s1')
    await fail('s1')

    const res = await requeue('s1')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ key: 's1', status: 'queued', attempts: 0, error: null, resumeAt: null })
    const [row] = await db.sql`SELECT first_claimed_at, claimed_at FROM factory.spawns WHERE key = 's1'`
    expect(row).toEqual({ first_claimed_at: null, claimed_at: null })

    expect(await runTick()).toMatchObject({ started: ['s1'] })
  })

  test('a spawn that is not failed is a conflict and stays as it is', async () => {
    await reading('a', 10, 10, inHours(2))
    await spawn('s1')
    const res = await requeue('s1')
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'spawn is queued; only a failed spawn can be re-queued' })
    expect(await status('s1')).toMatchObject({ status: 'queued' })
  })

  test('an unknown key is a 404', async () => {
    expect((await requeue('nope')).status).toBe(404)
  })

  test('it needs the token', async () => {
    const res = await app.bare('/spawns/s1/requeue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(401)
  })
})

describe('the prompt', () => {
  test("cannot start with '-': herdr would read it as an option", async () => {
    const res = await app.send('POST', '/spawns', { key: 'dash', repo: TEST_REPO, prompt: '-rf everything' })
    expect(res.status).toBe(400)
    expect(
      await app.send('POST', '/spawns', { key: 'dash', repo: TEST_REPO, prompt: 'a - b' }).then((r) => r.status),
    ).not.toBe(400)
  })
})
