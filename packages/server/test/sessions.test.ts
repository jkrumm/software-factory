import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { serveHooks } from '../src/http.ts'
import { startApp, TEST_TOKEN, type TestApp } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

let db: TestDb
let app: TestApp
let clock: FakeClock

beforeAll(async () => {
  db = await startTestDb()
  clock = new FakeClock()
  app = startApp({ sql: db.sql, clock })
})
afterAll(async () => {
  await app.stop()
  await db.stop()
})
beforeEach(() => db.reset())

let n = 0
const emit = (session: string, kind: string, at: string, payload?: object) =>
  app.send('POST', '/events', { key: `k${++n}`, session, kind, at, payload })
const view = async (id: string) => (await app.get(`/sessions/${id}`)).json() as Promise<Record<string, unknown>>

describe('GET /sessions', () => {
  test('lists sessions newest first with their derived state; the dead only with ?all=1', async () => {
    await emit('old', 'session_started', '2026-10-30T09:00:00Z')
    await emit('old', 'session_ended', '2026-10-30T09:30:00Z')
    await emit('a', 'session_started', '2026-10-30T10:00:00Z', { claudeSessionId: 'c-a', transcriptPath: '/t/a.jsonl' })
    await emit('a', 'turn_started', '2026-10-30T10:01:00Z')
    await emit('b', 'session_started', '2026-10-30T11:00:00Z')
    await emit('b', 'turn_started', '2026-10-30T11:01:00Z')
    await emit('b', 'turn_ended', '2026-10-30T11:02:00Z')

    const live = (await (await app.get('/sessions')).json()) as { sessions: { id: string; state: string }[] }
    expect(live.sessions.map((s) => [s.id, s.state])).toEqual([
      ['b', 'idle'],
      ['a', 'working'],
    ])
    const all = (await (await app.get('/sessions?all=1')).json()) as { sessions: { id: string; state: string }[] }
    expect(all.sessions.map((s) => [s.id, s.state])).toEqual([
      ['b', 'idle'],
      ['a', 'working'],
      ['old', 'dead'],
    ])
    expect(live.sessions[1]).toMatchObject({ claudeSessionId: 'c-a', transcriptPath: '/t/a.jsonl', turn: 1 })
  })

  test('needs the token', async () => {
    expect((await app.bare('/sessions')).status).toBe(401)
  })
})

describe('POST /sessions/:id/wait', () => {
  test('declares a wait; the session is waiting once its turn is over, --done ends it', async () => {
    await emit('s', 'session_started', '2026-10-30T10:00:00Z')
    await emit('s', 'turn_started', '2026-10-30T10:01:00Z')

    const declared = await app.send('POST', '/sessions/s/wait', { on: 'workers' })
    expect(declared.status).toBe(200)
    expect(await declared.json()).toMatchObject({ id: 's', state: 'working', wait: 'workers' })

    await emit('s', 'turn_ended', new Date(clock.now().getTime() + 1000).toISOString())
    expect(await view('s')).toMatchObject({ state: 'waiting', wait: 'workers' })

    const cleared = await app.send('POST', '/sessions/s/wait', { done: true })
    expect(await cleared.json()).toMatchObject({ state: 'idle', wait: null })
  })

  test.each([
    ['an unknown target', { on: 'friday' }],
    ['both', { on: 'deploy', done: true }],
    ['neither', {}],
  ])('%s is a 400', async (_name, body) => {
    await emit('s', 'session_started', '2026-10-30T10:00:00Z')
    expect((await app.send('POST', '/sessions/s/wait', body)).status).toBe(400)
  })

  test('an unknown session is a 404 and stores nothing', async () => {
    expect((await app.send('POST', '/sessions/nope/wait', { on: 'owner' })).status).toBe(404)
    expect(await db.sql`SELECT 1 FROM factory.events`).toHaveLength(0)
  })
})

describe('the hooks socket', () => {
  let dir: string
  let socket: string
  let hooks: ReturnType<typeof serveHooks>
  beforeAll(() => {
    dir = mkdtempSync('/tmp/factory-sock-')
    socket = join(dir, 'h.sock')
    hooks = serveHooks({ sql: db.sql, clock, token: TEST_TOKEN, socketPath: socket })
  })
  afterAll(() => {
    hooks.stop(true)
    rmSync(dir, { recursive: true, force: true })
  })
  const post = (path: string, body: unknown, method = 'POST') =>
    fetch(`http://localhost${path}`, {
      unix: socket,
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    })

  test('takes an event with no token: the socket file is the credential', async () => {
    expect(statSync(socket).isSocket()).toBe(true)
    const res = await post('/events', { key: 'h1', session: 's', kind: 'turn_started', at: '2026-10-30T10:00:00Z' })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ duplicate: false })
    expect(
      (await post('/events', { key: 'h1', session: 's', kind: 'turn_started', at: '2026-10-30T10:00:00Z' })).status,
    ).toBe(200)
    expect(await view('s')).toMatchObject({ state: 'working', turn: 1 })
  })

  test('a session declares its wait through the socket too, with no token', async () => {
    await emit('w', 'session_started', '2026-10-30T10:00:00Z')
    const res = await post('/sessions/w/wait', { on: 'deploy' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: 'w', wait: 'deploy', state: 'waiting' })
    expect((await post('/sessions/nope/wait', { on: 'deploy' })).status).toBe(404)
    expect((await post('/sessions/w/wait', { on: 'friday' })).status).toBe(400)
  })

  test('is only the events route: nothing else of the API, and a bad body is a 400', async () => {
    expect((await post('/spawns', { key: 'x' })).status).toBe(404)
    expect((await post('/sessions', {}, 'GET')).status).toBe(404)
    expect((await post('/events', { nope: true })).status).toBe(400)
  })

  test('the real hook binary: spool, post, and the session moves starting → working → idle → dead', async () => {
    const spool = join(dir, 'spool')
    const hook = async (event: string, input: object) => {
      const proc = Bun.spawn(['bun', join(import.meta.dir, '../../cli/bin/factory.ts'), 'hook', event], {
        env: { ...process.env, FACTORY_SESSION: 'real', FACTORY_SPOOL_DIR: spool, FACTORY_SOCKET: socket, HOME: dir },
        stdin: new Response(JSON.stringify(input)),
        stdout: 'ignore',
        stderr: 'ignore',
      })
      expect(await proc.exited).toBe(0)
    }
    await db.sql`INSERT INTO factory.sessions (id, spawn_key, pane, created_at) VALUES ('real', 'real', 'w1:p1', now())`
    expect(await view('real')).toMatchObject({ state: 'starting' })
    await hook('session-start', {
      source: 'startup',
      session_id: 'c-real',
      transcript_path: '/t/real.jsonl',
      cwd: '/w',
    })
    expect(await view('real')).toMatchObject({
      state: 'idle',
      claudeSessionId: 'c-real',
      transcriptPath: '/t/real.jsonl',
    })
    await hook('user-prompt-submit', { session_id: 'c-real' })
    expect(await view('real')).toMatchObject({ state: 'working', turn: 1 })
    await hook('stop', { stop_hook_active: false })
    expect(await view('real')).toMatchObject({ state: 'idle' })
    await hook('session-end', { reason: 'other' })
    expect(await view('real')).toMatchObject({ state: 'dead' })
  })

  test('the TCP API still wants its token', async () => {
    const res = await app.bare('/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(401)
  })
})
