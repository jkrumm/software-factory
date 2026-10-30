import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { QueueView } from '@software-factory/contract'
import { HOLD_RECHECK_MS } from '../src/admission.ts'
import { WEEK_MS } from '../src/capacity.ts'
import { HerdrRunner } from '../src/runner.ts'
import { tick } from '../src/tick.ts'
import { startApp, TEST_REPO, TEST_ROOT, type TestApp } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { createFakeHerdr, type FakeHerdr } from './support/herdr.ts'
import { startTestDb, type TestDb } from './support/pg.ts'
import { usage } from './support/quota.ts'

const ACCOUNTS = ['a', 'b', 'c', 'd', 'e', 'f']
const OTHER_REPO = join(TEST_ROOT, 'other')
mkdirSync(OTHER_REPO, { recursive: true })

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
  // Six accounts with room: the one-spawn-per-account-and-sample rule is not what these tests are about.
  for (const account of ACCOUNTS) await reading(account, 10, 10)
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
const inMs = (ms: number) => new Date(clock.now().getTime() + ms)
const reading = (account: string, weekly: number, fiveHour: number, extra: Parameters<typeof usage>[3] = {}) =>
  app.send('PUT', `/quota/accounts/${account}`, usage(weekly, fiveHour, inMs(1_000 * 3_600_000), extra))
const spawn = (key: string, extra: { role?: string; repo?: string } = {}) =>
  app.send('POST', '/spawns', { key, repo: TEST_REPO, prompt: 'do it', ...extra })
const row = async (key: string) => (await (await app.get(`/spawns/${key}`)).json()) as Record<string, unknown>
const setQueue = (state: string, project?: string) =>
  app.send('PUT', '/queue', { state, ...(project ? { project } : {}) })
const getQueue = async (project?: string) =>
  QueueView.parse(await (await app.get(project ? `/queue?project=${encodeURIComponent(project)}` : '/queue')).json())
const endSession = (key: string) =>
  db.sql`INSERT INTO factory.events (key, session, kind, at) VALUES (${`${key}:end`}, ${key}, 'session_ended', ${clock.now()})`

describe('queue state', () => {
  test('is run until set; set and get round-trip, per scope', async () => {
    expect(await getQueue()).toMatchObject({
      scope: { project: null },
      state: 'run',
      effective: 'run',
      setAt: null,
      scopes: [],
    })

    const res = await setQueue('drain')
    expect(res.status).toBe(200)
    expect(QueueView.parse(await res.json())).toMatchObject({
      state: 'drain',
      effective: 'drain',
      setAt: clock.now().toISOString(),
    })

    await setQueue('pace', TEST_REPO)
    expect(await getQueue(TEST_REPO)).toMatchObject({
      scope: { project: TEST_REPO },
      state: 'pace',
      effective: 'drain',
    })
    expect((await getQueue()).scopes.map((s) => [s.project, s.state])).toEqual([
      [null, 'drain'],
      [TEST_REPO, 'pace'],
    ])
  })

  test('the most restrictive scope that applies wins', async () => {
    await setQueue('pace')
    await setQueue('run', TEST_REPO)
    expect(await getQueue(TEST_REPO)).toMatchObject({ state: 'run', effective: 'pace' })
    await setQueue('drain', TEST_REPO)
    expect(await getQueue(TEST_REPO)).toMatchObject({ state: 'drain', effective: 'drain' })
    expect(await getQueue(OTHER_REPO)).toMatchObject({ state: 'run', effective: 'pace' })
  })

  test('a project outside the allowed roots is 422 and a state that does not exist is 400', async () => {
    expect((await setQueue('drain', '/etc')).status).toBe(422)
    expect((await app.get('/queue?project=%2Fetc')).status).toBe(422)
    expect((await setQueue('pause')).status).toBe(400)
    expect(await getQueue()).toMatchObject({ scopes: [] })
  })
})

describe('drain', () => {
  test('starts nothing new: a spawn stays queued with its reason, and run starts it on the next tick', async () => {
    await setQueue('drain')
    const created = await spawn('s1')
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ status: 'queued', account: null, hold: 'drain' })

    expect(await runTick()).toMatchObject({ started: [], skipped: 0 })
    clock.advance(HOLD_RECHECK_MS)
    expect(await runTick()).toMatchObject({ started: [], skipped: 1 })
    expect(await row('s1')).toMatchObject({ status: 'queued', hold: 'drain' })
    expect(await herdr.calls()).toEqual([])

    await setQueue('run')
    expect(await runTick()).toMatchObject({ started: ['s1'] })
    expect(await row('s1')).toMatchObject({ status: 'started', hold: null })
  })

  test('is held by a project too, and only that project', async () => {
    await setQueue('drain', TEST_REPO)
    await spawn('held')
    await spawn('free', { repo: OTHER_REPO })
    expect(await runTick()).toMatchObject({ started: ['free'] })
    expect(await row('held')).toMatchObject({ status: 'queued', hold: 'drain' })
  })

  test('a spawn that was waiting for capacity is held when it falls due, not started', async () => {
    for (const account of ACCOUNTS) await reading(account, 99, 10)
    expect(await (await spawn('s1')).json()).toMatchObject({ status: 'waiting' })
    await setQueue('drain')
    await setQueue('drain') // waiting spawns are due at once
    expect(await runTick()).toMatchObject({ started: [], skipped: 1 })
    expect(await row('s1')).toMatchObject({ status: 'queued', hold: 'drain' })
    await setQueue('run')
    await reading('a', 10, 10)
    expect(await runTick()).toMatchObject({ started: ['s1'] })
  })

  test('does not touch a session that is running', async () => {
    await spawn('running')
    await runTick()
    await setQueue('drain')
    clock.advance(HOLD_RECHECK_MS)
    await runTick()
    expect(await row('running')).toMatchObject({ status: 'started' })
    expect((await herdr.state()).agents).toHaveLength(1)
  })
})

describe('pace', () => {
  // Late in the week, so that a little use is under the elapsed share.
  const lateInTheWeek = () => inMs(24 * 3_600_000)
  const lateWeek = async () => {
    for (const account of ACCOUNTS) await reading(account, 10, 10, { weeklyResetsAt: lateInTheWeek() })
  }

  test('at most one live session per project', async () => {
    await lateWeek()
    await setQueue('pace')
    await spawn('first')
    expect(await runTick()).toMatchObject({ started: ['first'] })

    expect(await (await spawn('second')).json()).toMatchObject({ status: 'queued', hold: 'pace', account: null })
    await spawn('elsewhere', { repo: OTHER_REPO })
    clock.advance(HOLD_RECHECK_MS)
    expect(await runTick()).toMatchObject({ started: ['elsewhere'] })
    expect(await row('second')).toMatchObject({ status: 'queued', hold: 'pace' })

    // The first session ends: the next look starts the second.
    await endSession('first')
    clock.advance(HOLD_RECHECK_MS)
    expect(await runTick()).toMatchObject({ started: ['second'] })
  })

  test('two spawns created together start one and hold the other', async () => {
    await lateWeek()
    await setQueue('pace')
    await spawn('x')
    await spawn('y')
    expect(await runTick()).toMatchObject({ started: ['x'], skipped: 1 })
    expect(await row('y')).toMatchObject({ hold: 'pace' })
  })

  test('an account is used only while its weekly use is at or below the elapsed share of its week', async () => {
    await setQueue('pace')
    // Half the week has elapsed: 50 %. Both accounts are over it, and one is just under.
    const halfWeek = { weeklyResetsAt: inMs(WEEK_MS / 2), fiveHourResetsAt: inMs(3_600_000) }
    for (const [account, weekly] of [
      ['a', 60],
      ['b', 70],
      ['c', 80],
      ['d', 90],
      ['e', 90],
      ['f', 90],
    ] as const) {
      await reading(account, weekly, 10, halfWeek)
    }
    const created = await (await spawn('s1')).json()
    // Account a reaches its share (60 % of the week) 0.1 of a week from now.
    expect(created).toMatchObject({ status: 'waiting', account: null, resumeAt: inMs(0.1 * WEEK_MS).toISOString() })

    await reading('b', 45, 10, halfWeek)
    expect(await runTick()).toMatchObject({ started: ['s1'] })
    expect(await row('s1')).toMatchObject({ account: 'b' })
  })

  test('run lifts the restriction at once', async () => {
    await setQueue('pace')
    const halfWeek = { weeklyResetsAt: inMs(WEEK_MS / 2) }
    for (const account of ACCOUNTS) await reading(account, 60, 10, halfWeek)
    await spawn('s1')
    expect(await row('s1')).toMatchObject({ status: 'waiting' })
    await setQueue('run')
    expect(await runTick()).toMatchObject({ started: ['s1'] })
  })
})

describe('one active wave per repo', () => {
  test('a second wave in the same repo waits while the first is alive, and starts once it is dead', async () => {
    await spawn('wave-1', { role: 'wave' })
    expect(await runTick()).toMatchObject({ started: ['wave-1'] })

    const second = await spawn('wave-2', { role: 'wave' })
    expect(await second.json()).toMatchObject({ status: 'queued', hold: 'wave', account: null })
    clock.advance(HOLD_RECHECK_MS)
    expect(await runTick()).toMatchObject({ started: [], skipped: 1 })

    await endSession('wave-1')
    clock.advance(HOLD_RECHECK_MS)
    expect(await runTick()).toMatchObject({ started: ['wave-2'] })
    expect(await row('wave-2')).toMatchObject({ hold: null })
  })

  test('only waves are limited: workers, leads and a wave in another repo run alongside', async () => {
    await spawn('wave-1', { role: 'wave' })
    await spawn('fan-1', { role: 'worker' })
    await spawn('fan-2', { role: 'worker' })
    await spawn('lead', { role: 'lead' })
    await spawn('wave-elsewhere', { role: 'wave', repo: OTHER_REPO })
    expect((await runTick()).started.sort()).toEqual(['fan-1', 'fan-2', 'lead', 'wave-1', 'wave-elsewhere'])
  })

  test('two waves of the same repo claimed in one tick: one starts, the other is held', async () => {
    await spawn('w1', { role: 'wave' })
    await spawn('w2', { role: 'wave' })
    expect(await runTick()).toMatchObject({ started: ['w1'], skipped: 1 })
    expect(await row('w2')).toMatchObject({ hold: 'wave' })
  })

  test('a wave that is waiting for a wall does not count, a starting one does', async () => {
    await spawn('w1', { role: 'wave' })
    await runTick()
    // Its session is only `starting` (no hook has spoken), and that is alive.
    await spawn('w2', { role: 'wave' })
    expect(await row('w2')).toMatchObject({ hold: 'wave' })
  })

  test('a session that died for any reason frees the repo, a pane that is gone included', async () => {
    await spawn('w1', { role: 'wave' })
    await runTick()
    await db.sql`INSERT INTO factory.events (key, session, kind, at) VALUES ('w1:gone', 'w1', 'pane_gone', ${clock.now()})`
    await spawn('w2', { role: 'wave' })
    clock.advance(HOLD_RECHECK_MS)
    expect(await runTick()).toMatchObject({ started: ['w2'] })
  })
})

describe('the role', () => {
  test('is worker by default, and the spawn carries the tier and effort of the table', async () => {
    expect(await (await spawn('plain')).json()).toMatchObject({ role: 'worker', tier: 'sonnet', effort: 'high' })
    expect(await (await spawn('boss', { role: 'lead' })).json()).toMatchObject({
      role: 'lead',
      tier: 'opus',
      effort: 'high',
    })
    expect(await (await spawn('sweep', { role: 'mechanical' })).json()).toMatchObject({
      role: 'mechanical',
      tier: 'haiku',
      effort: 'low',
    })
  })

  test("the agent starts with the role's tier and effort", async () => {
    await spawn('boss', { role: 'lead' })
    await spawn('plain')
    await runTick()
    const argvs = (await herdr.state()).agents.map((a) => a.argv.join(' '))
    expect(argvs).toContain('claude --dangerously-skip-permissions --model opus --effort high')
    expect(argvs).toContain('claude --dangerously-skip-permissions --model sonnet --effort high')
  })

  test('an unknown role is 422, names the roles, and stores nothing', async () => {
    const res = await spawn('x', { role: 'overlord' })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toContain('unknown role overlord')
    expect((await app.get('/spawns/x')).status).toBe(404)
  })

  test('a role that is not a word is a 400', async () => {
    expect((await spawn('x', { role: '--model' })).status).toBe(400)
    expect((await spawn('x', { role: 'a b' })).status).toBe(400)
  })
})
