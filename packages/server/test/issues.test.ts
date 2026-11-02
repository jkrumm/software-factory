import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Issue } from '@software-factory/contract'
import { type Effect, type EffectKind, type EffectPorts, runEffects } from '../src/issues/effects.ts'
import { enqueue } from '../src/issues/inbox.ts'
import { createIssue } from '../src/issues/create.ts'
import { DEFAULT_HOLD_MS, REOPEN_WINDOW_MS, TABLE } from '../src/issues/lifecycle.ts'
import { fireTimers } from '../src/issues/timers.ts'
import { getIssue } from '../src/issues/read.ts'
import { issuePass, processInbox } from '../src/issues/worker.ts'
import { openSession, recordEvent } from '../src/sessions.ts'
import { TEST_REPO, TEST_ROOT } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

let db: TestDb
let clock: FakeClock
let n = 0

beforeAll(async () => {
  db = await startTestDb()
})
afterAll(() => db.stop())
beforeEach(async () => {
  await db.reset()
  clock = new FakeClock()
  n = 0
})

const now = () => clock.now()

async function file(key = `k${++n}`): Promise<Issue> {
  const made = await createIssue(
    db.sql,
    { source: 'request', sourceKey: key, repo: TEST_REPO, title: 'a title', facts: {} },
    { repoRoots: [TEST_ROOT], now: clock.now() },
  )
  return made.issue
}

const send = (issueId: number, kind: string, payload?: Record<string, unknown>, key = `${issueId}:${kind}:${++n}`) =>
  enqueue(db.sql, { issueId, key, kind, at: clock.now(), payload })

/** What ports were called with, and by a key as a real port does: the second call under a key finds it done. */
class World {
  calls: string[] = []
  done = new Set<string>()
  count(key: string) {
    return this.calls.filter((c) => c === key).length
  }
  readonly ports: EffectPorts = Object.fromEntries(
    (['start_lead', 'note_lead', 'verify', 'finalize'] as const).map((kind) => [
      kind,
      async (effect: Effect) => {
        this.calls.push(effect.key)
        this.done.add(effect.key)
      },
    ]),
  )
}

const pass = (ports: EffectPorts = {}) => issuePass(db.sql, { now, ports })

/** One event, handled: the way an Issue moves in these tests. */
async function step(issueId: number, kind: string, payload?: Record<string, unknown>, ports?: EffectPorts) {
  await send(issueId, kind, payload)
  expect(await pass(ports)).toEqual([])
}

const state = async (id: number): Promise<Issue> => {
  const issue = await getIssue(db.sql, id)
  if (!issue) throw new Error(`no issue ${id}`)
  return issue
}

/** The path as stored: `kind from→to`, the state changes and the rest, oldest first. */
const trail = async (id: number): Promise<string[]> => {
  const rows: { kind: string; from_state: string | null; to_state: string | null }[] = await db.sql`
    SELECT kind, from_state, to_state FROM factory.issue_events WHERE issue_id = ${id} ORDER BY id`
  return rows.map((r) => (r.to_state ? `${r.kind} ${r.from_state ?? '-'}→${r.to_state}` : r.kind))
}

const effects = async (id: number): Promise<EffectKind[]> => {
  const rows: { kind: EffectKind }[] = await db.sql`
    SELECT kind FROM factory.issue_effects WHERE issue_id = ${id} ORDER BY id`
  return rows.map((r) => r.kind)
}

const inbox = async (id: number): Promise<{ kind: string; result: string | null; session: string | null }[]> =>
  db.sql`SELECT kind, result, session FROM factory.issue_inbox WHERE issue_id = ${id} ORDER BY id`

async function working(): Promise<number> {
  const { id } = await file()
  await step(id, 'admitted')
  return id
}

describe('the transition table', () => {
  const edges = Object.entries(TABLE)
    .flatMap(([, states]) => Object.entries(states).flatMap(([from, s]) => (s.to ? [`${from}→${s.to}`] : [])))
    .filter((edge, i, all) => all.indexOf(edge) === i)
    .sort()

  test('its edges are the diagram of docs/design.md §4, and nothing else', () => {
    expect(edges).toEqual(
      [
        'closed→queued',
        'queued→closed',
        'queued→working',
        'settling→closed',
        'settling→queued',
        'waiting→closed',
        'waiting→working',
        'watching→closed',
        'watching→working',
        'working→closed',
        'working→waiting',
        'working→watching',
      ].sort(),
    )
  })

  test('nothing moves an Issue into settling, and a create begins queued', async () => {
    expect(edges.some((e) => e.endsWith('→settling'))).toBe(false)
    expect((await file()).state).toBe('queued')
    expect(await trail(1)).toEqual(['created -→queued'])
  })

  test("settling answers only to F3's events and a stop", async () => {
    const { id } = await file()
    await db.sql`UPDATE factory.issues SET state = 'settling' WHERE id = ${id}`
    await step(id, 'admitted')
    expect((await state(id)).state).toBe('settling')
    await step(id, 'settled')
    expect((await state(id)).state).toBe('queued')
  })

  test('the only statements that write issues.state are in the lifecycle module and the create, which is always queued', async () => {
    const glob = new Bun.Glob('**/*.ts')
    const writers: string[] = []
    const root = `${import.meta.dir}/../src`
    for await (const path of glob.scan(root)) {
      const text = await Bun.file(`${root}/${path}`).text()
      if (/UPDATE factory\.issues[\s\S]{0,40}SET state|INSERT INTO factory\.issues \(state/.test(text))
        writers.push(path)
    }
    expect(writers.sort()).toEqual(['issues/create.ts', 'issues/lifecycle.ts'])
  })
})

describe('golden paths: transitions and effects', () => {
  test('ship, the hold, proof: closed', async () => {
    const world = new World()
    const { id } = await file()
    await step(id, 'admitted', undefined, world.ports)
    await step(id, 'phase', { phase: 'build' }, world.ports)
    await step(id, 'ship', undefined, world.ports)
    const watching = await state(id)
    expect(watching.state).toBe('watching')
    expect(watching.attempt).toBe(1)
    expect(watching.wakeAt).toBe(new Date(clock.now().getTime() + DEFAULT_HOLD_MS).toISOString())

    clock.advance(DEFAULT_HOLD_MS - 1)
    await pass(world.ports)
    expect((await effects(id)).includes('verify')).toBe(false)

    clock.advance(1)
    await pass(world.ports)
    // The hold's end asks for proof; it does not close anything by itself.
    expect((await state(id)).state).toBe('watching')
    expect((await state(id)).wakeAt).toBeNull()

    await step(id, 'verified', { hold: 1 }, world.ports)
    const closed = await state(id)
    expect(closed).toMatchObject({ state: 'closed', outcome: 'done', reason: null })
    expect(closed.closedAt).toBe(clock.now().toISOString())
    expect(await trail(id)).toEqual([
      'created -→queued',
      'admitted queued→working',
      'phase',
      'ship working→watching',
      'hold_over',
      'verified watching→closed',
    ])
    expect(await effects(id)).toEqual(['start_lead', 'verify', 'finalize'])
    expect(world.calls).toHaveLength(3)
  })

  test('close: nothing deployed', async () => {
    const id = await working()
    await step(id, 'close', { reason: 'a document' })
    expect(await state(id)).toMatchObject({ state: 'closed', outcome: 'done' })
    expect(await trail(id)).toEqual(['created -→queued', 'admitted queued→working', 'close working→closed'])
    expect(await effects(id)).toEqual(['start_lead', 'finalize'])
  })

  test('drop: closed as dropped', async () => {
    const id = await working()
    await step(id, 'drop', { reason: 'merged into another' })
    expect(await state(id)).toMatchObject({ state: 'closed', outcome: 'dropped' })
    expect(await effects(id)).toEqual(['start_lead', 'finalize'])
  })

  test.each(['queued', 'working', 'waiting', 'watching'] as const)(
    'stop: a %s Issue closes as dropped',
    async (from) => {
      const { id } = await file()
      if (from !== 'queued') await step(id, 'admitted')
      if (from === 'waiting') await step(id, 'block')
      if (from === 'watching') await step(id, 'ship')
      await step(id, 'stop')
      expect(await state(id)).toMatchObject({ state: 'closed', outcome: 'dropped', wakeAt: null })
      expect((await effects(id)).at(-1)).toBe('finalize')
    },
  )

  test('ask, answer: a decision, and the lead hears it', async () => {
    const id = await working()
    await step(id, 'ask', { question: 'which one?', options: ['a', 'b'], default: 'a' })
    expect(await state(id)).toMatchObject({ state: 'waiting', reason: 'decision' })
    await step(id, 'answer', { answer: 'b', who: 'owner' })
    expect(await state(id)).toMatchObject({ state: 'working', reason: null })
    const [decision] =
      await db.sql`SELECT question, options, default_option, answer, answered_by FROM factory.decisions`
    expect(decision).toEqual({
      question: 'which one?',
      options: ['a', 'b'],
      default_option: 'a',
      answer: 'b',
      answered_by: 'owner',
    })
    expect(await trail(id)).toEqual([
      'created -→queued',
      'admitted queued→working',
      'ask working→waiting',
      'answer waiting→working',
    ])
    expect(await effects(id)).toEqual(['start_lead', 'note_lead'])
  })

  test('an ask without a question is refused and moves nothing', async () => {
    const id = await working()
    await step(id, 'ask', {})
    expect((await state(id)).state).toBe('working')
    expect((await inbox(id)).at(-1)?.result).toBe('refused')
    expect(await db.sql`SELECT 1 FROM factory.decisions`).toHaveLength(0)
  })

  test('a wall: the session event parks it, the next turn takes it back', async () => {
    const id = await working()
    await openSession(db.sql, { id: 'lead-1-1', spawnKey: 'lead-1-1', pane: 'w1:p1', at: clock.now() })
    await db.sql`UPDATE factory.sessions SET issue_id = ${id} WHERE id = 'lead-1-1'`
    const event = (kind: 'limit_stop' | 'turn_started' | 'turn_ended', key: string) =>
      recordEvent(db.sql, { key, session: 'lead-1-1', kind, at: clock.now() })

    await event('limit_stop', 'lead-1-1:limit_stop:1')
    await pass()
    expect(await state(id)).toMatchObject({ state: 'waiting', reason: 'wall' })
    await event('turn_ended', 'lead-1-1:turn_ended:1')
    await pass()
    expect((await state(id)).state).toBe('waiting')
    await event('turn_started', 'lead-1-1:turn_started:1')
    await pass()
    expect(await state(id)).toMatchObject({ state: 'working', reason: null })
    expect(await trail(id)).toEqual([
      'created -→queued',
      'admitted queued→working',
      'limit_stop working→waiting',
      'turn_started waiting→working',
    ])
    expect((await inbox(id)).map((r) => [r.kind, r.result, r.session])).toEqual([
      ['admitted', 'applied', null],
      ['limit_stop', 'applied', 'lead-1-1'],
      ['turn_ended', 'ignored', 'lead-1-1'],
      ['turn_started', 'applied', 'lead-1-1'],
    ])
  })

  test("a worker's turn does not end its lead's wall: only the session that hit it does", async () => {
    const id = await working()
    const event = (session: string, kind: string, key: string) =>
      enqueue(db.sql, { issueId: id, key, kind, at: clock.now(), session })
    await event('lead-1-1', 'limit_stop', 'wall')
    await pass()
    expect(await state(id)).toMatchObject({ state: 'waiting', reason: 'wall' })

    await event('worker-1', 'turn_started', 'worker-turn')
    await pass()
    expect(await state(id)).toMatchObject({ state: 'waiting', reason: 'wall' })
    expect((await inbox(id)).at(-1)?.result).toBe('ignored')

    await event('lead-1-1', 'turn_started', 'lead-turn')
    await pass()
    expect(await state(id)).toMatchObject({ state: 'working', reason: null })
  })

  test('a turn does not take back what a turn did not cause: a parked Issue stays parked', async () => {
    const id = await working()
    await step(id, 'park')
    await step(id, 'turn_started')
    expect(await state(id)).toMatchObject({ state: 'waiting', reason: 'parked' })
    expect((await inbox(id)).at(-1)?.result).toBe('ignored')
  })

  test('a regression inside the hold goes back to the lead; a plain repeat does not', async () => {
    const id = await working()
    await step(id, 'ship')
    await step(id, 'signal', { status: 'up' })
    expect((await state(id)).state).toBe('watching')
    await step(id, 'signal', { regression: true })
    expect(await state(id)).toMatchObject({ state: 'working', wakeAt: null })
    expect(await trail(id)).toEqual([
      'created -→queued',
      'admitted queued→working',
      'ship working→watching',
      'signal',
      'regression watching→working',
    ])
    expect(await effects(id)).toEqual(['start_lead', 'note_lead'])
  })

  test.each(['queued', 'working', 'waiting', 'closed'] as const)(
    'a signal with regression set on a %s Issue is recorded as a signal: the door sets it on every down',
    async (at) => {
      const { id } = await file()
      if (at !== 'queued') await step(id, 'admitted')
      if (at === 'waiting') await step(id, 'block')
      if (at === 'closed') await step(id, 'close')
      await step(id, 'signal', { regression: true })
      expect((await state(id)).state).toBe(at)
      expect((await inbox(id)).at(-1)?.result).toBe('applied')
      expect((await trail(id)).at(-1)).toBe('signal')
    },
  )

  test('a second ship of the same attempt gets a hold of its own', async () => {
    const id = await working()
    await step(id, 'ship')
    clock.advance(DEFAULT_HOLD_MS)
    await pass()
    await step(id, 'regression')
    await step(id, 'ship')
    clock.advance(DEFAULT_HOLD_MS)
    await pass()
    expect((await state(id)).attempt).toBe(1)
    expect((await effects(id)).filter((k) => k === 'verify')).toHaveLength(2)
  })

  test('a timed wait wakes by itself, once', async () => {
    const id = await working()
    await step(id, 'wait', { until: new Date(clock.now().getTime() + 60_000).toISOString() })
    expect(await state(id)).toMatchObject({ state: 'waiting', reason: 'wait' })
    clock.advance(60_000)
    await pass()
    expect((await state(id)).state).toBe('working')
    await pass()
    expect((await inbox(id)).filter((r) => r.kind === 'wake')).toHaveLength(1)
    expect(await effects(id)).toEqual(['start_lead', 'note_lead'])
  })

  test('a second wait for the same time wakes too: each wait is a timer of its own', async () => {
    const id = await working()
    const until = new Date(clock.now().getTime() + 60_000).toISOString()
    await step(id, 'wait', { until })
    clock.advance(60_000)
    await pass()
    expect((await state(id)).state).toBe('working')

    await step(id, 'wait', { until })
    await pass()
    expect((await state(id)).state).toBe('working')
    expect((await inbox(id)).filter((r) => r.kind === 'wake')).toHaveLength(2)
  })

  test.each([
    ['no until', {}],
    ['an until that is no string', { until: 1_800_000_000_000 }],
    ['an empty until', { until: '' }],
  ])('a wait with %s is refused: it would have no way out', async (_, payload) => {
    const id = await working()
    await step(id, 'wait', payload)
    expect(await state(id)).toMatchObject({ state: 'working', wakeAt: null })
    expect((await inbox(id)).at(-1)?.result).toBe('refused')
  })

  test('a dependency: waits until everything it depends on is closed', async () => {
    const blocker = await working()
    const other = await working()
    const id = await working()
    await step(id, 'dep', { on: blocker })
    await step(id, 'dep', { on: other })
    expect(await state(id)).toMatchObject({ state: 'waiting', reason: 'dependency' })
    await step(blocker, 'close')
    expect((await state(id)).state).toBe('waiting')
    await step(other, 'drop')
    await pass()
    expect((await state(id)).state).toBe('working')
  })

  test('a dep on an unknown Issue, on itself or on a closed one is refused: nothing would wake it', async () => {
    const closed = await working()
    await step(closed, 'close')
    const id = await working()
    await step(id, 'dep', { on: 999 })
    await step(id, 'dep', { on: id })
    await step(id, 'dep', { on: closed })
    expect((await state(id)).state).toBe('working')
    expect((await inbox(id)).slice(-3).map((r) => r.result)).toEqual(['refused', 'refused', 'refused'])
  })

  test('a dep that closes a cycle is refused, direct or through others', async () => {
    const a = await working()
    const b = await working()
    const c = await working()
    await step(a, 'dep', { on: b })
    await step(b, 'dep', { on: c })
    await step(b, 'dep', { on: a })
    await step(c, 'dep', { on: a })
    expect((await inbox(b)).at(-1)?.result).toBe('refused')
    expect((await inbox(c)).at(-1)?.result).toBe('refused')
    expect((await state(c)).state).toBe('working')
    await step(c, 'close')
    await pass()
    await step(b, 'close')
    await pass()
    expect((await state(a)).state).toBe('working')
  })

  test('a satisfied dep goes with the close: a blocker that reopens does not hold the wake back', async () => {
    const reopened = await working()
    const last = await working()
    const id = await working()
    await step(id, 'dep', { on: reopened })
    await step(id, 'dep', { on: last })
    await step(reopened, 'close')
    await step(reopened, 'reopen')
    await step(last, 'close')
    await pass()
    expect((await state(id)).state).toBe('working')
    expect(await db.sql`SELECT 1 FROM factory.issue_deps`).toHaveLength(0)
  })

  test('a close leaves no dep of the Issue itself behind', async () => {
    const blocker = await working()
    const id = await working()
    await step(id, 'dep', { on: blocker })
    await step(id, 'stop')
    expect(await db.sql`SELECT 1 FROM factory.issue_deps`).toHaveLength(0)
  })

  test('a close in flight is waited for: the dep sees it and refuses, the Issue is not left parked', async () => {
    const blocker = await working()
    const id = await working()
    await send(id, 'dep', { on: blocker })
    const release = Promise.withResolvers<void>()
    const closing = Promise.withResolvers<void>()
    const close = db.sql.begin(async (tx) => {
      await tx`
        UPDATE factory.issues SET state = 'closed', outcome = 'done', closed_at = ${clock.now()} WHERE id = ${blocker}`
      closing.resolve()
      await release.promise
    })
    await closing.promise
    const worker = pass()
    await Bun.sleep(100)
    release.resolve()
    await close
    expect(await worker).toEqual([])
    expect((await state(id)).state).toBe('working')
    expect((await inbox(id)).at(-1)?.result).toBe('refused')
  })

  test('a blocker that reopens and closes again wakes its dependent a second time', async () => {
    const blocker = await working()
    const id = await working()
    await step(id, 'dep', { on: blocker })
    await step(blocker, 'close')
    await pass()
    expect((await state(id)).state).toBe('working')

    await step(blocker, 'reopen')
    await step(blocker, 'admitted')
    await step(id, 'dep', { on: blocker })
    expect(await state(id)).toMatchObject({ state: 'waiting', reason: 'dependency' })
    clock.advance(1000)
    await step(blocker, 'close')
    await pass()
    expect((await state(id)).state).toBe('working')
  })

  test('a late wake ends only the wait it was filed for', async () => {
    const id = await working()
    await step(id, 'ask', { question: 'which?' })
    await step(id, 'wake', { for: 'wait' })
    expect(await state(id)).toMatchObject({ state: 'waiting', reason: 'decision' })
    expect((await trail(id)).at(-1)).toBe('refused')
  })

  test('a late wake of an earlier wait does not end a later one', async () => {
    const id = await working()
    const until = new Date(clock.now().getTime() + 3_600_000).toISOString()
    await step(id, 'wait', { until })
    await step(id, 'wake', { for: 'wait', wait: 0 })
    expect(await state(id)).toMatchObject({ state: 'waiting', reason: 'wait' })
    await step(id, 'wake', { for: 'wait', wait: 1 })
    expect((await state(id)).state).toBe('working')
  })

  test('a wake is checked against what is open now: a new blocker keeps it waiting', async () => {
    const blocker = await working()
    const id = await working()
    await step(id, 'dep', { on: blocker })
    await step(id, 'wake', { for: 'dependency' })
    expect(await state(id)).toMatchObject({ state: 'waiting', reason: 'dependency' })
  })

  test('the end of an earlier hold and its proof count for nothing in a later one', async () => {
    const id = await working()
    await step(id, 'ship')
    await step(id, 'regression')
    await step(id, 'ship')
    await step(id, 'hold_over', { hold: 1 })
    await step(id, 'verified', { hold: 1 })
    expect((await state(id)).state).toBe('watching')
    expect(await effects(id)).toEqual(['start_lead', 'note_lead'])
    await step(id, 'verified', { hold: 2 })
    expect((await state(id)).state).toBe('closed')
  })

  test('a wall older than the last move, or than a turn seen since, parks nothing', async () => {
    const id = await working()
    const wall = (at: Date, key: string) => enqueue(db.sql, { issueId: id, key, kind: 'limit_stop', at, session: 's1' })
    clock.advance(60_000)
    await wall(new Date(clock.now().getTime() - 120_000), 'old')
    await pass()
    expect((await state(id)).state).toBe('working')

    const before = clock.now()
    clock.advance(1000)
    await enqueue(db.sql, { issueId: id, key: 'turn', kind: 'turn_started', at: clock.now(), session: 's1' })
    await pass()
    await wall(before, 'late')
    await pass()
    expect((await state(id)).state).toBe('working')
    expect((await inbox(id)).map((r) => r.result)).toEqual(['applied', 'refused', 'ignored', 'refused'])
  })

  test('a wall after a transition that was handled late still parks: event times decide', async () => {
    const { id } = await file()
    const admittedAt = clock.now()
    await send(id, 'admitted')
    clock.advance(1000)
    const wallAt = clock.now()
    clock.advance(10_000)
    await enqueue(db.sql, { issueId: id, key: 'wall', kind: 'limit_stop', at: wallAt, session: 's1' })
    await pass()
    expect(admittedAt < wallAt).toBe(true)
    expect(await state(id)).toMatchObject({ state: 'waiting', reason: 'wall' })
  })

  test('a delayed event does not move the Issue back in time: a later stale wall still refuses', async () => {
    const id = await working()
    await step(id, 'ship')
    const shipped = clock.now()
    await enqueue(db.sql, {
      issueId: id,
      key: 'late-regression',
      kind: 'regression',
      at: new Date(shipped.getTime() - 20_000),
    })
    await enqueue(db.sql, {
      issueId: id,
      key: 'old-wall',
      kind: 'limit_stop',
      at: new Date(shipped.getTime() - 10_000),
      session: 's1',
    })
    await pass()
    expect((await state(id)).state).toBe('working')
  })

  test('a turn from before the wall, delivered after it, does not end it', async () => {
    const id = await working()
    const turnAt = clock.now()
    clock.advance(1000)
    await enqueue(db.sql, { issueId: id, key: 'wall', kind: 'limit_stop', at: clock.now(), session: 's1' })
    await pass()
    await enqueue(db.sql, { issueId: id, key: 'old-turn', kind: 'turn_started', at: turnAt, session: 's1' })
    await pass()
    expect(await state(id)).toMatchObject({ state: 'waiting', reason: 'wall' })
  })

  test('a stop closes an open question: answering a later one leaves it alone', async () => {
    const id = await working()
    await step(id, 'ask', { question: 'first?' })
    await step(id, 'stop')
    await step(id, 'reopen')
    await step(id, 'admitted')
    await step(id, 'ask', { question: 'second?' })
    await step(id, 'answer', { answer: 'yes' })
    const rows = await db.sql`SELECT question, answer, answered_by FROM factory.decisions ORDER BY id`
    expect(rows).toEqual([
      { question: 'first?', answer: null, answered_by: 'closed' },
      { question: 'second?', answer: 'yes', answered_by: 'owner' },
    ])
  })

  test('reopen within 30 days queues it for a new attempt; past them it is refused', async () => {
    const id = await working()
    await step(id, 'close')
    clock.advance(REOPEN_WINDOW_MS)
    await step(id, 'reopen')
    expect(await state(id)).toMatchObject({ state: 'queued', outcome: null, closedAt: null })
    await step(id, 'admitted')
    expect((await state(id)).attempt).toBe(2)

    await step(id, 'close')
    clock.advance(REOPEN_WINDOW_MS + 1)
    await step(id, 'reopen')
    expect((await state(id)).state).toBe('closed')
    expect((await trail(id)).at(-1)).toBe('refused')
  })

  test('nothing but reopen moves a closed Issue: a signal is recorded, the rest refused', async () => {
    const id = await working()
    await step(id, 'close')
    await step(id, 'signal', { regression: true })
    await step(id, 'admitted')
    expect((await state(id)).state).toBe('closed')
  })

  test('a verb the state has no entry for is refused and leaves a line', async () => {
    const { id } = await file()
    await step(id, 'ship')
    await step(id, 'no_such_event')
    expect((await state(id)).state).toBe('queued')
    const rows = await inbox(id)
    expect(rows.map((r) => r.result)).toEqual(['refused', 'refused'])
    expect(await trail(id)).toEqual(['created -→queued', 'refused', 'refused'])
    expect(await effects(id)).toEqual([])
    const [{ detail }] = await db.sql`SELECT detail FROM factory.issue_inbox ORDER BY id LIMIT 1`
    expect(detail).toBe('ship does not apply to a queued Issue')
  })
})

describe('the inbox', () => {
  test('one row per key, whoever sends it how often', async () => {
    const { id } = await file()
    expect(await send(id, 'admitted', undefined, 'admit:1:1')).toEqual({ duplicate: false })
    expect(await send(id, 'admitted', undefined, 'admit:1:1')).toEqual({ duplicate: true })
    await pass()
    expect(await send(id, 'admitted', undefined, 'admit:1:1')).toEqual({ duplicate: true })
    await pass()
    expect(await inbox(id)).toHaveLength(1)
    expect((await state(id)).attempt).toBe(1)
  })

  test('a session event is copied once, only for a session with an Issue, and with the transaction that stores it', async () => {
    const { id } = await file()
    await openSession(db.sql, { id: 's1', spawnKey: 's1', pane: 'w1:p1', at: clock.now() })
    const event = { key: 's1:turn_started:1', session: 's1', kind: 'turn_started', at: clock.now() } as const

    await recordEvent(db.sql, event)
    expect(await inbox(id)).toHaveLength(0)

    await db.sql`UPDATE factory.sessions SET issue_id = ${id} WHERE id = 's1'`
    const second = { ...event, key: 's1:turn_started:2', payload: { a: 1 } }
    expect(await recordEvent(db.sql, second)).toEqual({ duplicate: false })
    expect(await recordEvent(db.sql, second)).toEqual({ duplicate: true })
    const rows = await db.sql`SELECT key, payload FROM factory.issue_inbox`
    expect(rows).toEqual([{ key: 's1:turn_started:2', payload: { a: 1 } }])

    // A transaction that does not commit stores neither.
    await db.sql
      .begin(async (tx) => {
        const { recordIn } = await import('../src/sessions.ts')
        await recordIn(tx, { ...event, key: 's1:turn_started:3' })
        throw new Error('rolled back')
      })
      .catch(() => {})
    expect(await db.sql`SELECT 1 FROM factory.events WHERE key = 's1:turn_started:3'`).toHaveLength(0)
    expect(await db.sql`SELECT 1 FROM factory.issue_inbox`).toHaveLength(1)
  })

  test('rows are taken oldest first by event time: a late spool line goes before what followed it', async () => {
    const id = await working()
    const late = new Date(clock.now().getTime() - 60_000)
    await send(id, 'close')
    await enqueue(db.sql, { issueId: id, key: 'late', kind: 'ship', at: late })
    await pass()
    expect((await state(id)).state).toBe('watching')
    expect((await inbox(id)).map((r) => r.result)).toEqual(['applied', 'refused', 'applied'])
  })

  test('an Issue another worker holds is skipped, and a copied event does not wait for that worker', async () => {
    const held = await working()
    const free = await working()
    await send(held, 'close')
    await send(free, 'close')

    const release = Promise.withResolvers<void>()
    const locked = Promise.withResolvers<void>()
    const worker = db.sql.begin(async (tx) => {
      await tx`SELECT id FROM factory.issues WHERE id = ${held} FOR NO KEY UPDATE`
      locked.resolve()
      await release.promise
    })
    await locked.promise
    try {
      expect(await processInbox(db.sql, now)).toEqual([])
      expect((await state(free)).state).toBe('closed')
      expect((await state(held)).state).toBe('working')
      // The foreign key of a new row takes KEY SHARE on the Issue, which the worker's lock leaves free.
      await send(held, 'phase')
    } finally {
      release.resolve()
    }
    await worker
    await processInbox(db.sql, now)
    expect((await state(held)).state).toBe('closed')
  })

  test("a row that throws is undone alone: the error is on it, and an owner's stop behind it applies", async () => {
    const bad = await working()
    const good = await working()
    // The key of the Issue's first audit row: the insert for this event throws, after its decision and its move.
    const poison = `created:${bad}`
    await send(bad, 'ask', { question: 'q' }, poison)
    await send(bad, 'stop')
    await send(good, 'close')

    const errors = await pass()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toStartWith(`issue ${bad}: ${poison}: `)
    expect(await state(bad)).toMatchObject({ state: 'closed', outcome: 'dropped' })
    expect((await state(good)).state).toBe('closed')
    expect(await db.sql`SELECT 1 FROM factory.decisions`).toHaveLength(0)

    const rows = await db.sql`SELECT key, result, error FROM factory.issue_inbox WHERE issue_id = ${bad} ORDER BY id`
    expect(rows[1].key).toBe(poison)
    expect(rows[1].result).toBeNull()
    expect(rows[1].error).toBeString()
    expect(rows[2].result).toBe('applied')
    expect(rows[2].error).toBeNull()

    // Its Issue has moved past it, at the same event time too: refused on the next pass, with a line in the Issue's events.
    expect(await pass()).toEqual([])
    const [row] = await db.sql`SELECT result, error FROM factory.issue_inbox WHERE key = ${poison}`
    expect(row.result).toBe('refused')
    expect((await trail(bad)).at(-1)).toBe('refused')
  })

  test('a failed row on an Issue that did not move stays, one line a pass, and holds up nothing', async () => {
    const id = await working()
    const poison = `created:${id}`
    await send(id, 'phase', undefined, poison)
    expect(await pass()).toHaveLength(1)
    await send(id, 'phase')
    expect(await pass()).toHaveLength(1)
    expect((await inbox(id)).slice(-2).map((r) => r.result)).toEqual([null, 'applied'])
  })

  test('a retry that cannot be refused either is one failed row, not a failed pass', async () => {
    const bad = await working()
    const good = await working()
    const key = `created:${bad}`
    await send(bad, 'phase', undefined, key)
    await send(bad, 'stop')
    await send(bad, 'phase', undefined, `superseded:${key}`)
    expect(await pass()).toHaveLength(1)
    await send(good, 'close')
    await db.sql`
      INSERT INTO factory.issue_events (issue_id, key, kind, at) VALUES (${bad}, ${`superseded:${key}`}, 'refused', ${clock.now()})
      ON CONFLICT (key) DO NOTHING`
    expect(await pass()).toHaveLength(1)
    expect((await state(good)).state).toBe('closed')
  })

  test('a late event that failed is retried while the Issue has not moved, however old it is', async () => {
    const id = await working()
    clock.advance(60_000)
    await enqueue(db.sql, {
      issueId: id,
      key: 'late',
      kind: 'close',
      at: new Date(clock.now().getTime() - 120_000),
    })
    let calls = 0
    const failingOnce = () => {
      if (++calls === 1) throw new Error('a handler threw')
      return clock.now()
    }
    expect(await processInbox(db.sql, failingOnce)).toHaveLength(1)
    expect(await pass()).toEqual([])
    expect((await state(id)).state).toBe('closed')
  })

  test('an error with no message still counts as a failure', async () => {
    const id = await working()
    await send(id, 'close')
    await send(id, 'stop')
    let calls = 0
    const failingOnce = () => {
      if (++calls === 1) throw new Error('')
      return clock.now()
    }
    await processInbox(db.sql, failingOnce)
    expect((await state(id)).outcome).toBe('dropped')
    await send(id, 'reopen')
    await send(id, 'admitted')
    await pass()
    expect(await state(id)).toMatchObject({ state: 'working', attempt: 2 })
  })

  test('a failed row the Issue has moved past is refused, not retried against a later attempt', async () => {
    const id = await working()
    await send(id, 'close')
    clock.advance(1000)
    await send(id, 'stop')
    let calls = 0
    const failingFirst = () => {
      if (++calls === 1) throw new Error('a handler threw')
      return clock.now()
    }
    expect(await processInbox(db.sql, failingFirst)).toHaveLength(1)
    expect(await state(id)).toMatchObject({ state: 'closed', outcome: 'dropped' })

    clock.advance(1000)
    await send(id, 'reopen')
    await send(id, 'admitted')
    expect(await pass()).toEqual([])
    expect(await state(id)).toMatchObject({ state: 'working', attempt: 2 })
    const [failed] = await db.sql`SELECT result, detail FROM factory.issue_inbox WHERE kind = 'close'`
    expect(failed).toEqual({ result: 'refused', detail: 'superseded: a handler threw' })
  })

  test('a failed row that works next time loses its error', async () => {
    const id = await working()
    await send(id, 'phase')
    await send(id, 'close')
    let calls = 0
    const failingOnce = () => {
      // The second event: each row asks the time twice.
      if (++calls === 3) throw new Error('a handler threw')
      return clock.now()
    }
    expect(await processInbox(db.sql, failingOnce)).toHaveLength(1)
    expect((await state(id)).state).toBe('working')
    const [left] = await db.sql`SELECT kind, error FROM factory.issue_inbox WHERE handled_at IS NULL`
    expect(left).toEqual({ kind: 'close', error: 'a handler threw' })

    expect(await processInbox(db.sql, now)).toEqual([])
    expect((await state(id)).state).toBe('closed')
    expect(await db.sql`SELECT 1 FROM factory.issue_inbox WHERE error IS NOT NULL`).toHaveLength(0)
  })

  test('failed rows go after new ones, so a full batch of them holds nothing up', async () => {
    const id = await working()
    await db.sql`
      INSERT INTO factory.issue_inbox (issue_id, key, kind, at, error)
      SELECT ${id}, 'failed:' || n, 'phase', ${clock.now()}, 'it failed before' FROM generate_series(1, 60) n`
    await send(id, 'close')
    await processInbox(db.sql, now)
    expect((await state(id)).state).toBe('closed')
  })

  test('an expiry that is a time by a lenient reading is stored as one, not thrown on', async () => {
    const id = await working()
    await step(id, 'ask', { question: 'q', expiresAt: '2026-02-30T00:00:00Z' })
    expect((await state(id)).reason).toBe('decision')
  })

  test('every failed Issue gets its try each pass, however many failed', async () => {
    const ids: number[] = []
    for (let i = 0; i < 25; i++) ids.push(await working())
    for (const id of ids) await send(id, 'close')
    const always = () => {
      throw new Error('down')
    }
    expect(await processInbox(db.sql, always)).toHaveLength(25)
  })

  test('a failed row does not put a new stop behind every other Issue', async () => {
    const id = await working()
    await send(id, 'phase')
    await db.sql`UPDATE factory.issue_inbox SET error = 'it failed before' WHERE issue_id = ${id} AND handled_at IS NULL`
    await send(id, 'stop')
    for (let i = 0; i < 25; i++) await send(await working(), 'phase')
    await processInbox(db.sql, now)
    expect((await state(id)).state).toBe('closed')
  })

  test('Issues that keep failing do not fill a pass: the others go first', async () => {
    const failing: number[] = []
    for (let i = 0; i < 25; i++) {
      const id = await working()
      failing.push(id)
      await send(id, 'phase')
      await db.sql`UPDATE factory.issue_inbox SET error = 'it failed before' WHERE issue_id = ${id} AND handled_at IS NULL`
    }
    const healthy = await working()
    await send(healthy, 'close')
    await processInbox(db.sql, now)
    expect((await state(healthy)).state).toBe('closed')
  })

  test.each([
    ['an ask with a bad expiry', 'ask', { question: 'q', expiresAt: 'not a time' }],
    ['a wait with a bad time', 'wait', { until: 'not a time' }],
    ['a time Postgres cannot store', 'ask', { question: 'q', expiresAt: '-005000-01-01T00:00:00.000Z' }],
    ['a wait for a time Postgres cannot store', 'wait', { until: '+275000-01-01T00:00:00.000Z' }],
    ['a dep on an id past the column', 'dep', { on: 99_999_999_999 }],
    ['a dep on a fraction', 'dep', { on: 1.5 }],
  ])('%s is refused, and does not hold up what follows', async (_, kind, payload) => {
    const id = await working()
    await send(id, kind, payload)
    await send(id, 'stop')
    expect(await pass()).toEqual([])
    expect((await inbox(id)).slice(-2).map((r) => r.result)).toEqual(['refused', 'applied'])
    expect((await state(id)).state).toBe('closed')
  })

  test('timers fire once, and a timer of an Issue that moved on fires nothing', async () => {
    const id = await working()
    await step(id, 'ship')
    clock.advance(DEFAULT_HOLD_MS)
    expect(await fireTimers(db.sql, clock.now())).toBe(1)
    expect(await fireTimers(db.sql, clock.now())).toBe(0)
    await db.sql`UPDATE factory.issues SET wake_at = ${clock.now()} WHERE id = ${id}`
    await step(id, 'stop')
    expect(await fireTimers(db.sql, clock.now())).toBe(0)
  })
})

describe('the inbox index', () => {
  test("a wall's look for a later turn goes by the index, handled rows and all", async () => {
    const id = await working()
    await db.sql`
      INSERT INTO factory.issue_inbox (issue_id, key, kind, session, at, handled_at, result)
      SELECT ${id}, 'old:' || n, 'turn_ended', 's1', ${clock.now()}, ${clock.now()}, 'ignored' FROM generate_series(1, 5000) n`
    await db.sql`ANALYZE factory.issue_inbox`
    const rows: { 'QUERY PLAN': string }[] = await db.sql.unsafe(`
      EXPLAIN SELECT 1 FROM factory.issue_inbox
      WHERE issue_id = ${id} AND session = 's1' AND kind = 'turn_started' AND at > now() LIMIT 1`)
    expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toContain('issue_inbox_session')
  })
})

describe('effects', () => {
  test('an effect never overtakes an earlier one that has no port yet', async () => {
    const { id } = await file()
    await send(id, 'admitted')
    await send(id, 'note', { text: 'a fact' })
    await processInbox(db.sql, now)
    const calls: string[] = []
    await runEffects(db.sql, { note_lead: async (effect) => void calls.push(effect.key) }, now)
    expect(calls).toEqual([])
  })

  test('a close cancels what it makes pointless: no lead, no note, and finalize waits behind neither', async () => {
    const { id } = await file()
    await send(id, 'admitted')
    await send(id, 'note', { text: 'a fact' })
    await send(id, 'stop', undefined, 'stop')
    await processInbox(db.sql, now)
    expect(await effects(id)).toEqual(['start_lead', 'note_lead', 'finalize'])

    // Only finalize has a port: the portless start_lead does not hold it back.
    const calls: string[] = []
    await runEffects(db.sql, { finalize: async (effect) => void calls.push(effect.key) }, now)
    expect(calls).toEqual(['finalize:stop'])

    // Every port there: the closed Issue still gets nothing else.
    const world = new World()
    expect(await pass(world.ports)).toEqual([])
    expect(world.calls).toEqual([])
    const rows = await db.sql`SELECT kind FROM factory.issue_effects WHERE cancelled_at IS NOT NULL ORDER BY id`
    expect(rows.map((r: { kind: string }) => r.kind)).toEqual(['start_lead', 'note_lead'])
  })

  test('a finalize still open survives the next close: a reopen runs it before the new lead', async () => {
    const id = await working()
    await step(id, 'stop', undefined, undefined)
    await step(id, 'reopen')
    await step(id, 'admitted')
    await step(id, 'drop')
    const open = await db.sql`
      SELECT kind FROM factory.issue_effects WHERE done_at IS NULL AND cancelled_at IS NULL ORDER BY id`
    expect(open.map((r: { kind: string }) => r.kind)).toEqual(['finalize', 'finalize'])
  })

  test('an Issue whose port keeps failing leaves room for the others', async () => {
    const failing: number[] = []
    for (let i = 0; i < 25; i++) failing.push((await file()).id)
    for (const id of failing) await send(id, 'admitted')
    await processInbox(db.sql, now)
    const healthy = (await file()).id
    await send(healthy, 'admitted')
    await processInbox(db.sql, now)
    await db.sql`UPDATE factory.issue_effects SET attempts = 3 WHERE issue_id <> ${healthy}`
    const done: number[] = []
    await runEffects(
      db.sql,
      {
        start_lead: async (effect) => {
          if (effect.issueId !== healthy) throw new Error('down')
          done.push(effect.issueId)
        },
      },
      now,
    )
    expect(done).toEqual([healthy])
  })

  test('an effect with no port yet stays recorded and runs when one comes', async () => {
    const id = await working()
    expect(await effects(id)).toEqual(['start_lead'])
    const world = new World()
    await pass(world.ports)
    expect(world.calls).toHaveLength(1)
    expect(world.calls[0]).toStartWith('start_lead:')
  })

  test('a failing port is retried under the same key and keeps its Issue in order', async () => {
    const { id } = await file()
    await send(id, 'admitted', undefined, 'admit')
    await send(id, 'note', { text: 'a fact' }, 'n1')
    await processInbox(db.sql, now)
    const calls: string[] = []
    let failing = true
    const ports: EffectPorts = {
      start_lead: async (effect) => {
        calls.push(effect.key)
        if (failing) throw new Error('the runner is down')
      },
      note_lead: async (effect) => {
        calls.push(effect.key)
      },
    }
    expect(await runEffects(db.sql, ports, now)).toEqual(['start_lead:admit: the runner is down'])
    expect(calls).toEqual(['start_lead:admit'])
    const [row] =
      await db.sql`SELECT attempts, error, done_at FROM factory.issue_effects WHERE key = 'start_lead:admit'`
    expect(row).toEqual({ attempts: 1, error: 'the runner is down', done_at: null })

    failing = false
    expect(await runEffects(db.sql, ports, now)).toEqual([])
    expect(calls).toEqual(['start_lead:admit', 'start_lead:admit', 'note_lead:n1'])
    expect(await runEffects(db.sql, ports, now)).toEqual([])
    expect(calls).toHaveLength(3)
  })
})

describe('effects with no port', () => {
  test('a check that has no port yet does not hold back the lead’s note', async () => {
    const world = new World()
    // Only the lead has ports; `verify` (Wave 4) has none.
    const lead = { start_lead: world.ports.start_lead, note_lead: world.ports.note_lead }
    const id = await working()
    await step(id, 'ship', undefined, lead)
    await step(id, 'hold_over', { hold: 1 }, lead)
    expect(await effects(id)).toEqual(['start_lead', 'verify'])
    await step(id, 'signal', { regression: true }, lead)
    expect(world.calls.filter((c) => c.startsWith('note_lead'))).toHaveLength(1)
    const open = await db.sql`SELECT kind FROM factory.issue_effects WHERE issue_id = ${id} AND done_at IS NULL`
    expect(open.map((r: { kind: string }) => r.kind)).toEqual(['verify'])
  })
})

describe('the replay test: a crash after every effect', () => {
  type Action = { send: string; payload?: Record<string, unknown> } | { advance: number }
  // One Issue through everything that has an effect: a lead, notes, two holds, proof, finalize.
  const SCRIPT: Action[] = [
    { send: 'admitted' },
    { send: 'phase', payload: { phase: 'investigate' } },
    { send: 'ask', payload: { question: 'which?' } },
    { send: 'answer', payload: { answer: 'this' } },
    { send: 'note', payload: { text: 'a new fact' } },
    { send: 'ship' },
    { send: 'signal', payload: { regression: true } },
    { send: 'ship' },
    { advance: DEFAULT_HOLD_MS },
    { send: 'verified', payload: { hold: 2 } },
  ]

  class Crash extends Error {}

  /** Stops the process at the n-th point: before or after each port call, and between the steps of a pass. */
  class Faults {
    seen = 0
    crashed = false
    constructor(private readonly at: number) {}
    point(): void {
      if (this.crashed) return
      if (this.seen++ === this.at) {
        this.crashed = true
        throw new Crash(`crash at point ${this.at}`)
      }
    }
  }

  const portsWith = (world: World, faults: Faults): EffectPorts =>
    Object.fromEntries(
      Object.entries(world.ports).map(([kind, port]) => [
        kind,
        async (effect: Effect) => {
          faults.point()
          // The port's own key: what a Runner's look-before-it-acts and a prompt's id do.
          if (!world.done.has(effect.key)) await port?.(effect)
          faults.point()
        },
      ]),
    )

  /** One full pass, a crash possible between its steps; a crash inside a port surfaces the same way. */
  async function passWith(world: World, faults: Faults): Promise<void> {
    faults.point()
    await fireTimers(db.sql, clock.now())
    faults.point()
    await processInbox(db.sql, now)
    faults.point()
    await runEffects(db.sql, portsWith(world, faults), now)
    if (faults.crashed) throw new Crash('crashed inside a port')
    faults.point()
  }

  /** The script from the top, as a replay delivers it: every event again under its own key. */
  async function run(id: number, world: World, faults: Faults): Promise<void> {
    let i = 0
    for (const action of SCRIPT) {
      i++
      if ('advance' in action) clock.advance(action.advance)
      else await send(id, action.send, action.payload, `${id}:${action.send}:${i}`)
      await passWith(world, faults)
    }
    await passWith(world, faults)
  }

  const snapshot = async (id: number) => ({
    state: (await state(id)).state,
    outcome: (await state(id)).outcome,
    attempt: (await state(id)).attempt,
    events: await trail(id),
    effects: await effects(id),
    open: (await db.sql`SELECT 1 FROM factory.issue_effects WHERE done_at IS NULL AND cancelled_at IS NULL`).length,
    unhandled: (await db.sql`SELECT 1 FROM factory.issue_inbox WHERE handled_at IS NULL`).length,
    decisions: (await db.sql`SELECT 1 FROM factory.decisions`).length,
  })

  async function reset(): Promise<number> {
    await db.reset()
    clock = new FakeClock()
    return (await file('replay')).id
  }

  // A whole run per crash point, against a real Postgres: seconds alone, more on a loaded host.
  test('every crash point replays to the run without one, with zero duplicates', async () => {
    const id = await reset()
    const clean = new World()
    const never = new Faults(Number.MAX_SAFE_INTEGER)
    await run(id, clean, never)
    const expected = await snapshot(id)
    expect(expected).toMatchObject({ state: 'closed', outcome: 'done', attempt: 1, open: 0, unhandled: 0 })
    expect(expected.effects).toEqual(['start_lead', 'note_lead', 'note_lead', 'note_lead', 'verify', 'finalize'])
    expect(new Set(clean.calls).size).toBe(clean.calls.length)
    const points = never.seen
    expect(points).toBeGreaterThan(SCRIPT.length * 4)

    for (let at = 0; at < points; at++) {
      const issue = await reset()
      const world = new World()
      const faults = new Faults(at)
      await run(issue, world, faults).catch((error) => {
        if (!(error instanceof Crash)) throw error
      })
      expect(faults.crashed).toBe(true)
      // The new process: the world is what it was, the script is delivered again from the top.
      await run(issue, world, new Faults(Number.MAX_SAFE_INTEGER))
      const after = await snapshot(issue)
      expect(after).toEqual(expected)
      for (const key of world.done) expect(world.count(key)).toBe(1)
      expect([...world.done].sort()).toEqual([...clean.done].sort())
    }
  }, 120_000)
})
