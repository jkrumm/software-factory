/* oxlint-disable typescript/await-thenable -- bun types the `rejects` matchers as void; they return a promise */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Fleet } from '@software-factory/contract'
import { runProcess } from '../src/exec.ts'
import { createIssue } from '../src/issues/create.ts'
import { FleetBuilder } from '../src/fleet/index.ts'
import { GitReader } from '../src/fleet/git.ts'
import { AskHumanQueue, type HcLister, type HcTerminal, type QueueReader } from '../src/fleet/sources.ts'
import { serveHooks } from '../src/http.ts'
import { startApp, TEST_ROLES, TEST_TOKEN, type TestApp } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { buildEstate, type Estate, estateTerminals, makeRepo } from './support/fleet-estate.ts'
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
const processes: string[][] = []

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
  processes.length = 0
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
  const run: typeof runProcess = (cmd, ...rest) => {
    processes.push(cmd)
    return runProcess(cmd, ...rest)
  }
  builder = new FleetBuilder({
    sql: db.sql,
    now: () => clock.now(),
    roots: [estate.src],
    visibleRoots: [estate.iu],
    home: estate.src,
    hc,
    queue,
    git: new GitReader(run),
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
    expect(processes).toHaveLength(0)

    await builder.refreshNow()
    const calls = processes.length
    expect(calls).toBeGreaterThan(0)
    await get()
    await get()
    expect(processes).toHaveLength(calls)
  })

  test('needs the token', async () => {
    expect((await app.bare('/fleet')).status).toBe(401)
  })
})

describe('the estate', () => {
  test('repos: only those with a plan or a live session, git read, IuRoot visible', async () => {
    await factoryRows()
    await builder.refreshNow()
    const fleet = await get()
    expect(fleet.repos.map((r) => r.name)).toEqual([
      'agent-workflows',
      'homelab',
      'linewatch',
      'modelpick',
      'prometheus-epx',
      'prometheus-scripts',
      'rb',
      'software-factory',
    ])
    const by = (name: string) => fleet.repos.find((r) => r.name === name)
    expect(by('dotfiles')).toBeUndefined()
    expect(by('software-factory')).toMatchObject({
      visible: false,
      space: join(estate.src, 'software-factory'),
      git: { branch: 'master', dirty: false, lastCommit: { subject: 'software-factory: the state of the plan' } },
    })
    expect(by('prometheus-scripts')).toMatchObject({ visible: true })
    expect(by('prometheus-epx')).toMatchObject({ visible: true, plan: null })
    expect(by('prometheus-epx')?.git?.lastCommit?.at).toBe('2026-11-01T12:00:00Z')
  })

  test('plans: dated statuses, short comments, states by the proposal', async () => {
    await factoryRows()
    await builder.refreshNow()
    const fleet = await get()
    const plan = (name: string) => fleet.repos.find((r) => r.name === name)?.plan

    // a stale plan: an active wave, eight days untouched, nobody works it
    expect(plan('agent-workflows')).toMatchObject({
      state: 'stale',
      title: 'agent-workflows: the gateway',
      goal: 'one gateway for every model call.',
    })
    expect(plan('agent-workflows')?.waves.slice(0, 2)).toEqual([
      {
        n: 1,
        title: 'Gateway spike and registry',
        short: null,
        status: 'done',
        statusDate: '2026-11-01',
        statusText: 'release 767f643',
      },
      { n: 2, title: 'Gateway', short: null, status: 'done', statusDate: '2026-11-02', statusText: 'release b25aac5' },
    ])
    expect(plan('agent-workflows')?.lastTouched).toBe('2026-10-25T12:00:00Z')
    expect(plan('homelab')?.state).toBe('done')
    expect(plan('modelpick')?.state).toBe('planned')
    expect(plan('linewatch')?.state).toBe('scheduled')
    expect(plan('linewatch')?.waves[0]).toMatchObject({
      status: 'scheduled',
      statusDate: '2099-01-01',
      statusText: "the owner's call",
    })

    // a visible repo's short is the title cut at 8 words; a repo of the factory's own has none until the digest
    const teamchat = plan('prometheus-scripts')
    expect(teamchat).toMatchObject({ state: 'running', title: 'Teamchat: Wave 62 and on' })
    expect(teamchat?.path).toBe(join(estate.iu, 'prometheus-scripts/wip/waves-teamchat/docs/waves/PLAN.md'))
    expect(teamchat?.waves[0]?.short).toBe('Channel pinning and the long running migration of…')
    expect(plan('modelpick')?.waves[0]?.short).toBeNull()
  })

  test('the plan a live spawn names beside the repo plan; the Never clause is not a plan', async () => {
    await factoryRows()
    await builder.refreshNow()
    const sf = (await get()).repos.find((r) => r.name === 'software-factory')
    // the lead works PLAN.md (found from its directory), the worker fv.md (its start text names it, not the file under Never)
    expect(sf?.plan).toMatchObject({ state: 'running', title: 'Software factory: the program plan' })
    expect(sf?.plan?.waves.find((x) => x.n === 6)).toMatchObject({ short: 'The night run', status: 'active' })
    expect(sf?.morePlans).toHaveLength(1)
    expect(sf?.morePlans[0]).toMatchObject({ state: 'running', title: 'FV: the fleet view' })
    const worker = sf?.sessions.find((s) => s.terminal === 't7d')
    expect(worker).toMatchObject({
      plan: join(estate.src, 'software-factory/docs/waves/fv.md'),
      wave: 1,
      parent: 'software-factory-w6',
    })
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
    expect(ids.filter((id) => id.startsWith('factory:'))).toHaveLength(2)
    const by = (id: string) => fleet.asks.find((a) => a.id === id)
    expect(by('hc:prometheus-epx-w1')).toMatchObject({
      kind: 'permission',
      source: 'hc',
      session: 'prometheus-epx-w1',
      text: 'Allow Bash(rm -rf node_modules)?',
      repo: join(estate.iu, 'prometheus-epx'),
      short: null,
      suggestion: null,
      actions: [],
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
    const factory = fleet.asks.filter((a) => a.source === 'factory')
    expect(factory.map((a) => a.id).sort()).toEqual(['factory:notification:notify:failed:x', 'factory:spawn:lw-fix'])
    expect(factory.map((a) => a.text).sort()).toEqual([
      'notification notify:failed:x was not delivered: Hermes did not answer',
      'spawn lw-fix failed: the pane never came up',
    ])
    expect(factory.find((a) => a.text?.startsWith('spawn'))).toMatchObject({
      kind: 'blocker',
      repo: join(estate.src, 'linewatch'),
    })
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
    expect(fleet.repos).toHaveLength(8)
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

  test('a plan that cannot be read leaves the last text with an errors line', async () => {
    await factoryRows()
    const before = await builder.refreshNow()
    const path = join(estate.src, 'modelpick/docs/waves/PLAN.md')
    const { chmodSync } = await import('node:fs')
    chmodSync(path, 0o000)
    try {
      const after = await builder.refreshNow()
      if (process.getuid?.() === 0) return // root reads it anyway
      expect(after.errors[0]).toStartWith('plan modelpick/docs/waves/PLAN.md:')
      expect(after.repos.find((r) => r.name === 'modelpick')?.plan).toEqual(
        before.repos.find((r) => r.name === 'modelpick')?.plan,
      )
    } finally {
      chmodSync(path, 0o644)
    }
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

  test('a plan path outside the roots, or a file that is not a plan, is not followed', async () => {
    terminals = terminals.map((t) =>
      t.address === 't7d'
        ? {
            ...t,
            prompt: `Read /etc/passwd and ${estate.src}/../outside/docs/waves/x.md and ~/../../etc/docs/waves/y.md ${'z'.repeat(80)}`,
          }
        : t,
    )
    await factoryRows()
    const fleet = await builder.refreshNow()
    const worker = fleet.repos.flatMap((r) => r.sessions).find((s) => s.terminal === 't7d')
    // nothing named counts; its directory is a worktree of the factory's checkout, so the repo's PLAN.md is its plan
    expect(worker?.plan).toBe(join(estate.src, 'software-factory/docs/waves/PLAN.md'))
  })
})

describe('review follow-ups', () => {
  test('a root that cannot be listed is an errors line, not a silent loss', async () => {
    await factoryRows()
    await builder.refreshNow()
    chmodSync(estate.src, 0o000)
    try {
      if (process.getuid?.() === 0) return
      const after = await builder.refreshNow()
      expect(after.errors.some((e) => e.startsWith(`repos ${estate.src}:`))).toBe(true)
      // the IuRoot repos are another root's: they stand
      expect(after.repos.some((r) => r.name === 'prometheus-scripts')).toBe(true)
    } finally {
      chmodSync(estate.src, 0o755)
    }
  })

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
  const viaSocket = async (socketPath: string) =>
    Fleet.parse(await (await fetch('http://localhost/fleet', { unix: socketPath })).json())

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

  test('A: the socket’s view keeps only deterministic fields of a visible repo; the token API has everything', async () => {
    await factoryRows()
    await builder.refreshNow()
    const full = await get()
    expect(full.redacted).toBe(false)
    const teamchat = full.repos.find((r) => r.name === 'prometheus-scripts')
    expect(teamchat?.plan?.title).toBe('Teamchat: Wave 62 and on')

    await withSocket(async (socketPath) => {
      const view = await viaSocket(socketPath)
      expect(view.redacted).toBe(true)
      const iu = view.repos.find((r) => r.name === 'prometheus-scripts')
      expect(iu).toMatchObject({
        visible: true,
        git: { branch: 'master', dirty: false, lastCommit: { subject: null } },
        plan: { state: 'running', title: null, short: null, goal: null, sha: teamchat?.plan?.sha },
        sessions: [{ id: 'athena-orchestrator', state: 'working', title: null, headline: null, visible: true }],
      })
      expect(iu?.plan?.waves[0]).toMatchObject({ n: 62, title: null, short: null, statusText: null, status: 'active' })
      expect(iu?.git?.lastCommit?.sha).toBeTruthy()
      // an ask about a visible session: id, kind and time stay, the text goes
      expect(view.asks.find((a) => a.id === 'hc:prometheus-epx-w1')).toMatchObject({ kind: 'permission', text: null })
      // everything else is whole
      expect(view.repos.find((r) => r.name === 'software-factory')?.plan?.title).toBe(
        'Software factory: the program plan',
      )
      expect(view.asks.find((a) => a.id === 'queue:20261027T230130-2786')?.text).toContain('LoA status')
      expect(JSON.stringify(view)).not.toContain('Teamchat')
      expect(JSON.stringify(view)).not.toContain('Channel pinning')
      expect(JSON.stringify(view)).not.toContain('rm -rf node_modules')
      expect(JSON.stringify(view)).not.toContain('EPX Wave 1')
      expect(view.summary).toEqual(full.summary)
      expect(view.fingerprint).toBe(full.fingerprint)

      // the CLI says which one it got
      const out = await factory(['fleet', '--format', 'plain'], { FACTORY_TOKEN: '', FACTORY_SOCKET: socketPath })
      expect(out.stdout.split('\n')[0]).toStartWith('VIEW\tsocket')
      expect(
        JSON.parse((await factory(['fleet'], { FACTORY_TOKEN: '', FACTORY_SOCKET: socketPath })).stdout).redacted,
      ).toBe(true)
    })
    // the stored model is untouched
    expect((await get()).repos.find((r) => r.name === 'prometheus-scripts')?.plan?.title).toBe(
      'Teamchat: Wave 62 and on',
    )
  })

  test('A2: an ask about an IuRoot repo that has no plan and no session is redacted too, and so is a spawn’s error', async () => {
    const quiet = makeRepo(estate.iu, 'quiet-repo', { 'README.md': 'nothing here\n' }, 1, NOW)
    const { issue } = await createIssue(
      db.sql,
      { source: 'request', sourceKey: 'iu1', repo: quiet, title: 'Secret IuRoot title', facts: {} },
      { repoRoots: [estate.src, estate.iu], now: clock.now() },
    )
    await db.sql`
      INSERT INTO factory.decisions (issue_id, key, question, created_at)
      VALUES (${issue.id}, 'iu1:dec', 'Ship the secret IuRoot migration?', ${w.at(30)})`
    await db.sql`
      INSERT INTO factory.spawns (key, repo, prompt, role, tier, effort, status, error, created_at)
      VALUES ('iu-fix', ${quiet}, 'p', 'worker', 'sonnet', 'high', 'failed', 'secret IuRoot failure detail', ${w.at(20)})`
    const wide = new FleetBuilder({
      sql: db.sql,
      now: () => clock.now(),
      roots: [estate.src, estate.iu],
      visibleRoots: [],
      home: '/nonexistent-home',
      hc,
      queue,
    })
    await wide.refreshNow()
    const full = await get()
    expect(full.repos.map((r) => r.name)).not.toContain('quiet-repo')
    expect(full.asks.find((a) => a.id === 'decision:iu1:dec')).toMatchObject({ visible: true, repo: quiet })
    await withSocket(async (socketPath) => {
      const view = await viaSocket(socketPath)
      expect(view.asks.find((a) => a.id === 'decision:iu1:dec')).toMatchObject({ kind: 'question', text: null })
      expect(view.asks.find((a) => a.id === 'factory:spawn:iu-fix')).toMatchObject({ text: null })
      expect(view.queue.spawns.find((x) => x.key === 'iu-fix')).toMatchObject({ status: 'failed', error: null })
      expect(JSON.stringify(view)).not.toContain('secret IuRoot')
      // an ordinary repo's ask is whole
      expect(view.asks.find((a) => a.id === 'queue:20261027T230130-2786')?.text).toContain('LoA')
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
    expect(fleet.repos.flatMap((r) => r.sessions).find((x) => x.id === 'athena-orchestrator')?.visible).toBe(true)
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

  test('2, 8: an attention line keeps its id and its time across builds', async () => {
    await factoryRows()
    const first = await builder.refreshNow()
    clock.advance(45 * 60_000)
    const second = await builder.refreshNow()
    const pick = (f: Fleet) => f.asks.filter((a) => a.source === 'factory').map((a) => [a.id, a.at])
    expect(pick(second)).toEqual(pick(first))
    expect(pick(first).length).toBe(2)
  })

  test('3: errors come in repo path order, run after run', async () => {
    await factoryRows()
    const failing: typeof runProcess = async (cmd) => {
      await Bun.sleep(Math.floor(Math.random() * 20))
      return cmd.includes('log') || cmd.includes('status') ? { exitCode: 128, stdout: '' } : { exitCode: 0, stdout: '' }
    }
    const flaky = new FleetBuilder({
      sql: db.sql,
      now: () => clock.now(),
      roots: [estate.src],
      visibleRoots: [estate.iu],
      home: estate.src,
      hc,
      queue,
      git: new GitReader(failing),
    })
    const gitErrors = async () => (await flaky.refreshNow()).errors.filter((e) => e.startsWith('git '))
    const first = await gitErrors()
    expect(first).toHaveLength(8)
    const paths = (await get()).repos.map((r) => r.space).sort()
    expect(first.map((e) => e.split(':')[0])).toEqual(paths.map((p) => `git ${p.split('/').at(-1)}`))
    for (let i = 0; i < 3; i++) expect(await gitErrors()).toEqual(first)
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
      expect(repo?.plan?.state).toBe('running')
      expect(fleet.unplaced.map((x) => x.id)).not.toContain('via-link')
    } finally {
      rmSync(links, { recursive: true, force: true })
    }
  })

  test('5: an idle or done tab does not make a plan run; a working one does', async () => {
    const fleet = await builder.refreshNow()
    expect(fleet.repos.find((r) => r.name === 'modelpick')).toMatchObject({
      plan: { state: 'planned' },
      sessions: [{ id: 'modelpick-idle', hc: 'done' }],
    })
    terminals = terminals.map((t) => (t.address === 't8m' ? { ...t, status: 'working' } : t))
    expect((await builder.refreshNow()).repos.find((r) => r.name === 'modelpick')?.plan?.state).toBe('running')
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

  test('9: a plan heading that does not parse is an errors line with its line number', async () => {
    const path = join(estate.src, 'modelpick/docs/waves/PLAN.md')
    const original = await Bun.file(path).text()
    writeFileSync(path, `${original}\r\n## Wave — nothing numbered\r\n`)
    try {
      const fleet = await builder.refreshNow()
      const lines = original.split('\n').length + 1
      expect(fleet.errors).toContain(
        `plan modelpick/docs/waves/PLAN.md: line ${lines} starts with "## Wave" but has no wave number`,
      )
      expect(fleet.repos.find((r) => r.name === 'modelpick')?.plan?.waves).toHaveLength(1)
    } finally {
      writeFileSync(path, original)
    }
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
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
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
  test('the builder runs git and nothing else, and its sources never name agw', async () => {
    await factoryRows()
    await builder.refreshNow()
    expect(processes.length).toBeGreaterThan(0)
    expect(processes.every((p) => p[0] === 'git')).toBe(true)
    const sources = await Promise.all(
      ['index.ts', 'model.ts', 'plans.ts', 'sources.ts', 'git.ts', 'store.ts'].map((f) =>
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
    expect(Fleet.parse(JSON.parse(json.stdout)).repos).toHaveLength(8)

    const plain = await factory(['fleet', '--format', 'plain'])
    expect(plain.code).toBe(0)
    const lines = plain.stdout.trimEnd().split('\n')
    expect(lines.length).toBeLessThanOrEqual(40)
    expect(lines[0]).toStartWith('FLEET')
    expect(lines[1]).toBe('ASKS')
    expect(lines.indexOf('REPOS')).toBeGreaterThan(lines.indexOf('ASKS'))
    expect(plain.stdout).toContain('queue:20261027T230130-2786')
    // repos with a running plan: the factory's, the teamchat's; not the stale or the planned
    const repos = lines.slice(lines.indexOf('REPOS') + 1)
    expect(repos.join('\n')).toContain('software-factory')
    expect(repos.join('\n')).toContain('prometheus-scripts (visible)')
    expect(repos.join('\n')).not.toContain('agent-workflows')
  })

  test('--refresh builds now; before any build a plain read is a failure with the reason', async () => {
    const early = await factory(['fleet'])
    expect(early.code).not.toBe(0)
    expect(early.stderr).toContain('not built yet')
    const refreshed = await factory(['fleet', '--refresh'])
    expect(refreshed.code).toBe(0)
    expect(Fleet.parse(JSON.parse(refreshed.stdout)).repos.length).toBeGreaterThan(0)
  })

  test('through the socket, as a session reads it', async () => {
    await builder.refreshNow()
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
      const out = await factory(['fleet'], { FACTORY_TOKEN: '', FACTORY_SOCKET: socketPath })
      expect(out.code).toBe(0)
      expect(Fleet.parse(JSON.parse(out.stdout)).summary.asks).toBeGreaterThan(0)
    } finally {
      await hooks.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
