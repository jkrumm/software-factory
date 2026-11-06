/* oxlint-disable typescript/await-thenable -- bun types the `rejects` matchers as void; they return a promise */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Fleet } from '@software-factory/contract'
import { createIssue } from '../src/issues/create.ts'
import { FleetBuilder } from '../src/fleet/index.ts'
import { AskHumanQueue, type HcLister, type HcTerminal, type QueueReader } from '../src/fleet/sources.ts'
import { serveHooks } from '../src/http.ts'
import { startApp, TEST_ROLES, TEST_TOKEN, type TestApp } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { buildEstate, type Estate, estateTerminals } from './support/fleet-estate.ts'
import { startTestDb, type TestDb } from './support/pg.ts'
import { world } from './support/world.ts'

const CLI = join(import.meta.dir, '..', '..', 'cli', 'bin', 'factory.ts')
const NOW = new Date('2026-11-02T12:00:00.000Z')

let db: TestDb
let estate: Estate
let clock: FakeClock
let app: TestApp
let builder: FleetBuilder
let w: ReturnType<typeof world>
let terminals: HcTerminal[]
let hcFails: string | undefined
let queueAnswer: () => Promise<{ id: string; text: string; askedAt: string; state: string | null }[]>

const hc: HcLister = {
  list: async () => {
    if (hcFails) throw new Error(hcFails)
    return terminals
  },
}
const queue: QueueReader = { list: () => queueAnswer() }

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
  hcFails = undefined
  queueAnswer = async () => [
    {
      id: '20261027T230130-2786',
      text: 'Publish the aggregates-only LoA status report',
      askedAt: '2026-10-27T23:01:30.000Z',
      state: 'pending',
    },
    {
      id: '20261101T212607-21171',
      text: 'Deploy gate [teamchat] deploy of origin/main 5e2a4491add2 FAILED',
      askedAt: '2026-11-01T21:26:07.000Z',
      state: 'pending',
    },
    { id: '20261102T110000-1', text: 'MacBook: pull dotfiles', askedAt: '2026-11-02T11:00:00.000Z', state: 'queued' },
  ]
  builder = new FleetBuilder({
    sql: db.sql,
    now: () => clock.now(),
    roots: [estate.src],
    visibleRoots: [estate.iu],
    home: estate.src,
    hc,
    queue,
  })
  app = startApp({ sql: db.sql, clock, fleet: builder, repoRoots: [estate.src] })
})

/** The factory's own rows: the lead (matches hc's terminal by name), a session waiting on the owner, a failed spawn, a failed message, a question. */
async function factoryRows() {
  await db.sql`
    INSERT INTO factory.spawns (key, repo, prompt, role, tier, effort, status, account, assigned_at, session, created_at)
    VALUES ('software-factory-w6', ${`${estate.src}/software-factory`}, 'Rotation 5 (the program lead) here: resume where you were.', 'lead', 'opus', 'high', 'started', 'me2', ${w.at(600)}, 't4h', ${w.at(600)})`
  const { openSession, recordEvent } = await import('../src/sessions.ts')
  await openSession(db.sql, { id: 'software-factory-w6', spawnKey: 'software-factory-w6', pane: 't4h', at: w.at(600) })
  await recordEvent(db.sql, {
    key: 'w6:s',
    session: 'software-factory-w6',
    kind: 'session_started',
    at: w.at(600),
    payload: { claudeSessionId: 'c-w6' },
  })
  await w.emit('software-factory-w6', 'turn_started', w.at(5))

  await w.spawned('rb-waits', { repo: `${estate.src}/rb`, role: 'wave' })
  await w.emit('rb-waits', 'turn_started', w.at(50))
  await w.emit('rb-waits', 'wait_declared', w.at(40), { on: 'owner' })
  await w.emit('rb-waits', 'turn_ended', w.at(39))

  await db.sql`
    INSERT INTO factory.spawns (key, repo, prompt, role, tier, effort, status, error, created_at)
    VALUES ('lw-fix', ${`${estate.src}/linewatch`}, 'p', 'worker', 'sonnet', 'high', 'failed', 'the pane never came up', ${w.at(30)})`
  await db.sql`
    INSERT INTO factory.notifications (key, kind, text, created_at, next_at, failed_at, attempts, error)
    VALUES ('notify:failed:x', 'failed', 'x', ${w.at(100)}, ${w.at(100)}, ${w.at(90)}, 5, 'Hermes did not answer')`
  const { issue } = await createIssue(
    db.sql,
    { source: 'request', sourceKey: 'q1', repo: `${estate.src}/modelpick`, title: 'Which harness?', facts: {} },
    { repoRoots: [estate.src], now: clock.now() },
  )
  await db.sql`
    INSERT INTO factory.decisions (issue_id, key, question, created_at)
    VALUES (${issue.id}, 'q1:dec', 'Benchmark with or without caching?', ${w.at(200)})`
}

async function get(): Promise<Fleet> {
  const res = await app.get('/fleet')
  expect(res.status).toBe(200)
  return Fleet.parse(await res.json())
}

describe('GET /fleet', () => {
  test('answers from the stored snapshot only, 503 before the first build', async () => {
    const res = await app.get('/fleet')
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'not_ready' })

    await builder.refreshNow()
    const first = await get()
    // a read is the stored row: a change since the build does not show until the next one
    queueAnswer = async () => []
    expect(await get()).toEqual(first)
  })

  test('issues: the open Issues, with the lead session when one is live; a closed one is not listed', async () => {
    await factoryRows()
    const open = await createIssue(
      db.sql,
      { source: 'request', sourceKey: 'i1', repo: `${estate.src}/modelpick`, title: 'Open one', facts: {} },
      { repoRoots: [estate.src], now: clock.now() },
    )
    const closed = await createIssue(
      db.sql,
      { source: 'request', sourceKey: 'i2', repo: `${estate.src}/modelpick`, title: 'Closed one', facts: {} },
      { repoRoots: [estate.src], now: clock.now() },
    )
    await db.sql`UPDATE factory.issues SET state = 'closed', closed_at = ${clock.now()}, outcome = 'done' WHERE id = ${closed.issue.id}`
    await builder.refreshNow()
    const issues = (await get()).issues
    expect(issues.map((i) => i.title)).toContain('Open one')
    expect(issues.map((i) => i.title)).not.toContain('Closed one')
    expect(issues.find((i) => i.id === open.issue.id)).toMatchObject({
      repo: `${estate.src}/modelpick`,
      state: expect.any(String),
      lead: null,
    })
  })

  test('needs the token', async () => {
    expect((await app.bare('/fleet')).status).toBe(401)
  })
})

describe('the estate', () => {
  test('repos: only those with a live session or an open Issue, IuRoot visible', async () => {
    await factoryRows()
    await builder.refreshNow()
    const fleet = await get()
    expect(fleet.repos.map((r) => r.name)).toEqual([
      'modelpick',
      'prometheus-epx',
      'prometheus-scripts',
      'rb',
      'software-factory',
    ])
    const by = (name: string) => fleet.repos.find((r) => r.name === name)
    expect(by('dotfiles')).toBeUndefined()
    expect(by('software-factory')).toMatchObject({ visible: false, space: join(estate.src, 'software-factory') })
    expect(by('prometheus-scripts')).toMatchObject({ visible: true })
    expect(by('prometheus-epx')).toMatchObject({ visible: true })
    expect(Object.keys(by('modelpick') ?? {}).sort()).toEqual(['name', 'sessions', 'space', 'visible'])
  })

  test('sessions: the factory and hc merged by name, IuRoot included, outside the roots left out', async () => {
    await factoryRows()
    await builder.refreshNow()
    const fleet = await get()
    const sessions = fleet.repos.flatMap((r) => r.sessions.map((s) => ({ repo: r.name, ...s })))
    expect(sessions.map((s) => s.id).sort()).toEqual([
      'athena-orchestrator',
      'modelpick-idle',
      'prometheus-epx-w1',
      'rb-waits',
      'software-factor-fv-w1-read-model',
      'software-factory-w6',
    ])
    const lead = sessions.find((s) => s.id === 'software-factory-w6')
    expect(lead).toMatchObject({
      repo: 'software-factory',
      role: 'lead',
      state: 'working',
      hc: 'working',
      account: 'me2',
      terminal: 't4h',
      title: 'Software-factory Wave 6 night run',
      headline: null,
    })
    expect(sessions.find((s) => s.id === 'rb-waits')).toMatchObject({ state: 'waiting', wait: 'owner', hc: null })
    expect(sessions.find((s) => s.id === 'prometheus-epx-w1')).toMatchObject({
      parent: 'athena-orchestrator',
      state: 'blocked',
      terminal: 't6n',
    })
    // the lead, its worker and the teamchat orchestrator work; the idle tab is done; the blocked and the waiting are neither
    expect(fleet.summary).toMatchObject({ working: 3, done: 1, idle: 2 })
    // the Claude Code outside every root has no repo: unplaced, not counted
    expect(fleet.unplaced.map((u) => u.id)).toEqual(['elsewhere'])
    expect(fleet.summary.working + fleet.summary.idle + fleet.summary.done).toBe(sessions.length)
  })

  test('asks: every deterministic source, stable ids, text as data', async () => {
    await factoryRows()
    await builder.refreshNow()
    const fleet = await get()
    const ids = fleet.asks.map((a) => a.id)
    expect(ids).toContain('hc:prometheus-epx-w1')
    expect(ids).toContain('wait:rb-waits')
    expect(ids).toContain('decision:q1:dec')
    expect(ids).toContain('queue:20261027T230130-2786')
    // a failed spawn and an undelivered notification are machine failures: health lines, never asks
    expect(ids.filter((id) => id.startsWith('factory:'))).toHaveLength(0)
    expect(fleet.health.map((h) => [h.kind, h.id.replace(/:[0-9a-f]{6}$/, ''), h.repo])).toEqual(
      expect.arrayContaining([
        ['machine', 'health:spawn:lw-fix', join(estate.src, 'linewatch')],
        ['machine', 'health:notification:notify:failed:x', null],
      ]),
    )
    expect(fleet.health).toHaveLength(2)
    const by = (id: string) => fleet.asks.find((a) => a.id === id)
    expect(by('hc:prometheus-epx-w1')).toMatchObject({
      kind: 'permission',
      source: 'hc',
      session: 'prometheus-epx-w1',
      text: 'Allow Bash(rm -rf node_modules)?',
      repo: join(estate.iu, 'prometheus-epx'),
      short: null,
    })
    expect(by('decision:q1:dec')).toMatchObject({
      kind: 'question',
      repo: join(estate.src, 'modelpick'),
      text: 'Benchmark with or without caching?',
    })
    expect(by('queue:20261101T212607-21171')).toMatchObject({
      kind: 'human',
      repo: null,
      at: '2026-11-01T21:26:07.000Z',
    })
    expect(fleet.health.map((h) => h.text).sort()).toEqual([
      'notification notify:failed:x was not delivered: Hermes did not answer',
      'spawn lw-fix failed: the pane never came up',
    ])
    expect(fleet.health.find((h) => h.text.startsWith('spawn'))?.repo).toBe(join(estate.src, 'linewatch'))
    // the open decision is an ask of its own, not twice
    expect(fleet.asks.filter((a) => a.text?.includes('Benchmark'))).toHaveLength(1)
    // oldest first; only the October request is older than a day
    expect(fleet.asks[0]?.id).toBe('queue:20261027T230130-2786')
    expect(fleet.summary.staleAsks).toBe(1)
    expect(fleet.summary.asks).toBe(fleet.asks.length)
  })

  test('a factory ask keeps the time it was first seen, and its id across minutes', async () => {
    await factoryRows()
    await builder.refreshNow()
    const first = (await get()).asks.filter((a) => a.source === 'factory')
    clock.advance(20 * 60_000)
    await builder.refreshNow()
    const second = (await get()).asks.filter((a) => a.source === 'factory')
    expect(second.map((a) => [a.id, a.at])).toEqual(first.map((a) => [a.id, a.at]))
  })

  test('quota and queue are the status screen’s', async () => {
    await factoryRows()
    await builder.refreshNow()
    const fleet = await get()
    expect(fleet.queue.effective).toBe('run')
    expect(fleet.queue.spawns.map((s) => s.key)).toContain('lw-fix')
    expect(fleet.quota).toEqual([])
  })
})

describe('a source that fails', () => {
  test('the human queue: an errors line, the rest stands, no crash', async () => {
    await factoryRows()
    queueAnswer = async () => {
      throw new Error('ask-human.sh list --json did not print JSON')
    }
    const fleet = await builder.refreshNow()
    expect(fleet.errors).toEqual(['human queue: ask-human.sh list --json did not print JSON'])
    expect(fleet.asks.some((a) => a.source === 'queue')).toBe(false)
    expect(fleet.repos).toHaveLength(5)
  })

  test('hc leaves its part as the build before had it', async () => {
    await factoryRows()
    const before = await builder.refreshNow()
    expect(before.errors).toEqual([])
    hcFails = 'hc connect exited 1 without a reply'
    clock.advance(60_000)
    const after = await builder.refreshNow()
    expect(after.errors).toEqual(['hc: hc connect exited 1 without a reply'])
    expect(
      after.repos
        .flatMap((r) => r.sessions)
        .map((s) => s.id)
        .sort(),
    ).toEqual(
      before.repos
        .flatMap((r) => r.sessions)
        .map((s) => s.id)
        .sort(),
    )
    expect(after.asks.map((a) => a.id)).toEqual(before.asks.map((a) => a.id))
  })

  test('hc that never answered: no terminals, the factory’s sessions still there', async () => {
    await factoryRows()
    hcFails = 'hc is down'
    const fleet = await builder.refreshNow()
    expect(fleet.errors).toEqual(['hc: hc is down'])
    expect(
      fleet.repos
        .flatMap((r) => r.sessions)
        .map((s) => s.id)
        .sort(),
    ).toEqual(['rb-waits', 'software-factory-w6'])
  })
})

describe('the tick’s kick', () => {
  test('builds in the background at most every 30 s, one at a time', async () => {
    let lists = 0
    terminals = []
    const counting: HcLister = {
      list: async () => {
        lists++
        await Bun.sleep(30)
        return []
      },
    }
    const kicked = new FleetBuilder({
      sql: db.sql,
      now: () => clock.now(),
      roots: [estate.src],
      visibleRoots: [],
      home: '/',
      hc: counting,
      queue,
    })
    kicked.kick()
    kicked.kick() // one is running
    await kicked.settled()
    expect(lists).toBe(1)
    kicked.kick() // built a moment ago
    await kicked.settled()
    expect(lists).toBe(1)
    clock.advance(30_000)
    kicked.kick()
    await kicked.settled()
    expect(lists).toBe(2)
    expect((await get()).builtAt).toBe(clock.now().toISOString())
  })
})

describe('a restart and what a start text names', () => {
  test('a new builder keeps the first-seen time of a factory ask and the since of a terminal', async () => {
    await factoryRows()
    const first = await builder.refreshNow()
    const sinceBefore = first.repos.flatMap((r) => r.sessions).find((s) => s.id === 'prometheus-epx-w1')?.since
    clock.advance(30 * 60_000)
    terminals = terminals.map((t) => ({ ...t, statusAt: clock.now().toISOString() }))
    const restarted = new FleetBuilder({
      sql: db.sql,
      now: () => clock.now(),
      roots: [estate.src],
      visibleRoots: [estate.iu],
      home: estate.src,
      hc,
      queue,
    })
    const second = await restarted.refreshNow()
    expect(second.asks.filter((a) => a.source === 'factory').map((a) => a.at)).toEqual(
      first.asks.filter((a) => a.source === 'factory').map((a) => a.at),
    )
    expect(second.repos.flatMap((r) => r.sessions).find((s) => s.id === 'prometheus-epx-w1')?.since).toBe(sinceBefore)
    expect(second.fingerprint).toBe(first.fingerprint)
  })
})

describe('review follow-ups', () => {
  test('a refresh that cannot build is a 503 build_failed, not a bare 500', async () => {
    const failing = startApp({
      sql: db.sql,
      clock,
      repoRoots: [estate.src],
      fleet: {
        refreshNow: () => Promise.reject(new Error('the database part could not be read')),
      },
    })
    try {
      const res = await failing.send('POST', '/fleet/refresh', {})
      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({ code: 'build_failed' })
    } finally {
      await failing.stop()
    }
  })

  test('concurrent refreshes share one build that has not started; settled waits for it', async () => {
    let lists = 0
    const slow: HcLister = {
      list: async () => {
        lists++
        await Bun.sleep(50)
        return []
      },
    }
    const shared = new FleetBuilder({
      sql: db.sql,
      now: () => clock.now(),
      roots: [estate.src],
      visibleRoots: [],
      home: '/',
      hc: slow,
      queue,
    })
    const first = shared.refreshNow()
    const second = shared.refreshNow()
    expect(second).toBe(first)
    await shared.settled()
    expect(lists).toBe(1)
    await shared.refreshNow()
    expect(lists).toBe(2)
  })

  test('a NUL in free text does not stall the snapshot; the three counts do not overlap', async () => {
    await factoryRows()
    queueAnswer = async () => [{ id: 'n', text: 'a\u0000b', askedAt: '2026-11-02T11:00:00.000Z', state: null }]
    // a session that works while hc already says done
    terminals = terminals.map((t) =>
      t.address === 't1r' ? { ...t, status: 'done' } : { ...t, status: t.address === 't4h' ? 'done' : t.status },
    )
    const built = await builder.refreshNow()
    const fleet = await get()
    expect(built.asks.find((a) => a.id === 'queue:n')).toBeDefined()
    expect(fleet.asks.find((a) => a.id === 'queue:n')?.text).toBe('ab')
    expect(fleet.summary.working + fleet.summary.idle + fleet.summary.done).toBe(
      fleet.repos.flatMap((r) => r.sessions).length,
    )
  })
})

/** A Claude Code terminal of the estate to copy from. */
function aClaudeTerminal(): HcTerminal {
  const found = terminals.find((t) => t.claude)
  if (!found) throw new Error('the estate has no Claude Code terminal')
  return found
}

/** The CLI against the test app. */
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

describe('the lead’s review', () => {
  async function withSocket<T>(run: (socketPath: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync('/tmp/factory-fleet-sock-')
    const socketPath = join(dir, 'h.sock')
    const hooks = serveHooks({
      sql: db.sql,
      clock,
      token: TEST_TOKEN,
      socketPath,
      repoRoots: [estate.src],
      roles: TEST_ROLES,
      slots: 2,
    })
    try {
      return await run(socketPath)
    } finally {
      await hooks.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('a snapshot an older release wrote is not ready, not a 500', async () => {
    await db.sql`
      INSERT INTO factory.fleet_snapshot (id, model, fingerprint, built_at)
      VALUES (1, '{"builtAt":"2026-11-01T00:00:00.000Z","summary":{}}'::jsonb, 'old', ${w.at(10)})`
    expect((await app.get('/fleet')).status).toBe(503)
  })

  test('the socket serves no /fleet: the model holds IuRoot’s text, and what a pane reads goes to its model', async () => {
    await factoryRows()
    await builder.refreshNow()
    await withSocket(async (socketPath) => {
      for (const [method, path] of [
        ['GET', '/fleet'],
        ['POST', '/fleet/refresh'],
        ['GET', '/fleet/refresh'],
      ] as const) {
        const res = await fetch(`http://localhost${path}`, { method, unix: socketPath })
        expect(res.status).toBe(404)
        expect(await res.text()).not.toContain('Teamchat')
      }
    })
  })

  test('B: IuRoot is visible by place, whatever FACTORY_VISIBLE_ROOTS says', async () => {
    await factoryRows()
    const off = new FleetBuilder({
      sql: db.sql,
      now: () => clock.now(),
      roots: [estate.src, estate.iu],
      visibleRoots: [],
      home: '/nonexistent-home',
      hc,
      queue,
    })
    const fleet = await off.refreshNow()
    expect(fleet.repos.filter((r) => r.visible).map((r) => r.name)).toEqual(['prometheus-epx', 'prometheus-scripts'])
    expect(fleet.repos.find((r) => r.name === 'software-factory')?.visible).toBe(false)
  })

  test('1: an hc blocked ask is timed by hc’s status, not the factory session’s state, and waits two minutes', async () => {
    await factoryRows()
    // the lead: the factory says working since 5 min ago; hc says blocked since 1 min ago
    terminals = terminals.map((t) =>
      t.address === 't4h'
        ? {
            ...t,
            status: 'blocked',
            statusMessage: 'Allow Bash?',
            statusAt: new Date(clock.now().getTime() - 60_000).toISOString(),
          }
        : t,
    )
    const young = await builder.refreshNow()
    expect(young.asks.some((a) => a.id === 'hc:software-factory-w6')).toBe(false)
    clock.advance(3 * 60_000)
    const later = await builder.refreshNow()
    const ask = later.asks.find((a) => a.id === 'hc:software-factory-w6')
    expect(ask?.at).toBe(new Date(clock.now().getTime() - 4 * 60_000).toISOString())
    expect(ask?.at).not.toBe(later.repos.flatMap((r) => r.sessions).find((x) => x.id === 'software-factory-w6')?.since)
    // and it stays put
    clock.advance(10 * 60_000)
    expect((await builder.refreshNow()).asks.find((a) => a.id === 'hc:software-factory-w6')?.at).toBe(ask?.at)
  })

  test('1b: an hc blocked ask with no usable time from hc is raised at once, at the first build that saw it', async () => {
    terminals = terminals.map((t) => (t.address === 't4h' ? { ...t, status: 'blocked', statusAt: 'not a time' } : t))
    const first = await builder.refreshNow()
    const ask = first.asks.find((a) => a.id === 'hc:software-factory-w6')
    expect(ask?.at).toBe(clock.now().toISOString())
    clock.advance(20 * 60_000)
    expect((await builder.refreshNow()).asks.find((a) => a.id === 'hc:software-factory-w6')?.at).toBe(ask?.at)
  })

  test('2, 8: a health line keeps its id and its time across builds', async () => {
    await factoryRows()
    const first = await builder.refreshNow()
    clock.advance(45 * 60_000)
    const second = await builder.refreshNow()
    const pick = (f: Fleet) => f.health.map((h) => [h.id, h.since])
    expect(pick(second)).toEqual(pick(first))
    expect(pick(first).length).toBe(2)
  })

  test('4: a session’s directory is matched after realpath', async () => {
    const links = mkdtempSync('/tmp/factory-fleet-links-')
    symlinkSync(estate.src, join(links, 'src'))
    try {
      terminals = [
        ...terminals,
        {
          ...aClaudeTerminal(),
          address: 't9l',
          name: 'via-link',
          cwd: `${links}/src/modelpick`,
          title: 'through a link',
          status: 'working',
          parent: null,
        },
      ]
      const fleet = await builder.refreshNow()
      const repo = fleet.repos.find((r) => r.name === 'modelpick')
      expect(repo?.sessions.map((x) => x.id)).toContain('via-link')
      expect(fleet.unplaced.map((x) => x.id)).not.toContain('via-link')
    } finally {
      rmSync(links, { recursive: true, force: true })
    }
  })

  test('6: a session with no repo is unplaced and not in the summary', async () => {
    mkdirSync(join(estate.src, 'not-a-repo'), { recursive: true })
    terminals = [
      ...terminals,
      {
        ...aClaudeTerminal(),
        address: 't9n',
        name: 'in-a-plain-dir',
        cwd: join(estate.src, 'not-a-repo'),
        status: 'working',
        parent: null,
      },
    ]
    const fleet = await builder.refreshNow()
    expect(fleet.unplaced.map((x) => x.id).sort()).toEqual(['elsewhere', 'in-a-plain-dir'])
    const listed = fleet.repos.flatMap((r) => r.sessions).length
    expect(fleet.summary.working + fleet.summary.idle + fleet.summary.done).toBe(listed)
  })

  test('7: a snapshot that cannot be read at boot is read again by the next build', async () => {
    await factoryRows()
    const first = await builder.refreshNow()
    clock.advance(40 * 60_000)
    const restarted = new FleetBuilder({
      sql: db.sql,
      now: () => clock.now(),
      roots: [estate.src],
      visibleRoots: [estate.iu],
      home: estate.src,
      hc,
      queue,
    })
    await db.sql`ALTER TABLE factory.fleet_snapshot RENAME TO fleet_snapshot_away`
    try {
      await expect(restarted.refreshNow()).rejects.toThrow()
    } finally {
      await db.sql`ALTER TABLE factory.fleet_snapshot_away RENAME TO fleet_snapshot`
    }
    const second = await restarted.refreshNow()
    const factoryAt = (f: Fleet) => f.asks.filter((a) => a.source === 'factory').map((a) => a.at)
    expect(factoryAt(second)).toEqual(factoryAt(first))
  })
})

describe('the fingerprint and NOTIFY', () => {
  test('moves with the model, not with the clock or a session’s last activity', async () => {
    await factoryRows()
    const one = await builder.refreshNow()
    clock.advance(10_000)
    terminals = terminals.map((t) => ({ ...t, statusAt: clock.now().toISOString() }))
    const two = await builder.refreshNow()
    expect(two.builtAt).not.toBe(one.builtAt)
    expect(two.fingerprint).toBe(one.fingerprint)
    queueAnswer = async () => []
    const three = await builder.refreshNow()
    expect(three.fingerprint).not.toBe(one.fingerprint)
  })

  test('a build that changes the model notifies on channel fleet with the fingerprint, an unchanged one does not', async () => {
    const psql = Bun.which('psql', { PATH: `${process.env.PG_BIN_DIR ?? ''}:${process.env.PATH ?? ''}` })
    if (!psql) return // no psql next to initdb: the fingerprint test above still covers the value
    const match = /\.s\.PGSQL\.(\d+)$/.exec(db.path)
    const proc = Bun.spawn(
      [
        psql,
        '-h',
        db.path.replace(/\/\.s\.PGSQL\.\d+$/, ''),
        '-p',
        match?.[1] ?? '',
        '-U',
        'factory',
        '-d',
        'postgres',
        '-X',
        '-q',
        '-A',
        '-t',
      ],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, LC_ALL: 'C' } }, // the notice is matched in English
    )
    void proc.stdin.write('LISTEN fleet;\nSELECT pg_sleep(6);\nSELECT 1;\n')
    void proc.stdin.flush()
    // psql is listening once it sits in its sleep
    for (let i = 0; i < 100; i++) {
      const [sleeping] = await db.sql`SELECT 1 FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep(6)%'`
      if (sleeping) break
      await Bun.sleep(50)
    }
    await factoryRows()
    const first = await builder.refreshNow()
    clock.advance(1_000)
    await builder.refreshNow() // unchanged
    void proc.stdin.end()
    await db.sql`SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE query = 'SELECT pg_sleep(6);' AND pid <> pg_backend_pid()`.catch(
      () => {},
    )
    const [out, err] = await Promise.all([proc.stdout.text(), proc.stderr.text()])
    await proc.exited
    const text = `${out}${err}`
    expect(text.match(/Asynchronous notification "fleet"/g)?.length ?? 0).toBeGreaterThanOrEqual(1)
    expect(text).toContain(`payload "${first.fingerprint}"`)
    expect(text.match(new RegExp(`payload "${first.fingerprint}"`, 'g'))).toHaveLength(1)
  })
})

describe('no model is called', () => {
  test('the builder’s sources never name agw', async () => {
    const sources = await Promise.all(
      ['index.ts', 'model.ts', 'sources.ts', 'store.ts'].map((f) =>
        Bun.file(join(import.meta.dir, '..', 'src', 'fleet', f)).text(),
      ),
    )
    for (const text of sources) expect(text.replace(/agw/gi, 'AGW').match(/AGW/g) ?? []).toEqual([])
  })
})

describe('the human queue reader', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync('/tmp/factory-askhuman-')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const script = (name: string, body: string) => {
    const path = join(dir, name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
    return path
  }

  test('parses the array, in the shape dotfiles prints', async () => {
    const bin = script(
      'ok.sh',
      `[ "$1 $2" = "list --json" ] && printf '%s' '[{"id":"a","text":"hi \\"there\\"\\nline","cmd":null,"askedAt":"2026-11-01T10:00:00Z","ageSeconds":5,"state":"queued"}]'`,
    )
    expect(await new AskHumanQueue(bin).list()).toEqual([
      { id: 'a', text: 'hi "there"\nline', askedAt: '2026-11-01T10:00:00.000Z', state: 'queued' },
    ])
  })

  test('plain text, a failure, a bad shape and a missing script are errors, not crashes', async () => {
    await expect(new AskHumanQueue(script('plain.sh', 'echo "2026 6d text"')).list()).rejects.toThrow(
      'did not print JSON',
    )
    await expect(new AskHumanQueue(script('fail.sh', 'exit 2')).list()).rejects.toThrow('exited 2')
    await expect(new AskHumanQueue(script('shape.sh', `echo '[{"id":1}]'`)).list()).rejects.toThrow(
      'ask-human.sh list --json',
    )
    await expect(new AskHumanQueue(join(dir, 'absent.sh')).list()).rejects.toThrow('does not exist')
  })
})

describe('factory fleet', () => {
  test('json is the contract, plain fits one screen with asks first', async () => {
    await factoryRows()
    await builder.refreshNow()
    const json = await factory(['fleet'])
    expect(json.code).toBe(0)
    expect(Fleet.parse(JSON.parse(json.stdout)).repos).toHaveLength(5)

    const plain = await factory(['fleet', '--format', 'plain'])
    expect(plain.code).toBe(0)
    const lines = plain.stdout.trimEnd().split('\n')
    expect(lines.length).toBeLessThanOrEqual(40)
    expect(lines[0]).toStartWith('FLEET')
    expect(lines[1]).toBe('ASKS')
    expect(lines.indexOf('REPOS')).toBeGreaterThan(lines.indexOf('ASKS'))
    expect(lines).toContain('ISSUES')
    expect(plain.stdout).toContain('queue:20261027T230130-2786')
    const repos = lines.slice(lines.indexOf('REPOS') + 1)
    expect(repos.join('\n')).toContain('software-factory')
    expect(repos.join('\n')).toContain('prometheus-epx (visible)')
  })

  test('--refresh builds now; before any build a plain read is a failure with the reason', async () => {
    const early = await factory(['fleet'])
    expect(early.code).not.toBe(0)
    expect(early.stderr).toContain('not built yet')
    const refreshed = await factory(['fleet', '--refresh'])
    expect(refreshed.code).toBe(0)
    expect(Fleet.parse(JSON.parse(refreshed.stdout)).repos.length).toBeGreaterThan(0)
  })

  test('needs the token: without one it says so and exits 3, also with the socket set', async () => {
    await builder.refreshNow()
    const dir = mkdtempSync('/tmp/factory-fleet-sock-')
    try {
      for (const args of [['fleet'], ['fleet', '--refresh']]) {
        const out = await factory(args, { FACTORY_TOKEN: '', FACTORY_SOCKET: join(dir, 'h.sock') })
        expect(out.code).toBe(3)
        expect(out.stdout).toBe('')
        expect(out.stderr).toContain('FACTORY_TOKEN')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
