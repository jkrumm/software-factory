import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ErrorBody } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { createApp } from '../../src/api/app.ts'
import { deriveSession } from '../../src/domains/leads/session.ts'
import { fixedClock } from '../../src/kernel/clock.ts'
import { healthOf } from '../../src/read/health.ts'
import { createReader } from '../../src/read/reader.ts'

/**
 * The read API through the real app (auth included) over a real Postgres: one ordinary repo (argo, Issue 1) and one work
 * repo (chat, Issue 2) whose text must never reach the read token.
 */
const OWNER = 'owner-token-0123456789'
const READER = 'read-token-0123456789'
const NOW = '2026-11-07T12:00:00.000Z'

let db: TestCluster
let app: ReturnType<typeof createApp>

beforeAll(async () => {
  db = await startTestCluster()
  await db.sql`DROP SCHEMA IF EXISTS factory CASCADE`
  await migrate(db.sql, await loadMigrations())
  const { sql } = db
  await sql`INSERT INTO factory.planning_projects (name, repo, source, project) VALUES ('chat', '/src/chat', 'defaults', '{}')`
  await sql`INSERT INTO factory.planning_projects (name, repo, source, project) VALUES ('argo', '/src/argo', 'file', '{}')`
  for (const [n, repo, state, title] of [
    [1, 'argo', 'working', 'The login page crashes on submit'],
    [2, 'chat', 'waiting', 'The SECRET export of Issue 7 fails'],
  ] as const) {
    await sql`INSERT INTO factory.issues (id, repo, state, wait_reason, version) VALUES (${`issue_${n}`}, ${repo}, ${state}, ${state === 'waiting' ? 'decision' : null}, 1)`
    await sql`
      INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, to_state)
      VALUES (${`event_${n}`}, ${`issue_${n}`}, ${`k${n}`}, 'filed',
        ${{ repo, title, kind: 'bug', origin: 'you' }}, 'factory', ${NOW}, 'applied', 1, 'settling')`
  }
  await sql`
    INSERT INTO factory.intake_signals (id, source, kind, origin, trust, repo, fingerprint, title, text, received_at, state, issue_id)
    VALUES ('signal_1', 'owner:hermes', 'request', 'you', 'owner', 'argo', 'f1', 't', 'Filed from Hermes. Fix the login page so it stops crashing. More.', ${NOW}, 'filed', 'issue_1')`
  await sql`
    INSERT INTO factory.lead_attempts (issue_id, attempt, branch, account, terminal, tab, space, first_try_at, started_at)
    VALUES ('issue_1', 1, 'factory/1-1', 'max1', 'term-1', 'tab-1', '/src/argo', ${NOW}, ${NOW}),
           ('issue_2', 1, 'factory/2-1', 'max1', 'term-2', 'tab-2', '/src/chat', ${NOW}, ${NOW})`
  for (const [n, kind] of [
    [1, 'session_started'],
    [1, 'turn_started'],
    [2, 'session_started'],
  ] as const) {
    await sql`
      INSERT INTO factory.lead_hook_events (key, session, issue_id, attempt, kind, at, received_at)
      VALUES (${`lead-${n}-1:${kind}`}, ${`lead-${n}-1`}, ${`issue_${n}`}, 1, ${kind}, ${NOW}, ${NOW})`
  }
  await sql`
    INSERT INTO factory.decisions (id, key, issue_id, repo, attempt, question, recommendation, checked, options, no_answer, asked_at)
    VALUES ('decision_1', 'dk', 'issue_2', 'chat', 1, 'Drop the SECRET table?', 'yes', 'x',
      '[{"label":"yes","reversible":false,"cost":"c"},{"label":"no","reversible":true,"cost":"c"}]', '{"default":"no"}', ${NOW})`
  await sql`
    INSERT INTO factory.errands (id, key, issue_id, attempt, summary, raised_at)
    VALUES ('errand_1', 'ek', 'issue_1', 1, 'Approve the portal step', ${NOW})`
  await sql`
    INSERT INTO factory.capacity_readings (account, read_at, enabled, auth_ok, five_hour_used, weekly_used, exhausted_until)
    VALUES ('max1', ${NOW}, true, true, 40, 50, '2026-11-07T13:00:00.000Z')`

  const read = createReader({
    sql,
    clock: fixedClock(NOW),
    deriveSession,
    doorLines: async () => ['door source kuma: 4 POSTs refused since 2026-11-07T10:00Z'],
    loops: () => [],
    blockedStreak: 3,
    streamPollMs: 20,
  })
  app = createApp({
    tokens: { owner: OWNER, read: READER },
    health: { read: async () => healthOf({ version: 't', databaseFailure: null, tickAt: null, queueMovedAt: null }) },
    read,
    log: (message) => console.error(message),
  })
})

afterAll(async () => {
  await db.stop()
})

const call = (path: string, token: string | null = OWNER, init: RequestInit = {}) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
    }),
  )

const json = async (path: string, token: string | null = OWNER) => {
  const response = await call(path, token)
  // oxlint-disable-next-line typescript/no-explicit-any -- the test reads fields of answers the contract schemas already guarantee
  return { status: response.status, body: (await response.json()) as any }
}

describe('as the owner', () => {
  test('/v1/issues lists the open cards with the fields clients read', async () => {
    const { status, body } = await json('/v1/issues')
    expect(status).toBe(200)
    expect(body.issues).toHaveLength(2)
    const card = body.issues.find((c: { id: number }) => c.id === 1)
    expect(card).toMatchObject({
      id: 1,
      ref: 'issue_1',
      title: 'The login page crashes on submit',
      about: 'Fix the login page so it stops crashing.',
      state: 'working',
      repo: 'argo',
      repoName: 'argo',
      lead: 'lead-1-1',
      phase: 'building',
      kind: 'bug',
      visible: false,
      waitingOnOwner: true,
      account: 'max1',
    })
    expect(card.summary).toBe('The lead is working on it.')
    expect(card.insights).toMatchObject({ attempts: 1, partial: true })
    expect(typeof card.updatedAt).toBe('string')
    // titles show no id as display text
    expect(body.issues.find((c: { id: number }) => c.id === 2).title).toBe('The SECRET export of an Issue fails')
  })

  test('state=closed is empty and a limit is honoured', async () => {
    expect((await json('/v1/issues?state=closed')).body.issues).toEqual([])
    expect((await json('/v1/issues?limit=1')).body.issues).toHaveLength(1)
    expect((await json('/v1/issues?state=nope')).status).toBe(422)
  })

  test('/v1/issues/{id} accepts issue_1 and 1 and has timeline, asks and sessions', async () => {
    const a = await json('/v1/issues/issue_2')
    const b = await json('/v1/issues/2')
    expect(a.status).toBe(200)
    expect(a.body).toEqual(b.body)
    expect(a.body.timeline[0]).toMatchObject({ kind: 'filed', text: 'Filed.', session: null })
    expect(a.body.asks[0]).toMatchObject({
      question: 'Drop the SECRET table?',
      options: ['yes', 'no'],
      default: 'no',
      answer: null,
    })
    expect(a.body.sessions[0]).toMatchObject({ id: 'lead-2-1', issue: 2, state: 'idle' })
  })

  test('an unknown or malformed Issue is 404 or 400 with an ErrorBody', async () => {
    const missing = await json('/v1/issues/99')
    expect(missing.status).toBe(404)
    expect(ErrorBody.parse(missing.body).code).toBe('not_found')
    expect((await json('/v1/issues/banana')).status).toBe(400)
  })

  test('sessions: by Issue, live only, one by key', async () => {
    const list = await json('/v1/sessions?issue=1&live=1')
    expect(list.body.sessions).toHaveLength(1)
    expect(list.body.sessions[0]).toMatchObject({
      id: 'lead-1-1',
      issue: 1,
      state: 'working',
      status: 'working',
      turn: 1,
      role: 'lead',
      address: 'term-1',
      tab: 'tab-1',
      terminal: { id: 'term-1', name: 'lead-1-1', space: '/src/argo', tab: 'tab-1' },
    })
    expect((await json('/v1/sessions?role=reviewer')).body.sessions).toEqual([])
    expect((await json('/v1/sessions')).body.sessions).toHaveLength(2)
    expect((await json('/v1/sessions/lead-1-1')).body.id).toBe('lead-1-1')
    expect((await json('/v1/sessions/lead-9-1')).status).toBe(404)
  })

  test('asks are Decisions, the human queue is the Errands', async () => {
    const { body } = await json('/v1/asks')
    expect(body.asks).toHaveLength(1)
    expect(body.asks[0]).toMatchObject({
      id: 'decision_1',
      kind: 'decision',
      issue: 2,
      issueRef: 'issue_2',
      stale: false,
      visible: true,
    })
    expect(body.humanQueue).toHaveLength(1)
    expect(body.humanQueue[0]).toMatchObject({
      id: 'errand_1',
      kind: 'errand',
      issue: 1,
      short: 'Approve the portal step',
    })
  })

  test('health holds the door line and the walled account; accounts the reading', async () => {
    const { body } = await json('/v1/health')
    const kinds = body.health.map((line: { kind: string }) => line.kind).sort()
    expect(kinds).toEqual(['account', 'door'])
    const accounts = (await json('/v1/accounts')).body.accounts
    expect(accounts).toEqual([
      {
        account: 'max1',
        fiveHourUsed: 40,
        weeklyUsed: 50,
        fiveHourResetsAt: null,
        weeklyResetsAt: null,
        exhaustedUntil: '2026-11-07T13:00:00.000Z',
        fresh: true,
      },
    ])
  })

  test('/v1/overview carries counts, lists, issues, builtAt, version, now, accounts and queue', async () => {
    const { status, body } = await json('/v1/overview')
    expect(status).toBe(200)
    expect(body).toMatchObject({
      version: 'v1',
      now: NOW,
      builtAt: NOW,
      counts: { working: 1, waiting: 1, queued: 0, watching: 0, asks: 1, humanQueue: 1, health: 2 },
      queue: { effective: 'run', spawns: [] },
    })
    expect(body.issues).toHaveLength(2)
    expect(body.accounts).toHaveLength(1)
  })
})

describe('as the read token', () => {
  test('a work repo loses its words everywhere, the other repo keeps them', async () => {
    for (const path of ['/v1/issues', '/v1/issues/2', '/v1/sessions', '/v1/asks', '/v1/overview']) {
      const text = JSON.stringify((await json(path, READER)).body)
      expect(text).not.toContain('SECRET')
      expect(text).not.toContain('/src/chat')
    }
    const list = (await json('/v1/issues', READER)).body.issues
    expect(list.find((c: { id: number }) => c.id === 2)).toMatchObject({
      title: 'Issue #2',
      repo: 'visible',
      phase: null,
      state: 'waiting',
    })
    expect(list.find((c: { id: number }) => c.id === 1).title).toBe('The login page crashes on submit')
    const asks = (await json('/v1/asks', READER)).body.asks
    expect(asks[0].id).toMatch(/^redacted:/)
    expect(asks[0]).toMatchObject({ issue: 2, kind: 'decision' })
  })

  test('a write is 403, no token is 401', async () => {
    const write = await call('/v1/issues/1/close', READER, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    })
    expect(write.status).toBe(403)
    expect((await call('/v1/issues', null)).status).toBe(401)
  })
})

describe('changes', () => {
  test('without since: no changes and the current cursor; with 0.0: every change; garbage: 410', async () => {
    const none = await json('/v1/changes')
    expect(none.body.changes).toEqual([])
    const all = await json('/v1/changes?since=0.0')
    expect(all.body.changes.length).toBeGreaterThan(5)
    expect(all.body.cursor).toBe(all.body.changes.at(-1).cursor)
    expect(none.body.cursor).toBe(all.body.cursor)
    const again = await json(`/v1/changes?since=${all.body.cursor}`)
    expect(again.body).toEqual({ changes: [], cursor: all.body.cursor })
    const only = await json('/v1/changes?since=0.0&issue=2')
    expect(only.body.changes.every((c: { issue: number }) => c.issue === 2)).toBe(true)
    const garbage = await json('/v1/changes?since=garbage')
    expect(garbage.status).toBe(410)
    expect(ErrorBody.parse(garbage.body).code).toBe('cursor_gone')
    expect((await json('/v1/changes?since=1.99999')).status).toBe(410)
  })

  test('the stream is SSE: hello first, a change after it, 410 for a bad cursor, hidden from the document', async () => {
    const response = await call('/v1/stream')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    if (!response.body) throw new Error('no body')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read()
        if (done) throw new Error(`stream ended before ${needle}: ${text}`)
        text += decoder.decode(value)
      }
    }
    await readUntil('event: hello')
    expect(text).toMatch(/^id: \d+\.\d+\nevent: hello\ndata: \{"version":"v1","cursor":"\d+\.\d+"\}\n\n/)
    await db.sql`INSERT INTO factory.errands (id, key, issue_id, attempt, summary, raised_at) VALUES ('errand_2', 'ek2', 'issue_1', 1, 'x', ${NOW})`
    await readUntil('event: errand')
    expect(text).toMatch(
      /event: errand\ndata: \{"kind":"errand","issue":1,"ref":"issue_1","subject":"raised","detail":\{"errand":"errand_2"\}/,
    )
    await reader.cancel()

    expect((await call('/v1/stream?since=garbage')).status).toBe(410)
    expect((await call('/v1/stream?since=0.0', READER)).status).toBe(200)
  })
})
