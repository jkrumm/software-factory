import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { QueueView } from '@software-factory/contract'
import { HOLD_RECHECK_MS } from '../src/admission.ts'
import { WEEK_MS } from '../src/capacity.ts'
import { HcRunner } from '../src/hc-runner.ts'
import { createIssue } from '../src/issues/create.ts'
import { admitIssues } from '../src/issues/admission.ts'
import { fileSignalIn } from '../src/issues/signals.ts'
import { tick } from '../src/tick.ts'
import { startApp, TEST_REPO, TEST_ROOT, type TestApp } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { createFakeHc, type FakeHc } from './support/hc.ts'
import { startTestDb, type TestDb } from './support/pg.ts'
import { usage } from './support/quota.ts'

const ACCOUNTS = ['a', 'b', 'c', 'd', 'e', 'f']
const OTHER_REPO = join(TEST_ROOT, 'other')
mkdirSync(OTHER_REPO, { recursive: true })

let db: TestDb
let hc: FakeHc
let app: TestApp
const clock = new FakeClock()

beforeAll(async () => {
  db = await startTestDb()
  hc = await createFakeHc()
  app = startApp({ sql: db.sql, clock })
})
afterAll(async () => {
  await app.stop()
  await hc.cleanup()
  await db.stop()
})
beforeEach(async () => {
  await db.reset()
  await hc.reset()
  // Six accounts with room: the one-spawn-per-account-and-sample rule is not what these tests are about.
  for (const account of ACCOUNTS) await reading(account, 10, 10)
})

const runTick = () =>
  tick({
    sql: db.sql,
    clock,
    runner: new HcRunner({
      bin: hc.bin,
      clock,
      pretrustBin: hc.pretrustBin,
      accountsFile: hc.accountsFile,
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

  test('a misspelled scope is a 400, not the global scope', async () => {
    expect((await app.send('PUT', '/queue', { state: 'drain', projct: TEST_REPO })).status).toBe(400)
    expect(await getQueue()).toMatchObject({ scopes: [] })
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
    expect(await hc.calls()).toEqual([])

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
    expect((await hc.state()).terminals).toHaveLength(1)
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

describe('the role', () => {
  test('is implementer by default, and the spawn carries the tier and effort of the table', async () => {
    expect(await (await spawn('plain')).json()).toMatchObject({ role: 'implementer', tier: 'sonnet', effort: 'high' })
    expect(await (await spawn('look', { role: 'Explore' })).json()).toMatchObject({
      role: 'Explore',
      tier: 'haiku',
      effort: 'low',
    })
  })

  test("the agent starts with the role's tier and effort", async () => {
    await spawn('look', { role: 'Explore' })
    await spawn('plain')
    await runTick()
    const argvs = (await hc.state()).terminals.map((t) => t.argv.slice(0, 6).join(' '))
    expect(argvs).toContain('claude --dangerously-skip-permissions --model haiku --effort low')
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

describe('stop the line', () => {
  let n = 0
  const project = (name: string, repo: string) =>
    db.sql`
      INSERT INTO factory.projects (name, repo, manifest, make_targets, synced_at, created_at)
      VALUES (${name}, ${repo}, NULL, NULL, ${clock.now()}, ${clock.now()})`
  const classify = (id: number) => db.sql`UPDATE factory.issues SET classified_at = ${clock.now()} WHERE id = ${id}`
  const ordinary = async (repo = TEST_REPO, extra: { class?: string } = {}): Promise<number> => {
    const { issue } = await createIssue(
      db.sql,
      { source: 'request', sourceKey: `k${++n}`, repo, title: 'a title', facts: {} },
      { repoRoots: [TEST_ROOT], now: clock.now() },
    )
    if (extra.class) await db.sql`UPDATE factory.issues SET class = ${extra.class} WHERE id = ${issue.id}`
    await classify(issue.id)
    return issue.id
  }
  const episode = async (source: string, status: 'down' | 'event', repo = TEST_REPO): Promise<number> => {
    const done = await db.sql.begin((tx) =>
      fileSignalIn(
        tx,
        { source, subject: `s${++n}`, event: `e${n}`, status, title: 'x is down', facts: {}, repo },
        { repoRoots: [TEST_ROOT], now: clock.now() },
      ),
    )
    if (done.issue === null) throw new Error('no Issue was filed')
    await classify(done.issue)
    return done.issue
  }
  const admit = async (alertLeads = true): Promise<number[]> => {
    await admitIssues(db.sql, { now: clock.now(), alertLeads })
    const rows: { issue_id: number }[] = await db.sql`
      SELECT issue_id FROM factory.issue_inbox WHERE kind = 'admitted' ORDER BY issue_id`
    return rows.map((r) => r.issue_id)
  }

  beforeEach(async () => {
    await project('main', TEST_REPO)
    await project('other', OTHER_REPO)
  })

  test('a project with a queued episode Issue admits only it, though an older ordinary one is queued', async () => {
    await ordinary()
    const fix = await episode('kuma', 'down')
    expect(await admit()).toEqual([fix])
  })

  test('the same project is not stopped once the episode Issue waits', async () => {
    const first = await ordinary()
    const fix = await episode('kuma', 'down')
    await db.sql`UPDATE factory.issues SET state = 'waiting', reason = 'decision' WHERE id = ${fix}`
    expect(await admit()).toEqual([first])
  })

  test('another project is unaffected', async () => {
    const elsewhere = await ordinary(OTHER_REPO)
    await ordinary()
    const fix = await episode('kuma', 'down')
    expect(await admit()).toEqual([elsewhere, fix])
  })

  test('an urgent Issue still passes', async () => {
    const urgent = await ordinary(TEST_REPO, { class: 'urgent' })
    const plain = await ordinary()
    await episode('kuma', 'down')
    const admitted = await admit()
    expect(admitted).toContain(urgent)
    expect(admitted).not.toContain(plain)
  })

  test('a GitHub label Issue is a request: it stops nothing', async () => {
    const first = await ordinary()
    await episode('github', 'event')
    expect(await admit()).toEqual([first])
  })

  test('an alert whose switch is off cannot be admitted, so it stops nothing', async () => {
    const first = await ordinary()
    await episode('kuma', 'down')
    expect(await admit(false)).toEqual([first])
  })

  test('an episode Issue with an open dependency stops nothing', async () => {
    const first = await ordinary()
    const fix = await episode('kuma', 'down')
    await db.sql`INSERT INTO factory.issue_deps (issue_id, on_issue) VALUES (${fix}, ${first})`
    expect(await admit()).toEqual([first])
  })

  test('an episode Issue still finalizing stops nothing', async () => {
    const first = await ordinary()
    const fix = await episode('kuma', 'down')
    await db.sql`
      INSERT INTO factory.issue_effects (issue_id, key, kind, created_at)
      VALUES (${fix}, ${`finalize:${fix}`}, 'finalize', ${clock.now()})`
    expect(await admit()).toEqual([first])
  })
})
