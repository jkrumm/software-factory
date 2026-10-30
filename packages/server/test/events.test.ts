import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { type DeriveInput, deriveState, type EventKind, type Fact, type Witnessed } from '../src/sessions.ts'
import { startApp, type TestApp } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

let db: TestDb
let app: TestApp

beforeAll(async () => {
  db = await startTestDb()
  app = startApp({ sql: db.sql, clock: new FakeClock() })
})
afterAll(async () => {
  await app.stop()
  await db.stop()
})
beforeEach(() => db.reset())

let counter = 0
async function emit(session: string, kind: EventKind, at: string, key = `k${++counter}`): Promise<Response> {
  return app.send('POST', '/events', { key, session, kind, at })
}
const stateOf = async (session: string) =>
  ((await (await app.get(`/sessions/${session}`)).json()) as { state: string }).state

describe('duplicate event key', () => {
  test('changes nothing and answers 200 { duplicate: true }', async () => {
    const first = await emit('s1', 'session_started', '2026-10-30T10:00:00Z', 'same')
    expect(first.status).toBe(201)
    expect(await first.json()).toEqual({ duplicate: false })

    // Same key, different content: must be ignored entirely.
    const again = await emit('s1', 'session_ended', '2026-10-30T11:00:00Z', 'same')
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ duplicate: true })

    const [{ count }] = await db.sql`SELECT count(*)::int AS count FROM factory.events`
    expect(count).toBe(1)
    expect(await stateOf('s1')).toBe('idle')
  })
})

const T = (minute: number) => new Date(Date.UTC(2026, 9, 30, 10, minute))
const NOW = T(300)
const facts = (...entries: [EventKind, number, string?][]): Fact[] =>
  entries.map(([kind, minute, detail]) => ({ kind, at: T(minute), detail }))
const derive = (f: Fact[], extra: Partial<DeriveInput> = {}) =>
  deriveState({ facts: f, known: true, now: NOW, ...extra })?.state

describe('derived session state', () => {
  test('starting: the factory has the session, no hook has spoken', () => {
    expect(derive([])).toBe('starting')
    expect(deriveState({ facts: [], known: false, now: NOW })).toBeUndefined()
  })

  test('working: latest turn_started has no turn_ended after it', () => {
    expect(derive(facts(['session_started', 0], ['turn_started', 1]))).toBe('working')
  })

  test('idle: the turn ended, and a started session with no turn yet is idle too', () => {
    expect(derive(facts(['session_started', 0], ['turn_started', 1], ['turn_ended', 2]))).toBe('idle')
    expect(derive(facts(['session_started', 0]))).toBe('idle')
    expect(derive(facts(['session_started', 0], ['turn_started', 1], ['turn_ended', 2], ['prompt_idle', 3]))).toBe(
      'idle',
    )
  })

  test('waiting: a declared wait is open once the turn is over, and --done closes it', () => {
    const declared = facts(['session_started', 0], ['turn_started', 1], ['wait_declared', 2, 'workers'])
    expect(derive(declared)).toBe('working')
    const ended = [...declared, ...facts(['turn_ended', 3])]
    expect(deriveState({ facts: ended, known: true, now: NOW })).toMatchObject({ state: 'waiting', wait: 'workers' })
    expect(derive([...ended, ...facts(['wait_cleared', 4])])).toBe('idle')
    // A prompt that wakes it makes it work again; the wait stays declared until it says it is over.
    const woken = [...ended, ...facts(['turn_started', 5])]
    expect(derive(woken)).toBe('working')
    expect(derive([...woken, ...facts(['turn_ended', 6])])).toBe('waiting')
  })

  test('walled: limit_stop or quota_resume with no later turn_started', () => {
    expect(derive(facts(['session_started', 0], ['turn_started', 1], ['limit_stop', 2]))).toBe('walled')
    expect(derive(facts(['turn_started', 1], ['limit_stop', 2], ['quota_resume', 3, 'stale']))).toBe('walled')
    expect(derive(facts(['turn_started', 1], ['limit_stop', 2], ['quota_resume', 3, 'disabled']))).toBe('walled')
    expect(derive(facts(['turn_started', 1], ['limit_stop', 2], ['turn_started', 3]))).toBe('working')
  })

  test('walled: a turn that ends after quota_resume fired was Claude carrying on by itself', () => {
    const fired = facts(['turn_started', 1], ['limit_stop', 2], ['quota_resume', 3, 'fired'])
    expect(derive(fired)).toBe('walled')
    expect(derive([...fired, ...facts(['turn_ended', 4])])).toBe('idle')
  })

  test('blocked: prompt_blocked with no later turn_started or turn_ended', () => {
    const blocked = facts(['session_started', 0], ['turn_started', 1], ['prompt_blocked', 2])
    expect(derive(blocked)).toBe('blocked')
    expect(derive([...blocked, ...facts(['turn_started', 3])])).toBe('working')
    expect(derive([...blocked, ...facts(['turn_ended', 3])])).toBe('idle')
  })

  describe('stuck: working, herdr agrees, nothing moved for 45 minutes', () => {
    const working = facts(['session_started', 0], ['turn_started', 10])
    const herdr = (over: Partial<Witnessed> = {}): Witnessed => ({
      status: 'working',
      seenAt: new Date(NOW.getTime() - 60_000),
      worktreeChangedAt: null,
      ...over,
    })

    test('stuck', () => {
      expect(derive(working, { herdr: herdr() })).toBe('stuck')
    })

    test('not while the turn is young, or the worktree moved lately', () => {
      expect(derive(working, { herdr: herdr(), now: T(10 + 44) })).toBe('working')
      expect(derive(working, { herdr: herdr({ worktreeChangedAt: T(300 - 5) }) })).toBe('working')
    })

    test('not when herdr says anything but working, or has not been heard from', () => {
      expect(derive(working, { herdr: herdr({ status: 'idle' }) })).toBe('working')
      expect(derive(working, { herdr: herdr({ seenAt: T(300 - 30) }) })).toBe('working')
      expect(derive(working, { herdr: herdr({ seenAt: null }) })).toBe('working')
      expect(derive(working)).toBe('working')
    })
  })

  test('dead: session_ended, or the pane is gone, until the session starts again', () => {
    expect(derive(facts(['session_started', 0], ['session_ended', 5]))).toBe('dead')
    expect(derive(facts(['session_started', 0], ['turn_started', 1], ['pane_gone', 5]))).toBe('dead')
    // /clear and --resume end a session and start it again at once.
    expect(derive(facts(['session_started', 0], ['session_ended', 5], ['session_started', 5]))).toBe('idle')
  })

  test('a pane_gone is withdrawn by a later hook event, or by herdr showing the agent again', () => {
    const gone = facts(['session_started', 0], ['turn_started', 1], ['pane_gone', 5])
    expect(derive([...gone, ...facts(['turn_ended', 6])])).toBe('idle')
    const back = (seenAt: number | null, status: string | null = 'idle'): Witnessed => ({
      status,
      seenAt: seenAt === null ? null : T(seenAt),
      worktreeChangedAt: null,
    })
    expect(derive(gone, { herdr: back(6) })).toBe('working')
    expect(derive(gone, { herdr: back(4) })).toBe('dead')
    expect(derive(gone, { herdr: back(null) })).toBe('dead')
    expect(derive(gone, { herdr: back(6, null) })).toBe('dead')
    // session_ended is final until a start, whatever herdr shows.
    expect(derive(facts(['session_started', 0], ['session_ended', 5]), { herdr: back(6) })).toBe('dead')
  })

  test('a resumed session starts clean: what the life before it left open does not count', () => {
    expect(derive(facts(['session_started', 0], ['turn_started', 1], ['pane_gone', 5], ['session_started', 6]))).toBe(
      'idle',
    )
    expect(derive(facts(['session_started', 0], ['turn_started', 1], ['limit_stop', 2], ['session_started', 6]))).toBe(
      'idle',
    )
    expect(
      derive(facts(['session_started', 0], ['turn_started', 1], ['prompt_blocked', 2], ['session_started', 6])),
    ).toBe('idle')
  })

  test('late and out of order delivery: the answer follows event time, not arrival', async () => {
    await emit('s', 'session_started', '2026-10-30T10:00:00Z')
    await emit('s', 'turn_started', '2026-10-30T10:01:00Z')
    await emit('s', 'limit_stop', '2026-10-30T10:03:00Z')
    expect(await stateOf('s')).toBe('walled')

    // The spool delivers a turn_started stamped after the limit_stop, but only now.
    await emit('s', 'turn_started', '2026-10-30T10:04:00Z')
    expect(await stateOf('s')).toBe('working')

    // And a turn_ended stamped between them arrives last: it cannot undo the later turn_started.
    await emit('s', 'turn_ended', '2026-10-30T10:02:00Z')
    expect(await stateOf('s')).toBe('working')
  })

  test('a session_ended delivered before the events it follows still ends the session', async () => {
    await emit('s', 'session_ended', '2026-10-30T10:05:00Z')
    await emit('s', 'turn_ended', '2026-10-30T10:04:00Z')
    await emit('s', 'turn_started', '2026-10-30T10:01:00Z')
    await emit('s', 'session_started', '2026-10-30T10:00:00Z')
    expect(await stateOf('s')).toBe('dead')
  })

  test('walled stays walled when a turn_ended is stamped after the limit_stop', async () => {
    await emit('s', 'session_started', '2026-10-30T10:00:00Z')
    await emit('s', 'turn_started', '2026-10-30T10:01:00Z')
    await emit('s', 'limit_stop', '2026-10-30T10:02:00Z')
    await emit('s', 'turn_ended', '2026-10-30T10:03:00Z')
    expect(await stateOf('s')).toBe('walled')
  })

  test('events with equal `at` fall back to insertion order', async () => {
    await emit('s', 'session_started', '2026-10-30T10:00:00Z')
    await emit('s', 'turn_started', '2026-10-30T10:01:00Z')
    await emit('s', 'turn_ended', '2026-10-30T10:01:00Z')
    expect(await stateOf('s')).toBe('idle')
  })

  test('lastEventAt is the latest event by time; unknown session is 404', async () => {
    await emit('s', 'session_started', '2026-10-30T10:00:00Z')
    await emit('s', 'turn_started', '2026-10-30T10:09:00Z')
    await emit('s', 'turn_ended', '2026-10-30T10:05:00Z')
    const view = (await (await app.get('/sessions/s')).json()) as { id: string; lastEventAt: string }
    expect(view).toMatchObject({ id: 's', lastEventAt: '2026-10-30T10:09:00.000Z' })
    expect((await app.get('/sessions/nope')).status).toBe(404)
  })
})

describe('POST /events validation', () => {
  test.each([
    ['unknown kind', { key: 'a', session: 's', kind: 'boom', at: '2026-10-30T10:00:00Z' }],
    ['missing key', { session: 's', kind: 'turn_ended', at: '2026-10-30T10:00:00Z' }],
    ['bad timestamp', { key: 'a', session: 's', kind: 'turn_ended', at: 'yesterday' }],
    ['empty session', { key: 'a', session: '', kind: 'turn_ended', at: '2026-10-30T10:00:00Z' }],
  ])('%s is a 400 and stores nothing', async (_name, body) => {
    expect((await app.send('POST', '/events', body)).status).toBe(400)
    const [{ count }] = await db.sql`SELECT count(*)::int AS count FROM factory.events`
    expect(count).toBe(0)
  })

  test('a body that is not JSON is a 400', async () => {
    expect((await app.raw('/events', '{')).status).toBe(400)
  })

  test('an optional payload is accepted', async () => {
    const res = await app.send('POST', '/events', {
      key: 'p',
      session: 's',
      kind: 'limit_stop',
      at: '2026-10-30T10:00:00Z',
      payload: { resetsAt: 'later' },
    })
    expect(res.status).toBe(201)
  })

  // finding 7: a pre-stringified payload cast to jsonb is stored as a JSON string
  test('the payload is stored as a jsonb object, readable by key', async () => {
    await app.send('POST', '/events', {
      key: 'p',
      session: 's',
      kind: 'limit_stop',
      at: '2026-10-30T10:00:00Z',
      payload: { resetsAt: 'later', nested: { n: 1 } },
    })
    await app.send('POST', '/events', { key: 'none', session: 's', kind: 'turn_started', at: '2026-10-30T10:01:00Z' })
    const rows = await db.sql`
      SELECT key, jsonb_typeof(payload) AS type, payload->>'resetsAt' AS resets_at, payload->'nested'->>'n' AS n
      FROM factory.events ORDER BY id`
    expect(rows[0]).toMatchObject({ key: 'p', type: 'object', resets_at: 'later', n: '1' })
    expect(rows[1]).toMatchObject({ key: 'none', type: null })
  })
})
