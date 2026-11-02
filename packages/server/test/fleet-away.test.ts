/* oxlint-disable typescript/await-thenable -- bun types the `rejects` matchers as void; they return a promise */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Fleet, Presence, Since } from '@software-factory/contract'
import type { runProcess } from '../src/exec.ts'
import { FleetBuilder } from '../src/fleet/index.ts'
import { GitReader } from '../src/fleet/git.ts'
import { Places } from '../src/fleet/place.ts'
import { FleetActions } from '../src/fleet/act.ts'
import { moveSeen, readPresence } from '../src/fleet/presence.ts'
import type { SinceReader } from '../src/fleet/since.ts'
import type { HcLister, HcTerminal, QueueActor, QueueReader } from '../src/fleet/sources.ts'
import { WindowDigest } from '../src/fleet/window.ts'
import { loadMorning } from '../src/notify/digest.ts'
import { claim, foldReason, listNotifications, record, sendDue } from '../src/notify/outbox.ts'
import { createIssue } from '../src/issues/create.ts'
import { startApp, TEST_ROLES, TEST_TOKEN, type TestApp } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { buildEstate, type Estate, estateTerminals } from './support/fleet-estate.ts'
import { FakeNotifier } from './support/notifier.ts'
import { startTestDb, type TestDb } from './support/pg.ts'
import { world } from './support/world.ts'
import { openSession, recordEvent } from '../src/sessions.ts'

const CLI = join(import.meta.dir, '..', '..', 'cli', 'bin', 'factory.ts')
const NOW = new Date('2026-11-02T12:00:00.000Z')
const MIN = 60_000
const HOUR = 60 * MIN

let db: TestDb
let estate: Estate
let clock: FakeClock
let app: TestApp
let builder: FleetBuilder
let windows: WindowDigest
let reader: SinceReader
let w: ReturnType<typeof world>
let terminals: HcTerminal[]
let requests: { id: string; text: string; askedAt: string; state: string | null }[]
/** every `agw` process the window digest started: the command and what it was given on stdin */
let agw: { cmd: string[]; stdin: string | undefined }[]
/** what the fake `agw` answers */
let agwAnswer: () => { exitCode: number; stdout: string }

const hc: HcLister = { list: async () => terminals }
const queue: QueueReader & QueueActor = {
  list: async () => requests,
  resolve: async (id) => {
    requests = requests.filter((r) => r.id !== id)
    return { written: true }
  },
}

const PARAGRAPH = 'Overnight: the factory shipped and one decision needs you.'
const answerWith = (paragraph: string) => ({
  exitCode: 0,
  stdout: JSON.stringify({ status: 'done', output: { results: [{ id: 'w', paragraph }] }, cost: 0.002 }),
})

beforeAll(async () => {
  db = await startTestDb()
  estate = buildEstate(NOW)
})
afterAll(async () => {
  await app?.stop()
  estate.cleanup()
  await db.stop()
})

beforeEach(async () => {
  await app?.stop()
  await db.reset()
  clock = new FakeClock(NOW)
  w = world(db.sql, clock)
  terminals = estateTerminals(estate)
  requests = []
  agw = []
  agwAnswer = () => answerWith(PARAGRAPH)
  const run: typeof runProcess = async (cmd, _timeout, _env, stdin) => {
    agw.push({ cmd: [...cmd], stdin })
    return { ...agwAnswer(), stderr: '', timedOut: false } as Awaited<ReturnType<typeof runProcess>>
  }
  windows = new WindowDigest({ sql: db.sql, now: () => clock.now(), bin: 'agw', run })
  const places = await Places.of({ visibleRoots: [estate.iu], configured: [estate.src], home: estate.src })
  reader = { sql: db.sql, now: () => clock.now(), visible: async () => (path) => places.isVisible(path), windows }
  builder = new FleetBuilder({
    sql: db.sql,
    now: () => clock.now(),
    roots: [estate.src],
    visibleRoots: [estate.iu],
    home: estate.src,
    hc,
    queue,
    git: new GitReader(),
  })
  const actions = new FleetActions({
    sql: db.sql,
    clock,
    queue,
    roles: TEST_ROLES,
    repoRoots: [estate.src],
    visibleRoots: [estate.iu],
    home: estate.src,
    refresh: () => builder.refreshNow(),
  })
  app = startApp({ sql: db.sql, clock, fleet: builder, fleetActions: actions, since: reader, repoRoots: [estate.src] })
})

const presence = async (place: string, act: string) => app.send('POST', '/fleet/presence', { place, act })
const fleetPresence = async () => Fleet.parse(await (await app.get('/fleet')).json()).presence
async function since(t?: string): Promise<Since> {
  const res = await app.get(`/fleet/since${t ? `?t=${encodeURIComponent(t)}` : ''}`)
  expect(res.status).toBe(200)
  return Since.parse(await res.json())
}

/** The scene: facts in and out of the window that starts at `T`, ordinary and IuRoot. */
const T = '2026-11-01T00:00:00.000Z'
const at = (iso: string) => new Date(iso)
async function scene(): Promise<void> {
  // An ordinary decision (an Issue of modelpick) and a closed shipped Issue, in the window; one closed before it.
  const repo = `${estate.src}/modelpick`
  const ask = await createIssue(
    db.sql,
    { source: 'request', sourceKey: 'ask', repo, title: 'Which harness?', facts: {} },
    { repoRoots: [estate.src], now: NOW },
  )
  await db.sql`
    INSERT INTO factory.decisions (issue_id, key, question, created_at)
    VALUES (${ask.issue.id}, 'q1:dec', 'Benchmark with or without caching?', ${at('2026-11-01T22:00:00Z')})`
  const closed = async (key: string, title: string, when: string) => {
    const made = await createIssue(
      db.sql,
      { source: 'request', sourceKey: key, repo, title, facts: {} },
      { repoRoots: [estate.src], now: NOW },
    )
    await db.sql`UPDATE factory.issues SET state = 'closed', outcome = 'done', closed_at = ${at(when)} WHERE id = ${made.issue.id}`
    return made.issue.id
  }
  await closed('shipped', 'Cache the tiles', '2026-11-01T20:00:00Z')
  await closed('old', 'Rename the harness', '2026-10-20T20:00:00Z')

  // Went wrong, then recovered: a spawn that started on its third try, an effect, a message, a digest that failed and ran.
  await db.sql`
    INSERT INTO factory.spawns (key, repo, prompt, role, tier, effort, status, attempts, assigned_at, session, created_at)
    VALUES ('lw-retried', ${repo}, 'p', 'worker', 'sonnet', 'high', 'started', 3, ${at('2026-11-02T03:00:00Z')}, 'w1:lw', ${at('2026-11-02T02:00:00Z')})`
  await db.sql`
    INSERT INTO factory.issue_effects (issue_id, key, kind, created_at, attempts, done_at)
    VALUES (${ask.issue.id}, 'eff-1', 'finalize', ${at('2026-11-02T01:00:00Z')}, 2, ${at('2026-11-02T04:00:00Z')})`
  await db.sql`
    INSERT INTO factory.notifications (key, kind, text, created_at, next_at, sent_at, attempts)
    VALUES ('notify:failed:x', 'failed', 'x', ${at('2026-11-02T01:00:00Z')}, ${at('2026-11-02T01:00:00Z')}, ${at('2026-11-02T05:00:00Z')}, 3)`
  await db.sql`
    INSERT INTO factory.fleet_digest_runs (at, ok, items, error) VALUES
      (${at('2026-11-02T06:00:00Z')}, false, 3, 'agw digest exited 1'), (${at('2026-11-02T06:20:00Z')}, true, 3, NULL)`

  // Handled for you: the triage's rows (one on an ordinary plan, one on an IuRoot plan) and the owner's own act.
  await db.sql`
    INSERT INTO factory.fleet_triage_log (kind, subject, fingerprint, what, why, evidence, at) VALUES
      ('plan_stale', ${`${estate.src}/modelpick/docs/waves/PLAN.md`}, 'f1', 'marked the modelpick plan stale', 'untouched 20 d', '20 d', ${at('2026-11-02T07:00:00Z')}),
      ('plan_stale', ${`${estate.iu}/prometheus-scripts/wip/waves-teamchat/docs/waves/PLAN.md`}, 'f2', 'marked the teamchat plan stale', 'untouched', 'x', ${at('2026-11-02T07:00:00Z')})`
  await db.sql`
    INSERT INTO factory.fleet_acts (ask_id, occurrence, intent, at, result)
    VALUES ('queue:old', 1, 'deny', ${at('2026-11-02T08:00:00Z')}, '{}'::jsonb)`

  // A lead that is alive and running, with the event that started it.
  await db.sql`
    INSERT INTO factory.spawns (key, repo, prompt, role, tier, effort, status, account, assigned_at, session, created_at)
    VALUES ('software-factory-w6', ${`${estate.src}/software-factory`}, 'lead', 'lead', 'opus', 'high', 'started', 'me2', ${w.at(600)}, 't4h', ${w.at(600)})`
  await openSession(db.sql, { id: 'software-factory-w6', spawnKey: 'software-factory-w6', pane: 't4h', at: w.at(600) })
  await recordEvent(db.sql, {
    key: 'w6:s',
    session: 'software-factory-w6',
    kind: 'session_started',
    at: w.at(600),
    payload: { claudeSessionId: 'c-w6' },
  })

  // Spend: a reading before the window and one now.
  await db.sql`
    INSERT INTO factory.quota_readings (account, read_at, enabled, auth_ok, five_hour_used, weekly_used) VALUES
      ('main', ${at('2026-10-31T20:00:00Z')}, true, true, 10, 20), ('main', ${at('2026-11-02T11:00:00Z')}, true, true, 5, 35)`

  requests = [
    {
      id: 'q-in',
      text: 'Deploy gate [teamchat] deploy of origin/main 5e2a4491add2 FAILED',
      askedAt: '2026-11-01T21:26:07.000Z',
      state: 'pending',
    },
    { id: 'q-out', text: 'An old request', askedAt: '2026-10-27T23:01:30.000Z', state: 'pending' },
  ]
  await builder.refreshNow()
}

describe('presence', () => {
  test('before the board reports, the owner is away', async () => {
    await builder.refreshNow()
    expect((await fleetPresence())?.away).toBe(true)
    expect(await fleetPresence()).toEqual({
      desk: { at: null, present: false },
      phone: { at: null, present: false },
      away: true,
      awaySince: null,
      seenAt: null,
    })
  })

  test('the desk is present for 45 minutes after its last act, the phone for 10, by the clock', async () => {
    await builder.refreshNow()
    const desk = await presence('desk', 'focus')
    expect(desk.status).toBe(201)
    expect(Presence.parse(await desk.json())).toMatchObject({ away: false, desk: { present: true } })
    clock.advance(44 * MIN)
    expect((await fleetPresence())?.desk.present).toBe(true)
    clock.advance(2 * MIN) // 46 min
    const gone = await fleetPresence()
    expect(gone?.desk.present).toBe(false)
    expect(gone?.away).toBe(true)
    expect(gone?.awaySince).toBe(new Date(NOW.getTime() + 45 * MIN).toISOString())

    await presence('phone', 'memo')
    clock.advance(9 * MIN)
    expect(await fleetPresence()).toMatchObject({ phone: { present: true }, away: false, awaySince: null })
    clock.advance(2 * MIN)
    const both = await fleetPresence()
    expect(both).toMatchObject({ phone: { present: false }, desk: { present: false }, away: true })
    // The later of the two expiries.
    expect(both?.awaySince).toBe(new Date(NOW.getTime() + 46 * MIN + 10 * MIN).toISOString())
  })

  test('a memo and the foreground are the phone’s only; an unknown act or place is a 400; the token is needed', async () => {
    expect((await presence('desk', 'memo')).status).toBe(400)
    expect((await presence('desk', 'foreground')).status).toBe(400)
    expect((await presence('phone', 'memo')).status).toBe(201)
    expect((await presence('phone', 'foreground')).status).toBe(201)
    expect((await presence('desk', 'typing')).status).toBe(400)
    expect((await presence('watch', 'focus')).status).toBe(400)
    const bare = await app.bare('/fleet/presence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ place: 'desk', act: 'focus' }),
    })
    expect(bare.status).toBe(401)
    expect((await app.bare('/fleet/since')).status).toBe(401)
  })

  test('nothing but an act moves it: sessions, events and notes do not', async () => {
    await w.spawned('someone', { repo: `${estate.src}/rb` })
    await w.emit('someone', 'turn_started', clock.now())
    await app.send('POST', '/sessions/someone/note', { id: 'n1', text: 'hello' })
    await builder.refreshNow()
    expect(await fleetPresence()).toMatchObject({ away: true, desk: { at: null }, phone: { at: null } })
    expect((await db.sql`SELECT count(*)::int AS n FROM factory.fleet_presence_acts`)[0].n).toBe(0)
  })

  test('acts are kept 30 days', async () => {
    await db.sql`INSERT INTO factory.fleet_presence_acts (place, act, at) VALUES ('desk', 'focus', ${new Date(NOW.getTime() - 31 * 24 * HOUR)})`
    await presence('desk', 'focus')
    const rows = await db.sql`SELECT at FROM factory.fleet_presence_acts`
    expect(rows).toHaveLength(1)
  })
})

describe('seen_at, the owner-wide cursor', () => {
  test('caught_up from any place moves it to now, and it never goes backwards', async () => {
    await builder.refreshNow()
    expect((await readPresence(db.sql, clock.now())).seenAt).toBeNull()
    await presence('phone', 'caught_up')
    expect((await readPresence(db.sql, clock.now())).seenAt).toBe(NOW.toISOString())
    await moveSeen(db.sql, new Date(NOW.getTime() - HOUR))
    expect((await readPresence(db.sql, clock.now())).seenAt).toBe(NOW.toISOString())
    clock.advance(HOUR)
    await presence('desk', 'caught_up')
    expect((await readPresence(db.sql, clock.now())).seenAt).toBe(new Date(NOW.getTime() + HOUR).toISOString())
  })

  test('an act moves it only when it leaves no other ask of the open window in Needs you', async () => {
    requests = [
      { id: 'q-a', text: 'Pull the dotfiles on the MacBook', askedAt: '2026-11-02T10:00:00.000Z', state: 'pending' },
      { id: 'q-b', text: 'Restart the sync container', askedAt: '2026-11-02T10:30:00.000Z', state: 'pending' },
    ]
    await builder.refreshNow()
    const first = await app.send('POST', `/fleet/asks/${encodeURIComponent('queue:q-a')}/act`, { intent: 'later' })
    expect(first.status).toBe(201)
    // `later` hides q-a; q-b (and the hc asks of the estate) are still open: the cursor stays.
    expect((await readPresence(db.sql, clock.now())).seenAt).toBeNull()
    // The act is the desk's: a presence act was recorded for it.
    expect((await readPresence(db.sql, clock.now())).desk.present).toBe(true)

    // Everything else of the window closed or snoozed: the last act moves it.
    for (const ask of (await Fleet.parse(await (await app.get('/fleet')).json())).asks) {
      if (ask.id === 'queue:q-b') continue
      if (ask.actions.some((a) => a.intent === 'later')) {
        await app.send('POST', `/fleet/asks/${encodeURIComponent(ask.id)}/act`, { intent: 'later' })
      }
    }
    const left = (await Fleet.parse(await (await app.get('/fleet')).json())).asks.map((a) => a.id)
    expect(left).toEqual(['queue:q-b'])
    clock.advance(5 * MIN)
    const last = await app.send('POST', `/fleet/asks/${encodeURIComponent('queue:q-b')}/act`, {
      intent: 'later',
      place: 'phone',
    })
    expect(last.status).toBe(201)
    const after = await readPresence(db.sql, clock.now())
    expect(after.seenAt).toBe(clock.now().toISOString())
    // From the phone: a phone act, not the desk's.
    expect(after.phone.present).toBe(true)
  })
})

describe('the cursor on a stale snapshot', () => {
  test('an act whose refresh failed does not move the cursor', async () => {
    terminals = []
    requests = [{ id: 'q-a', text: 'Pull the dotfiles', askedAt: '2026-11-02T10:00:00.000Z', state: 'pending' }]
    await builder.refreshNow()
    const failing = new FleetActions({
      sql: db.sql,
      clock,
      queue,
      roles: TEST_ROLES,
      repoRoots: [estate.src],
      visibleRoots: [estate.iu],
      home: estate.src,
      refresh: async () => {
        throw new Error('build failed')
      },
    })
    await app.stop()
    app = startApp({
      sql: db.sql,
      clock,
      fleet: builder,
      fleetActions: failing,
      since: reader,
      repoRoots: [estate.src],
    })
    const res = await app.send('POST', `/fleet/asks/${encodeURIComponent('queue:q-a')}/act`, { intent: 'later' })
    expect(res.status).toBe(201)
    const after = await readPresence(db.sql, clock.now())
    expect(after.desk.present).toBe(true) // the act itself is a person's
    expect(after.seenAt).toBeNull()
  })
})

describe('GET /fleet/since', () => {
  test('each group from seeded facts, every line with its source', async () => {
    await scene()
    const reading = await since(T)
    expect(reading.t).toBe(T)

    // Needs you: the asks with `at` in the window; yours first.
    const ids = reading.needsYou.map((n) => n.ask.id)
    expect(ids).toContain('decision:q1:dec')
    expect(ids).toContain('queue:q-in')
    expect(ids).not.toContain('queue:q-out')
    const yours = reading.needsYou.map((n) => n.yours)
    expect(yours).toEqual([...yours].sort((a, b) => Number(b) - Number(a)))
    const decision = reading.needsYou.find((n) => n.ask.id === 'decision:q1:dec')
    expect(decision).toMatchObject({ yours: true, visible: false, source: 'fleet_snapshot:decision:q1:dec' })
    expect(decision?.ask.actions.map((a) => a.intent)).toEqual(expect.arrayContaining(['later', 'deny']))
    // Nothing says where a queue request stands: it counts as IuRoot's.
    expect(reading.needsYou.find((n) => n.ask.id === 'queue:q-in')?.visible).toBe(true)

    // Shipped: a closed Issue, commits of the default branch, a wave closed on a date of the window.
    const shipped = reading.shipped
    expect(shipped.find((s) => s.kind === 'issue')).toMatchObject({
      visible: false,
      text: expect.stringContaining('Cache the tiles'),
    })
    expect(shipped.filter((s) => s.kind === 'issue')).toHaveLength(1)
    const commit = shipped.find((s) => s.kind === 'commit' && s.text.startsWith('software-factory:'))
    expect(commit?.source).toMatch(/^git:software-factory@[0-9a-f]{12}$/)
    expect(commit?.visible).toBe(false)
    expect(shipped.find((s) => s.kind === 'commit' && s.text.startsWith('prometheus-epx:'))?.visible).toBe(true)
    expect(shipped.find((s) => s.kind === 'commit' && s.text.startsWith('homelab:'))).toBeUndefined() // two days old
    const waves = shipped.filter((s) => s.kind === 'wave')
    expect(waves.map((s) => s.source)).toEqual(
      expect.arrayContaining([
        'plan:agent-workflows/docs/waves/PLAN.md#wave-1',
        'plan:agent-workflows/docs/waves/PLAN.md#wave-2',
      ]),
    )
    expect(waves.find((s) => s.source.startsWith('plan:homelab'))).toBeUndefined() // 2026-10-20

    // Went wrong, then recovered: one collapsed line each.
    expect(reading.recovered.map((r) => r.kind).sort()).toEqual(['digest', 'effect', 'notification', 'spawn'])
    expect(reading.recovered.find((r) => r.kind === 'spawn')).toMatchObject({
      source: 'spawns:lw-retried',
      text: expect.stringContaining('after 2 failed'),
    })
    expect(reading.recovered.find((r) => r.kind === 'effect')?.source).toBe('issue_effects:eff-1')
    expect(reading.recovered.find((r) => r.kind === 'notification')?.source).toBe('notifications:notify:failed:x')
    expect(reading.recovered.find((r) => r.kind === 'digest')?.text).toContain('failed 1 time, then ran')

    // Handled for you: the triage's rows with their undo id, and the owner's act.
    const triage = reading.handled.filter((h) => h.kind === 'triage')
    const ordinary = triage.find((h) => h.text.includes('modelpick'))
    const undoId = ordinary?.undoId
    const ordinarySource = ordinary?.source
    expect(ordinary).toMatchObject({
      visible: false,
      undoId: expect.any(Number),
      source: expect.stringMatching(/^fleet_triage_log:\d+$/),
    })
    expect(triage.find((h) => h.text.includes('teamchat'))?.visible).toBe(true)
    expect(reading.handled.find((h) => h.kind === 'act')).toMatchObject({
      source: expect.stringMatching(/^fleet_acts:\d+$/),
      undoId: null,
    })
    // An undone row has no undo id any more.
    const id = undoId
    const undo = await app.send('POST', `/fleet/triage/${id}/undo`, {})
    expect([undo.status, await undo.text()]).toEqual([201, expect.any(String)])
    const again = await since(T)
    expect(again.handled.find((h) => h.source === ordinarySource)).toMatchObject({ undoId: null })

    // Still running: the lead, with how long it has run.
    const lead = reading.running.find((r) => r.id === 'software-factory-w6')
    expect(lead?.ranForMs).toBe(600 * MIN)
    expect(lead?.source).toBe('events:software-factory-w6')
    expect(reading.running.find((r) => r.id === 'prometheus-epx-w1')?.visible).toBe(true)

    // Spend: the reading at or before the window's start and now; the digest's own.
    expect(reading.spend.accounts).toEqual([
      {
        account: 'main',
        weeklyAtStart: 20,
        weeklyNow: 35,
        source: expect.stringMatching(/^quota_readings:\d+\.\.\d+$/),
      },
    ])
    expect(reading.spend.digestSource).toBe('fleet_digest_runs')
    for (const line of [...reading.shipped, ...reading.recovered, ...reading.handled, ...reading.running]) {
      expect(line.source).not.toBe('')
    }
  })

  test('t: defaults to the cursor, is cut at 7 days, and a later or malformed one is 400', async () => {
    await builder.refreshNow()
    expect((await since()).t).toBe(new Date(NOW.getTime() - 24 * HOUR).toISOString()) // never caught up
    await presence('desk', 'caught_up')
    clock.advance(3 * HOUR)
    expect((await since()).t).toBe(NOW.toISOString())
    const old = await since('2026-10-01T00:00:00Z')
    expect(old.clamped).toBe(true)
    expect(old.t).toBe(new Date(clock.now().getTime() - 7 * 24 * HOUR).toISOString())
    for (const bad of ['yesterday', '2026-11-03T00:00:00Z', '2027-01-01T00:00:00Z', '']) {
      const res = await app.get(`/fleet/since?t=${encodeURIComponent(bad)}`)
      expect(res.status).toBe(400)
    }
  })

  test('503 before the first build', async () => {
    expect((await app.get('/fleet/since')).status).toBe(503)
  })

  test('it never calls agw: a missing headline is queued and answered pending', async () => {
    await scene()
    const first = await since(T)
    expect(first.headline).toEqual({ state: 'pending', text: null })
    expect(agw).toHaveLength(0)
    await since(T)
    expect(agw).toHaveLength(0)
    expect(await db.sql`SELECT state FROM factory.fleet_windows`).toEqual([{ state: 'queued' }])

    // The digest pass does the call, once; the same facts are one window.
    await windows.pass()
    expect(agw).toHaveLength(1)
    expect(agw[0]?.cmd.slice(0, 4)).toEqual(['agw', 'digest', '--format', 'json'])
    const ready = await since(T)
    expect(ready.headline).toEqual({ state: 'ready', text: PARAGRAPH })
    await windows.pass()
    expect(agw).toHaveLength(1)
    // The call is in the journal, with its cost.
    const [spend] =
      await db.sql`SELECT sum(cost_usd)::float AS usd FROM factory.fleet_digest_runs WHERE batch_hash LIKE 'window:%'`
    expect(spend.usd).toBeCloseTo(0.002)
    expect((await since(T)).spend.digestUsd).toBeGreaterThan(0)
  })

  test('without a digest the headline is none', async () => {
    await scene()
    const noDigest: SinceReader = { ...reader, windows: undefined }
    await app.stop()
    app = startApp({ sql: db.sql, clock, fleet: builder, since: noDigest, repoRoots: [estate.src] })
    expect((await since(T)).headline).toEqual({ state: 'none', text: null })
  })

  test('no IuRoot text reaches a window call: an IuRoot item is a count', async () => {
    await scene()
    await since(T)
    await windows.pass()
    const sent = agw[0]?.stdin ?? ''
    const [item] = JSON.parse(sent) as { id: string; kind: string; text: string }[]
    expect(item).toMatchObject({ id: 'w', kind: 'window' })
    // Ordinary facts are there ...
    expect(item?.text).toContain('Benchmark with or without caching?')
    expect(item?.text).toContain('Cache the tiles')
    expect(item?.text).toContain('software-factory: the state of the plan')
    // ... and nothing of the IuRoot ones: not a repo, a session, a plan, a queue request, a prompt.
    for (const secret of ['prometheus', 'epx', 'teamchat', 'Teamchat', 'athena', 'node_modules', 'Deploy gate']) {
      expect(item?.text.toLowerCase()).not.toContain(secret.toLowerCase())
    }
    expect(item?.text).toMatch(/counted only: [1-9]\d*/)
    expect(item?.text.length).toBeLessThanOrEqual(6000)
  })

  test('a failed call leaves the groups as they are, waits, and is not retried at once', async () => {
    await scene()
    agwAnswer = () => ({ exitCode: 1, stdout: '' })
    await since(T)
    await windows.pass()
    expect(agw).toHaveLength(1)
    expect((await since(T)).headline).toEqual({ state: 'failed', text: null })
    await windows.pass()
    expect(agw).toHaveLength(1) // backing off
    clock.advance(16 * MIN)
    agwAnswer = () => answerWith(PARAGRAPH)
    await windows.pass()
    expect(agw).toHaveLength(2)
    expect((await since(T)).headline).toEqual({ state: 'ready', text: PARAGRAPH })
  })

  test('equal facts are one window: with no cursor the start moves with the clock and the hash does not', async () => {
    await scene()
    clock.advance(MIN) // the commits of the scene sit on the first start; they age out of a rolling window as time passes
    await since()
    clock.advance(3 * MIN)
    await since()
    clock.advance(40 * MIN)
    await since()
    expect(await db.sql`SELECT hash FROM factory.fleet_windows`).toHaveLength(1)
  })

  test('an item that came back as an error is a run agw ended: the retry is a new run, under a new key', async () => {
    await scene()
    await since(T)
    agwAnswer = () => ({
      exitCode: 0,
      stdout: JSON.stringify({ status: 'done', output: { results: [{ id: 'w', error: 'bad' }] }, cost: 0.001 }),
    })
    await windows.pass()
    clock.advance(16 * MIN)
    agwAnswer = () => answerWith(PARAGRAPH)
    await windows.pass()
    const keys = agw.map((c) => c.cmd[c.cmd.indexOf('--idempotency-key') + 1] ?? '')
    expect(keys).toHaveLength(2)
    expect(keys[0]?.endsWith('-0')).toBe(true)
    expect(keys[1]?.endsWith('-1')).toBe(true)
  })

  test('a run agw has not finished is waited for, never started twice', async () => {
    await scene()
    await since(T)
    agwAnswer = () => ({ exitCode: 10, stdout: JSON.stringify({ status: 'running', runId: 'run-window-12345' }) })
    await windows.pass()
    expect((await since(T)).headline.state).toBe('pending')
    await windows.pass()
    expect(agw.map((c) => c.cmd.slice(0, 3))).toEqual([
      ['agw', 'digest', '--format'],
      ['agw', 'run', 'wait'],
    ])
    agwAnswer = () => answerWith(PARAGRAPH)
    await windows.pass()
    expect((await since(T)).headline.state).toBe('ready')
  })

  test('a daily cap bounds the calls', async () => {
    await scene()
    const run: typeof runProcess = async (cmd, _t, _e, stdin) => {
      agw.push({ cmd: [...cmd], stdin })
      return { exitCode: 1, stdout: '', stderr: '', timedOut: false } as Awaited<ReturnType<typeof runProcess>>
    }
    const capped = new WindowDigest({ sql: db.sql, now: () => clock.now(), bin: 'agw', run, dailyCap: 2 })
    await capped.request({ text: 'facts one', hash: 'h1' })
    await capped.pass()
    clock.advance(HOUR * 7) // past any backoff
    await capped.pass()
    await capped.request({ text: 'facts two', hash: 'h2' })
    await capped.pass()
    expect(agw).toHaveLength(2)
  })

  test('the first desk act after an away window queues its window at once', async () => {
    await scene()
    await presence('phone', 'caught_up') // the cursor: a window from now would be empty, so move it back
    await db.sql`UPDATE factory.fleet_seen SET seen_at = ${at(T)}`
    expect(await db.sql`SELECT 1 FROM factory.fleet_windows`).toHaveLength(0)
    const act = await presence('desk', 'focus')
    expect(act.status).toBe(201)
    await windows.settled()
    expect(agw).toHaveLength(1) // queued and started by the act, not waiting for the tick
    const ready = await since() // the cursor is the default t
    expect(ready.headline).toEqual({ state: 'ready', text: PARAGRAPH })
    // A second desk act while the desk is present asks for nothing more.
    await presence('desk', 'looked')
    await windows.settled()
    expect(agw).toHaveLength(1)
  })
})

describe('the away rule in the outbox', () => {
  const message = (key: string, kind: 'ask' | 'failed' | 'digest' | 'test' | 'parked' | 'regression') => ({
    key,
    kind,
    issueId: null,
    text: `text of ${key}`,
  })
  async function offer() {
    for (const [key, kind] of [
      ['notify:ask:1', 'ask'],
      ['notify:parked:1:1', 'parked'],
      ['notify:failed:spawn:s', 'failed'],
      ['notify:regression:1:1', 'regression'],
      ['notify:digest:2026-11-02', 'digest'],
      ['notify:test:t1', 'test'],
    ] as const) {
      await record(db.sql, message(key, kind), clock.now())
    }
    const notifier = new FakeNotifier()
    await sendDue(db.sql, { notifier, now: () => clock.now(), limit: 20 })
    return notifier
  }
  const statuses = async () => Object.fromEntries((await listNotifications(db.sql)).map((n) => [n.key, n.status]))

  test('away: only a decision, the morning reading and a test go out; the rest is folded, with the reason, and never sent later', async () => {
    const notifier = await offer()
    expect(notifier.sent.sort()).toEqual([
      'text of notify:ask:1',
      'text of notify:digest:2026-11-02',
      'text of notify:test:t1',
    ])
    expect(await statuses()).toEqual({
      'notify:ask:1': 'sent',
      'notify:parked:1:1': 'folded',
      'notify:failed:spawn:s': 'folded',
      'notify:regression:1:1': 'folded',
      'notify:digest:2026-11-02': 'sent',
      'notify:test:t1': 'sent',
    })
    const folded = (await listNotifications(db.sql)).find((n) => n.key === 'notify:parked:1:1')
    expect(folded?.foldedReason).toContain('away')
    expect(folded?.sentAt).toBeNull()
    // Later, with the phone present: still not sent, and it is not retried.
    await presence('phone', 'foreground')
    clock.advance(10 * HOUR)
    await presence('phone', 'foreground')
    const later = new FakeNotifier()
    await sendDue(db.sql, { notifier: later, now: () => clock.now() })
    expect(later.sent).toEqual([])
    expect((await listNotifications(db.sql, { pending: true })).map((n) => n.key)).toEqual([])
  })

  test('desk present: a decision is folded too (the board shows it), the morning reading and a test still go out', async () => {
    await presence('desk', 'focus')
    const notifier = await offer()
    expect(notifier.sent.sort()).toEqual(['text of notify:digest:2026-11-02', 'text of notify:test:t1'])
    const states = await statuses()
    expect(states['notify:ask:1']).toBe('folded')
    expect(states['notify:failed:spawn:s']).toBe('folded')
  })

  test('phone present, desk not: everything goes out', async () => {
    await presence('phone', 'foreground')
    const notifier = await offer()
    expect(notifier.sent).toHaveLength(6)
    expect(Object.values(await statuses()).every((s) => s === 'sent')).toBe(true)
  })

  test('the clock decides at send time, not at record time; the desk wins over the phone', async () => {
    await record(db.sql, message('notify:failed:spawn:late', 'failed'), clock.now())
    await presence('phone', 'foreground')
    clock.advance(11 * MIN) // the phone has gone by the time it is sent
    const notifier = new FakeNotifier()
    await sendDue(db.sql, { notifier, now: () => clock.now() })
    expect(notifier.sent).toEqual([])
    expect((await statuses())['notify:failed:spawn:late']).toBe('folded')
    expect(
      foldReason('notify:failed:x', { desk: { at: null, present: true }, phone: { at: null, present: true } }),
    ).not.toBeNull()
  })

  test('a folded row is not claimed again', async () => {
    await record(db.sql, message('notify:parked:2:1', 'parked'), clock.now())
    expect(await claim(db.sql, clock.now(), 5)).toEqual([])
    expect(await claim(db.sql, clock.now(), 5)).toEqual([])
    const [row] = await listNotifications(db.sql)
    expect(row?.status).toBe('folded')
    expect(row?.attempts).toBe(0)
  })
})

describe('the morning reading', () => {
  test('the since groups as plain text under 3000 characters: no model text, an IuRoot item is a count', async () => {
    await scene()
    // A headline the model wrote: it stays on the board.
    await since(T)
    await windows.pass()
    expect((await since(T)).headline.text).toBe(PARAGRAPH)
    await presence('phone', 'caught_up')
    await db.sql`UPDATE factory.fleet_seen SET seen_at = ${at('2026-11-01T18:00:00Z')}`
    const places = await Places.of({ visibleRoots: [estate.iu], configured: [estate.src], home: estate.src })
    const text = await loadMorning(db.sql, {
      now: clock.now(),
      date: '2026-11-02',
      isVisible: (path) => places.isVisible(path),
    })
    expect(text.length).toBeLessThan(3000)
    expect(text).not.toContain('\n\n')
    expect(text).toContain('Factory morning reading 2026-11-02, since 2026-11-01 18:00Z (your last catch-up)')
    expect(text).toContain('Needs you: ')
    expect(text).toContain('Benchmark with or without caching?')
    expect(text).toContain('Cache the tiles')
    expect(text).toContain('Went wrong, then recovered: 4')
    expect(text).toMatch(/Handled for you: \d+ by the triage \(\d+ undoable\), 1 by you/)
    expect(text).toContain('Spend: main week 20% to 35%')
    // no model text
    expect(text).not.toContain(PARAGRAPH)
    expect(text).not.toContain('Overnight')
    // nothing of IuRoot, only a count
    for (const secret of ['prometheus', 'epx', 'teamchat', 'Teamchat', 'athena', 'node_modules', 'Deploy gate']) {
      expect(text.toLowerCase()).not.toContain(secret.toLowerCase())
    }
    expect(text).toMatch(/Read-only area: [1-9]\d* items, counted only/)
  })

  test('it looks back at most 24 hours', async () => {
    await scene()
    const text = await loadMorning(db.sql, { now: clock.now(), date: '2026-11-02', isVisible: () => false })
    expect(text).toContain('since 2026-11-01 12:00Z')
    expect(text).not.toContain('(your last catch-up)')
  })

  test('with nothing in the window it says so and is still short', async () => {
    const text = await loadMorning(db.sql, { now: clock.now(), date: '2026-11-02', isVisible: () => false })
    expect(text).toContain('Needs you: none')
    expect(text).toContain('Shipped: none')
    expect(text.length).toBeLessThan(600)
  })
})

describe('the CLI', () => {
  async function factory(args: string[], env: Record<string, string> = {}) {
    const proc = Bun.spawn(['bun', CLI, ...args], {
      env: { ...process.env, FACTORY_URL: app.url.href, FACTORY_TOKEN: TEST_TOKEN, ...env },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
    return { stdout, stderr, code }
  }

  test('presence, since and seen; json and plain; the token is needed (exit 3)', async () => {
    await scene()
    const here = await factory(['fleet', 'presence', 'desk', 'focus'])
    expect(here.code).toBe(0)
    expect(Presence.parse(JSON.parse(here.stdout)).desk.present).toBe(true)
    const plain = await factory(['--format', 'plain', 'fleet', 'presence', 'phone', 'memo'])
    expect(plain.stdout).toMatch(/^here\tdesk present .*\tphone present /)
    expect((await factory(['fleet', 'presence', 'desk', 'memo'])).code).toBe(2)
    expect((await factory(['fleet', 'presence', 'desk'])).code).toBe(2)

    const json = await factory(['fleet', 'since', '--t', T])
    expect(json.code).toBe(0)
    expect(Since.parse(JSON.parse(json.stdout)).t).toBe(T)
    const screen = await factory(['--format', 'plain', 'fleet', 'since', '--t', T])
    expect(screen.stdout).toMatch(/HEADLINE\t(pending|ready)/)
    expect(screen.stdout).toContain('NEEDS YOU (')
    expect(screen.stdout).toContain('git:software-factory@')
    expect((await factory(['fleet', 'since', '--t', 'soon'])).code).toBe(2)
    expect((await factory(['fleet', 'since', '--t', '2099-01-01T00:00:00Z'])).code).toBe(2)

    const seen = await factory(['fleet', 'seen'])
    expect(Presence.parse(JSON.parse(seen.stdout)).seenAt).toBe(NOW.toISOString())

    const dir = mkdtempSync('/tmp/factory-away-sock-')
    try {
      for (const args of [
        ['fleet', 'presence', 'desk', 'focus'],
        ['fleet', 'since'],
        ['fleet', 'seen'],
      ]) {
        const out = await factory(args, { FACTORY_TOKEN: '', FACTORY_SOCKET: join(dir, 'h.sock') })
        expect(out.code).toBe(3)
        expect(out.stdout).toBe('')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
