import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import type { SQL } from 'bun'
import { loadMigrations, migrate } from '../src/adapters/postgres/migrate.ts'
import { postgresUnitOfWork } from '../src/adapters/postgres/unit-of-work.ts'
import { postgresWorkStore } from '../src/adapters/postgres/work-store.ts'
import { fileIssue, type IssueWrites, recordIssueEvent } from '../src/app/issues.ts'
import { runOutbox } from '../src/app/outbox.ts'
import type { EffectKind } from '../src/domains/work/effects.ts'
import type { AnyIssueEvent, EventKind, IssueEvent } from '../src/domains/work/events.ts'
import { OUTCOMES, STATES, WAIT_REASONS } from '../src/domains/work/issue.ts'
import type { EffectPorts, WorkStore } from '../src/domains/work/ports.ts'
import { fixedClock } from '../src/kernel/clock.ts'
import type { Actor } from '../src/kernel/events.ts'
import { type IssueId, sequentialIds } from '../src/kernel/ids.ts'
import { key } from '../src/kernel/keys.ts'
import { err, ok, portError, type Result } from '../src/kernel/result.ts'

let db: TestCluster

beforeAll(async () => {
  db = await startTestCluster()
})

afterAll(async () => {
  await db.stop()
})

const clock = fixedClock('2026-03-01T12:00:00Z')
let ids = sequentialIds()
let uow: IssueWrites
let deps: { uow: IssueWrites; clock: typeof clock; ids: typeof ids }

beforeEach(async () => {
  await db.sql`DROP SCHEMA IF EXISTS factory CASCADE`
  await migrate(db.sql, await loadMigrations())
  ids = sequentialIds()
  uow = postgresUnitOfWork(db.sql, (tx) => ({ work: postgresWorkStore(tx) }))
  deps = { uow, clock, ids }
})

const ev = <K extends EventKind>(kind: K, payload: IssueEvent<K>['payload'], actor: Actor) =>
  ({ kind, payload, actor }) as AnyIssueEvent

const filed: IssueEvent<'filed'> = {
  kind: 'filed',
  payload: { repo: 'example', title: 'the probe fails', kind: 'bug', origin: 'you' },
  actor: 'factory',
}

const value = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.value
}

async function newIssue(): Promise<IssueId> {
  return value(await fileIssue(deps, { key: key('filed', 'signal', ids.next('signal')), event: filed })).issue.id
}

const record = (issueId: IssueId, name: string, event: AnyIssueEvent) =>
  recordIssueEvent(deps, { issueId, key: key(issueId, name), event })

async function counts(sql: SQL) {
  const [row] = await sql`
    SELECT (SELECT count(*)::int FROM factory.issue_events) AS events,
           (SELECT count(*)::int FROM factory.issue_effects) AS effects,
           (SELECT max(version) FROM factory.issues) AS version`
  return row as { events: number; effects: number; version: number | null }
}

/** The error a promise rejects with; fails the test when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected a rejection')
}

describe('the write path', () => {
  test('event, state and outbox are stored together', async () => {
    const id = await newIssue()
    value(await record(id, 'settled', ev('settled', {}, 'factory')))
    const admitted = value(await record(id, 'admitted', ev('admitted', {}, 'factory')))
    expect(admitted).toMatchObject({ result: 'applied', issue: { state: 'working', version: 3, attempt: 1 } })
    const [issue] = await db.sql`SELECT state, version, wait_reason, outcome, repo FROM factory.issues WHERE id = ${id}`
    expect(issue).toEqual({ state: 'working', version: 3, wait_reason: null, outcome: null, repo: 'example' })
    const events =
      await db.sql`SELECT kind, result, version, from_state, to_state FROM factory.issue_events ORDER BY version`
    expect(events).toEqual([
      { kind: 'filed', result: 'applied', version: 1, from_state: null, to_state: 'settling' },
      { kind: 'settled', result: 'applied', version: 2, from_state: 'settling', to_state: 'queued' },
      { kind: 'admitted', result: 'applied', version: 3, from_state: 'queued', to_state: 'working' },
    ])
    const effects = await db.sql`SELECT key, kind, payload, version, event_id FROM factory.issue_effects`
    expect(effects).toEqual([
      {
        key: `start_lead:${id}:1`,
        kind: 'start_lead',
        payload: { attempt: 1 },
        version: 3,
        event_id: admitted.event.id,
      },
    ])
  })

  test('a refusal is stored as a fact and moves no version', async () => {
    const id = await newIssue()
    const refused = value(await record(id, 'ship', ev('shipped', { attempt: 1 }, 'lead')))
    expect(refused).toMatchObject({ result: 'refused', issue: { version: 1, state: 'settling' } })
    const [row] = await db.sql`SELECT result, version, detail FROM factory.issue_events WHERE kind = 'shipped'`
    expect(row).toEqual({ result: 'refused', version: null, detail: 'no lead works it yet' })
    expect((await counts(db.sql)).version).toBe(1)
  })

  test('the same key again is a replay: nothing doubles', async () => {
    const id = await newIssue()
    value(await record(id, 'settled', ev('settled', {}, 'factory')))
    value(await record(id, 'admitted', ev('admitted', {}, 'factory')))
    const before = await counts(db.sql)
    const again = value(await record(id, 'admitted', ev('admitted', {}, 'factory')))
    expect(again).toMatchObject({ result: 'replayed', issue: { version: 3 }, effects: [] })
    expect(await counts(db.sql)).toEqual(before)
    const taken = await recordIssueEvent(deps, {
      issueId: id,
      key: key(id, 'admitted'),
      event: ev('settled', {}, 'factory'),
    })
    expect(taken).toMatchObject({ ok: false, error: { kind: 'key_taken' } })
  })

  test('a stale version is a typed conflict, and nothing of it is stored', async () => {
    const id = await newIssue()
    value(await record(id, 'settled', ev('settled', {}, 'factory')))
    // A store that reads the Issue one event behind, as a writer that loaded before another committed would.
    const stale = postgresUnitOfWork(db.sql, (tx): { work: WorkStore } => {
      const work = postgresWorkStore(tx)
      return { work: { ...work, history: async (issue) => (await work.history(issue))?.slice(0, -1) ?? null } }
    })
    const before = await counts(db.sql)
    const conflict = await recordIssueEvent(
      { ...deps, uow: stale },
      {
        issueId: id,
        key: key(id, 'noted'),
        event: ev('noted', { text: 'hello' }, 'owner'),
      },
    )
    expect(conflict).toEqual({ ok: false, error: { kind: 'version_conflict', issueId: id, expected: 1 } })
    expect(await counts(db.sql)).toEqual(before)
    // The caller retries with a fresh load and the event applies.
    expect(value(await record(id, 'noted', ev('noted', { text: 'hello' }, 'owner'))).result).toBe('applied')
  })

  test('two writers at once: each applies or conflicts, and the version counts the applied ones', async () => {
    const id = await newIssue()
    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map((n) => record(id, `note-${n}`, ev('noted', { text: n }, 'owner'))),
    )
    for (const result of results) {
      if (!result.ok) expect(result.error).toMatchObject({ kind: 'version_conflict' })
    }
    const applied = results.filter((r) => r.ok).length
    expect(applied).toBeGreaterThan(0)
    expect((await counts(db.sql)).version).toBe(1 + applied)
  })

  test('an unknown Issue is a typed answer', async () => {
    const result = await record('issue_404' as IssueId, 'x', ev('settled', {}, 'factory'))
    expect(result).toMatchObject({ ok: false, error: { kind: 'unknown_issue', issueId: 'issue_404' } })
  })

  test('a close cancels the open effects but finalize', async () => {
    const id = await newIssue()
    value(await record(id, 'settled', ev('settled', {}, 'factory')))
    value(await record(id, 'admitted', ev('admitted', {}, 'factory')))
    value(await record(id, 'note', ev('noted', { text: 'also this' }, 'owner')))
    value(await record(id, 'cancel', ev('cancelled', { reason: 'not now' }, 'owner')))
    const rows =
      await db.sql`SELECT kind, cancelled_at IS NOT NULL AS cancelled FROM factory.issue_effects ORDER BY version`
    expect(rows).toEqual([
      { kind: 'start_lead', cancelled: true },
      { kind: 'note_lead', cancelled: true },
      { kind: 'finalize', cancelled: false },
    ])
  })

  test('the tables take every state, wait reason and outcome of the machine', async () => {
    await db.sql`INSERT INTO factory.issues (id, repo, state, version) VALUES ('issue_x', 'r', 'queued', 1)`
    for (const state of STATES) {
      const reason = state === 'waiting' ? 'timer' : null
      const outcome = state === 'closed' ? 'done' : null
      await db.sql`UPDATE factory.issues SET state = ${state}, wait_reason = ${reason}, outcome = ${outcome} WHERE id = 'issue_x'`
    }
    for (const reason of WAIT_REASONS) {
      await db.sql`UPDATE factory.issues SET state = 'waiting', wait_reason = ${reason}, outcome = NULL WHERE id = 'issue_x'`
    }
    for (const outcome of OUTCOMES) {
      await db.sql`UPDATE factory.issues SET state = 'closed', wait_reason = NULL, outcome = ${outcome} WHERE id = 'issue_x'`
    }
    expect(await rejection(db.sql`UPDATE factory.issues SET state = 'paused' WHERE id = 'issue_x'`)).toContain('check')
  })
})

/** Fake ports: each call says whether a transaction was open; a key already done acts no more (the port's contract). */
function fakePorts(failing = new Set<string>()) {
  const calls: { kind: EffectKind; key: string; inTransaction: boolean }[] = []
  const acts: string[] = []
  const port =
    (kind: EffectKind) =>
    async (effect: { key: string }): Promise<Result<void>> => {
      calls.push({ kind, key: effect.key, inTransaction: uow.inTransaction() })
      if (failing.has(effect.key)) return err(portError('timeout', 'the fake hung'))
      if (!acts.includes(effect.key)) acts.push(effect.key)
      return ok(undefined)
    }
  const ports: EffectPorts = {
    start_lead: port('start_lead'),
    note_lead: port('note_lead'),
    start_watch: port('start_watch'),
    finalize: port('finalize'),
  }
  return { ports, calls, acts }
}

describe('the outbox: claim, commit, call, record', () => {
  async function shippedIssue() {
    const id = await newIssue()
    for (const [name, event] of [
      ['settled', ev('settled', {}, 'factory')],
      ['admitted', ev('admitted', {}, 'factory')],
      ['ship', ev('shipped', { attempt: 1 }, 'lead')],
    ] as const) {
      value(await record(id, name, event))
    }
    return id
  }

  test('every port is called with no transaction open, in the order the Issue planned them', async () => {
    const id = await shippedIssue()
    const fake = fakePorts()
    expect(value(await runOutbox({ uow, clock, ports: fake.ports }))).toEqual({ ran: 1, failed: 0 })
    expect(value(await runOutbox({ uow, clock, ports: fake.ports }))).toEqual({ ran: 1, failed: 0 })
    expect(value(await runOutbox({ uow, clock, ports: fake.ports }))).toEqual({ ran: 0, failed: 0 })
    expect(fake.calls).toEqual([
      { kind: 'start_lead', key: `start_lead:${id}:1`, inTransaction: false },
      { kind: 'start_watch', key: `start_watch:${id}:1`, inTransaction: false },
    ])
    const rows = await db.sql`SELECT kind, done_at IS NOT NULL AS done FROM factory.issue_effects ORDER BY version`
    expect(rows).toEqual([
      { kind: 'start_lead', done: true },
      { kind: 'start_watch', done: true },
    ])
  })

  test('a port called from inside a transaction is a programming error', async () => {
    await shippedIssue()
    const fake = fakePorts()
    const inside = uow.run(async () => ok(await runOutbox({ uow, clock, ports: fake.ports })))
    expect(await rejection(inside)).toBe('a port is never called inside a transaction')
    expect(fake.calls).toEqual([])
  })

  test('a failed effect waits, and nothing of its Issue overtakes it', async () => {
    const id = await shippedIssue()
    const failing = new Set([`start_lead:${id}:1`])
    const fake = fakePorts(failing)
    expect(value(await runOutbox({ uow, clock, ports: fake.ports }))).toEqual({ ran: 1, failed: 1 })
    expect(value(await runOutbox({ uow, clock, ports: fake.ports }))).toEqual({ ran: 0, failed: 0 })
    clock.advance(30_000)
    failing.clear()
    expect(value(await runOutbox({ uow, clock, ports: fake.ports }))).toEqual({ ran: 1, failed: 0 })
    const [runs] =
      await db.sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE NOT ok)::int AS failed FROM factory.issue_effect_runs`
    expect(runs).toEqual({ n: 2, failed: 1 })
    expect(fake.calls.map((c) => c.kind)).toEqual(['start_lead', 'start_lead'])
  })

  test('a runner that died after the call: the claim lapses, the port is asked again by the same key and acts once', async () => {
    const id = await shippedIssue()
    const fake = fakePorts()
    // Claim and call, as a runner that dies before it records.
    const now = clock.now()
    const [claimed] = value(
      await uow.run(async ({ work }) =>
        ok(await work.claimEffects({ now, until: new Date(now.getTime() + 1_000), limit: 1 })),
      ),
    )
    if (!claimed) throw new Error('nothing claimed')
    await fake.ports.start_lead({ ...claimed, kind: 'start_lead', payload: { attempt: 1 } })
    expect(value(await runOutbox({ uow, clock, ports: fake.ports }))).toEqual({ ran: 0, failed: 0 })
    clock.advance(1_000)
    expect(value(await runOutbox({ uow, clock, ports: fake.ports }))).toEqual({ ran: 1, failed: 0 })
    expect(fake.calls.map((c) => c.key)).toEqual([`start_lead:${id}:1`, `start_lead:${id}:1`])
    expect(fake.acts).toEqual([`start_lead:${id}:1`])
  })
})
