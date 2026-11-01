import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Issue } from '@software-factory/contract'
import { type Effect, type EffectKind, type EffectPorts, runEffects } from '../src/issues/effects.ts'
import { enqueue } from '../src/issues/inbox.ts'
import { createIssue, DEFAULT_HOLD_MS, fireTimers, REOPEN_WINDOW_MS, TABLE } from '../src/issues/lifecycle.ts'
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

  test('the only statements that write issues.state are in the lifecycle module', async () => {
    const glob = new Bun.Glob('**/*.ts')
    const writers: string[] = []
    const root = `${import.meta.dir}/../src`
    for await (const path of glob.scan(root)) {
      const text = await Bun.file(`${root}/${path}`).text()
      if (/UPDATE factory\.issues[\s\S]{0,40}SET state|INSERT INTO factory\.issues \(state/.test(text))
        writers.push(path)
    }
    expect(writers).toEqual(['issues/lifecycle.ts'])
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

    await step(id, 'verified', undefined, world.ports)
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

  test('a dep on an unknown Issue, or on itself, is refused', async () => {
    const id = await working()
    await step(id, 'dep', { on: 999 })
    await step(id, 'dep', { on: id })
    expect((await state(id)).state).toBe('working')
    expect((await inbox(id)).slice(-2).map((r) => r.result)).toEqual(['refused', 'refused'])
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

  test('a handler that throws costs its own Issue this pass, says why, and nothing of it is half done', async () => {
    const bad = await working()
    const good = await working()
    await send(bad, 'phase')
    await send(bad, 'ask', { question: 'q', expiresAt: 'not a time' })
    await send(good, 'close')
    const errors = await processInbox(db.sql, now)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toStartWith(`issue ${bad}:`)
    expect((await state(good)).state).toBe('closed')
    expect((await state(bad)).state).toBe('working')
    const rows =
      await db.sql`SELECT kind, error, handled_at FROM factory.issue_inbox WHERE issue_id = ${bad} AND handled_at IS NULL ORDER BY id`
    expect(rows.map((r: { kind: string }) => r.kind)).toEqual(['phase', 'ask'])
    expect(rows[0].error).toBeString()
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

describe('effects', () => {
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
    await send(id, 'stop', undefined, 'stop')
    await processInbox(db.sql, now)
    const calls: string[] = []
    let failing = true
    const ports: EffectPorts = {
      start_lead: async (effect) => {
        calls.push(effect.key)
        if (failing) throw new Error('the runner is down')
      },
      finalize: async (effect) => {
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
    expect(calls).toEqual(['start_lead:admit', 'start_lead:admit', 'finalize:stop'])
    expect(await runEffects(db.sql, ports, now)).toEqual([])
    expect(calls).toHaveLength(3)
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
    { send: 'verified' },
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
    open: (await db.sql`SELECT 1 FROM factory.issue_effects WHERE done_at IS NULL`).length,
    unhandled: (await db.sql`SELECT 1 FROM factory.issue_inbox WHERE handled_at IS NULL`).length,
    decisions: (await db.sql`SELECT 1 FROM factory.decisions`).length,
  })

  async function reset(): Promise<number> {
    await db.reset()
    clock = new FakeClock()
    return (await file('replay')).id
  }

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
  })
})
