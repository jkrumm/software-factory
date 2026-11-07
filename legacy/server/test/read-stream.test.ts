/* oxlint-disable typescript/await-thenable -- bun types the `rejects` matchers as void; they return a promise */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Fleet } from '@software-factory/contract'
import { writeSnapshot } from '../src/fleet/store.ts'
import { createIssue } from '../src/issues/create.ts'
import { logEvent } from '../src/issues/shared.ts'
import { openSession } from '../src/sessions.ts'
import { Reader } from '../src/read/index.ts'
import { CursorGone, frames, formatCursor, parseCursor, startCursor, type StreamDeps } from '../src/read/stream.ts'
import { startApp, TEST_REPO, TEST_ROOT, TEST_TOKEN, type TestApp } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'
import { world } from './support/world.ts'

const NOW = new Date('2026-11-06T12:00:00.000Z')

let db: TestDb
let clock: FakeClock
let w: ReturnType<typeof world>

beforeAll(async () => {
  db = await startTestDb()
})
afterAll(() => db.stop())
beforeEach(async () => {
  await db.reset()
  clock = new FakeClock(NOW)
  w = world(db.sql, clock)
})

/** The wait between two polls, under the test's control: `release` lets one poll through (a release made early is kept). */
class Gate {
  credit = 0
  waiting: (() => void) | undefined
  waits = 0
  sleep = (_ms: number, signal: AbortSignal): Promise<void> => {
    this.waits++
    if (this.credit > 0 || signal.aborted) {
      this.credit = Math.max(0, this.credit - 1)
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.waiting = resolve
      signal.addEventListener('abort', () => resolve())
    })
  }
  /** resolves once the stream is parked in its `n`th wait: whatever is stored from here on is for the next poll */
  async parked(n = this.waits + 0): Promise<void> {
    for (let i = 0; i < 400 && !(this.waiting && this.waits >= n); i++) await Bun.sleep(5)
    if (!this.waiting) throw new Error('the stream never parked')
  }
  release(): void {
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = undefined
      resolve()
    } else this.credit++
  }
}

interface Parsed {
  id: string | null
  event: string | null
  data: unknown
  comment: string | null
}

function parse(chunk: string): Parsed {
  const out: Parsed = { id: null, event: null, data: null, comment: null }
  for (const line of chunk.split('\n')) {
    if (line.startsWith('id: ')) out.id = line.slice(4)
    else if (line.startsWith('event: ')) out.event = line.slice(7)
    else if (line.startsWith('data: ')) out.data = JSON.parse(line.slice(6))
    else if (line.startsWith(': ')) out.comment = line.slice(2)
  }
  return out
}

function follow(options: { start: Awaited<ReturnType<typeof startCursor>>; issue?: number }) {
  const gate = new Gate()
  const abort = new AbortController()
  const deps: StreamDeps = {
    sql: db.sql,
    clock,
    reader: new Reader({ sql: db.sql, clock }),
    sleep: gate.sleep,
  }
  const it = frames(deps, options.start, {
    ...(options.issue === undefined ? {} : { issue: options.issue }),
    signal: abort.signal,
  })
  const next = async (): Promise<Parsed> => {
    const result = await it.next()
    if (result.done) throw new Error('the stream ended')
    return parse(result.value)
  }
  return { gate, abort, it, next }
}

const file = (key: string, at: Date) =>
  createIssue(
    db.sql,
    { source: 'request', sourceKey: key, repo: TEST_REPO, title: key, facts: {} },
    { repoRoots: [TEST_ROOT], now: at },
  ).then((r) => r.issue.id)

const issueEvent = (
  issueId: number,
  kind: string,
  minute: number,
  payload: Record<string, unknown> = {},
  to: string | null = null,
) =>
  logEvent(
    db.sql,
    {
      issueId,
      key: `${kind}:${issueId}:${minute}`,
      kind,
      from: null,
      to: to as never,
      at: new Date(NOW.getTime() + minute * 60_000),
    },
    payload,
  )

describe('cursor', () => {
  test('parses what it formats and nothing else', () => {
    expect(parseCursor(formatCursor({ issue: 12, session: 7 }))).toEqual({ issue: 12, session: 7 })
    for (const bad of ['', 'i1', 'i1.s', 'x1.s2', 'i1.s2.', 'i-1.s2', '12', 'i1.s2 '])
      expect(parseCursor(bad)).toBeNull()
  })

  test('no cursor starts at now; a cursor ahead of the tables is gone', async () => {
    const id = await file('a', NOW)
    await w.emit('s1', 'turn_started', NOW)
    const head = await startCursor(db.sql, null)
    expect(head.issue).toBeGreaterThanOrEqual(1)
    expect(head.session).toBeGreaterThanOrEqual(1)
    expect(await startCursor(db.sql, formatCursor(head))).toEqual(head)
    await expect(startCursor(db.sql, formatCursor({ issue: head.issue + 1, session: 0 }))).rejects.toBeInstanceOf(
      CursorGone,
    )
    await expect(startCursor(db.sql, 'garbage')).rejects.toBeInstanceOf(CursorGone)
    expect(id).toBeGreaterThan(0)
  })
})

describe('frames', () => {
  test('follows an Issue from filed to closed, in order, with events landing between polls', async () => {
    const stream = follow({ start: await startCursor(db.sql, null) })
    const hello = await stream.next()
    expect(hello).toMatchObject({ event: 'hello', data: { version: 'v1', cursor: hello.id } })

    const issue = await file('flow', NOW)
    const first = await stream.next()
    expect(first).toMatchObject({
      event: 'issue',
      data: { issue, kind: 'created', to: 'queued', text: 'Filed and queued.' },
    })

    // the stream is now waiting for its next poll; the events land meanwhile
    const pending = stream.next()
    await stream.gate.parked(1)
    await issueEvent(issue, 'admitted', 1, { attempt: 1 }, 'working')
    await issueEvent(issue, 'phase', 2, { phase: 'implementing', attempt: 1 })
    await issueEvent(issue, 'close', 3, { summary: 'Done and proven.' }, 'closed')
    stream.gate.release()
    const seen = [await pending, await stream.next(), await stream.next()]
    expect(seen.map((f) => (f.data as { kind: string }).kind)).toEqual(['admitted', 'phase', 'close'])
    expect(seen.map((f) => (f.data as { text: string }).text)).toEqual([
      'A lead was started.',
      'The lead moved on: implementing',
      'Closed as done: Done and proven.',
    ])
    // every frame carries a cursor, each one further along
    const ids = [first, ...seen].map((f) => parseCursor(f.id ?? '')?.issue ?? 0)
    expect([...ids].sort((a, b) => a - b)).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)

    stream.abort.abort()
    expect((await stream.it.next()).done).toBe(true)
  })

  test('a client that reconnects with its last cursor loses nothing and repeats nothing', async () => {
    const issue = await file('resume', NOW)
    const start = await startCursor(db.sql, null)
    await issueEvent(issue, 'admitted', 1, { attempt: 1 }, 'working')
    await issueEvent(issue, 'phase', 2, { phase: 'one', attempt: 1 })
    await w.emit('s1', 'turn_started', new Date(NOW.getTime() + 90_000))
    await issueEvent(issue, 'phase', 3, { phase: 'two', attempt: 1 })

    const a = follow({ start })
    await a.next()
    const got: Parsed[] = []
    for (let i = 0; i < 2; i++) got.push(await a.next())
    // the client drops after two frames
    a.abort.abort()

    const resumed = follow({ start: await startCursor(db.sql, got[1]?.id ?? null) })
    await resumed.next() // hello
    await issueEvent(issue, 'phase', 4, { phase: 'three', attempt: 1 })
    for (let i = 0; i < 3; i++) got.push(await resumed.next())

    const label = (f: Parsed) => (f.event === 'session' ? 'session' : (f.data as { kind: string; text: string }).text)
    expect(got.map(label)).toEqual([
      'A lead was started.',
      'session',
      'The lead moved on: one',
      'The lead moved on: two',
      'The lead moved on: three',
    ])
    // a last cursor read at the very end resumes with nothing to repeat
    const last = got.at(-1)?.id ?? null
    const quiet = follow({ start: await startCursor(db.sql, last) })
    await quiet.next()
    const waiting = quiet.next()
    await quiet.gate.parked(1)
    clock.advance(15_000)
    quiet.gate.release()
    expect((await waiting).comment).toBe('keepalive')
    quiet.abort.abort()
  })

  test('session frames carry the state; the _runner is not a session', async () => {
    const start = await startCursor(db.sql, null)
    await w.spawned('worker-1', { startedMinutesAgo: 30 })
    await w.emit('_runner', 'runner_restarted', NOW)
    await w.emit('worker-1', 'turn_started', new Date(NOW.getTime() + 1000))
    const stream = follow({ start })
    await stream.next()
    const frames = [await stream.next(), await stream.next()]
    expect(frames.map((f) => (f.data as { kind: string }).kind)).toEqual(['session_started', 'turn_started'])
    expect(frames[1]).toMatchObject({ event: 'session', data: { session: 'worker-1', issue: null, state: 'working' } })
    stream.abort.abort()
  })

  test('?issue= keeps that Issue and the sessions of its tree', async () => {
    const mine = await file('mine', NOW)
    const other = await file('other', NOW)
    const start = await startCursor(db.sql, null)
    const lead = `lead-${mine}-1`
    await db.sql`
      INSERT INTO factory.spawns (key, repo, prompt, role, tier, effort, status, account, assigned_at, session, created_at, issue_id)
      VALUES (${lead}, ${TEST_REPO}, 'work', 'lead', 'sonnet', 'high', 'started', 'a', ${NOW}, 'w1:p1', ${NOW}, ${mine})`
    await openSession(db.sql, { id: lead, spawnKey: lead, pane: 'w1:p1', issueId: mine, at: NOW })
    await w.spawned('stranger', { startedMinutesAgo: 5 })
    await issueEvent(other, 'phase', 1, { phase: 'not mine', attempt: 1 })
    await issueEvent(mine, 'phase', 2, { phase: 'mine', attempt: 1 })
    await w.emit('stranger', 'turn_started', new Date(NOW.getTime() + 2000))
    await w.emit(lead, 'turn_started', new Date(NOW.getTime() + 3000))

    const stream = follow({ start, issue: mine })
    await stream.next()
    const got = [await stream.next(), await stream.next()]
    // by time: the lead's turn came before the phase
    expect(got.map((f) => f.event)).toEqual(['session', 'issue'])
    expect(got[0]?.data).toMatchObject({ session: lead, issue: mine })
    expect(got[1]?.data).toMatchObject({ issue: mine, text: 'The lead moved on: mine' })
    stream.abort.abort()
  })

  test('a moved snapshot is a fleet frame; the first one it sees is not', async () => {
    const snap = (fingerprint: string) =>
      Fleet.parse({
        builtAt: NOW.toISOString(),
        fingerprint,
        summary: { working: 0, idle: 0, done: 0, asks: 0, staleAsks: 0 },
        asks: [],
        repos: [],
        unplaced: [],
        errors: [],
        quota: [],
        queue: { effective: 'run', spawns: [] },
      })
    await writeSnapshot(db.sql, snap('one'))
    const stream = follow({ start: await startCursor(db.sql, null) })
    await stream.next()
    const pending = stream.next()
    await stream.gate.parked(1)
    await writeSnapshot(db.sql, snap('two'))
    stream.gate.release()
    expect(await pending).toMatchObject({ event: 'fleet', data: { fingerprint: 'two', builtAt: NOW.toISOString() } })
    stream.abort.abort()
  })

  test('a keepalive comes when nothing was written for the keepalive time, and a quiet poll writes nothing', async () => {
    const stream = follow({ start: await startCursor(db.sql, null) })
    await stream.next()
    const pending = stream.next()
    await stream.gate.parked(1)
    // a poll with nothing new and no time passed: no frame, the stream waits again
    stream.gate.release()
    await stream.gate.parked(2)
    clock.advance(15_000)
    stream.gate.release()
    expect((await pending).comment).toBe('keepalive')
    stream.abort.abort()
  })

  test('a client that goes away ends the stream and leaves nothing waiting', async () => {
    const stream = follow({ start: await startCursor(db.sql, null) })
    await stream.next()
    const pending = stream.next()
    await stream.gate.parked(1)
    stream.abort.abort()
    await expect(pending).rejects.toThrow('the stream ended')
    expect((await stream.it.next()).done).toBe(true)
  })
})

describe('GET /v1/stream', () => {
  let app: TestApp
  beforeEach(async () => {
    await app?.stop()
    app = startApp({ sql: db.sql, clock, read: { pollMs: 20, keepaliveMs: 60_000 } })
  })
  afterAll(() => app?.stop())

  test('a malformed or unknown cursor is 410, in the query and in Last-Event-ID', async () => {
    const auth = { authorization: `Bearer ${TEST_TOKEN}` }
    for (const path of ['/v1/stream?since=garbage', '/v1/stream?since=i99999.s0', '/v1/stream?since=i0.s99999']) {
      const res = await app.get(path)
      expect(res.status).toBe(410)
      expect(await res.json()).toMatchObject({ code: 'gone' })
    }
    const res = await fetch(new URL('/v1/stream', app.url), { headers: { ...auth, 'last-event-id': 'nonsense' } })
    expect(res.status).toBe(410)
    expect((await app.get('/v1/stream?issue=abc')).status).toBe(400)
    expect((await app.bare('/v1/stream')).status).toBe(401)
  })

  test('streams hello, then an event that lands, and stops when the client cancels', async () => {
    const issue = await file('live', NOW)
    const res = await app.get('/v1/stream')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body?.getReader()
    if (!reader) throw new Error('no body')
    const decoder = new TextDecoder()
    let text = ''
    const until = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read()
        if (done) throw new Error(`the stream ended before ${needle}`)
        text += decoder.decode(value)
      }
    }
    await until('event: hello')
    await issueEvent(issue, 'phase', 1, { phase: 'live', attempt: 1 })
    await until('The lead moved on: live')
    await reader.cancel()
  })
})
