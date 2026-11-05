import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_HOLD_MS, IssueFactsRead } from '@software-factory/contract'
import { createIssue } from '../src/issues/create.ts'
import { kpis, listFacts } from '../src/issues/facts.ts'
import { enqueue } from '../src/issues/inbox.ts'
import { markEvent } from '../src/issues/shared.ts'
import { issuePass } from '../src/issues/worker.ts'
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

const REVIEW = { tier: 'standard', covered: true, uncovered: [], base: 'b'.repeat(40), head: 'c'.repeat(40) }
const DERIVED = {
  commits: ['a'.repeat(40)],
  paths: ['docs/x.md'],
  required: [],
  mergedAt: null,
  holdMs: DEFAULT_HOLD_MS,
  problem: null,
}
const GATED = new Set(['ship', 'close'])
const pass = () => issuePass(db.sql, { now: () => clock.now(), ports: {} })

async function file(): Promise<number> {
  const made = await createIssue(
    db.sql,
    { source: 'request', sourceKey: `k${++n}`, repo: TEST_REPO, title: 'a title', facts: {} },
    { repoRoots: [TEST_ROOT], now: clock.now() },
  )
  return made.issue.id
}

/** One event, handled, a second after the last: the way an Issue moves in these tests. */
async function step(issueId: number, kind: string, payload?: Record<string, unknown>) {
  clock.advance(1000)
  await enqueue(db.sql, {
    issueId,
    key: `${issueId}:${kind}:${++n}`,
    kind,
    at: clock.now(),
    payload: GATED.has(kind) ? { derived: DERIVED, commits: DERIVED.commits, ...payload } : payload,
  })
  expect(await pass()).toEqual([])
}

const iso = (offsetMs = 0) => new Date(clock.now().getTime() + offsetMs).toISOString()

async function working(): Promise<number> {
  const id = await file()
  await step(id, 'admitted')
  return id
}

/** Held once and green: ship, then the proof of hold 1. */
async function verifiedOnFirstHold(id: number, ship: Record<string, unknown> = {}) {
  await step(id, 'ship', ship)
  await step(id, 'hold_over', { hold: 1 })
  await step(id, 'verified', { hold: 1 })
}

const rowsOf = async (id: number) => (await listFacts(db.sql)).filter((r) => r.issueId === id)

describe('issue_facts: the attempts of an Issue', () => {
  test('two attempts: the first lost its lead (retried), the second verified on its first hold', async () => {
    const id = await working()
    const firstStart = iso()
    await step(id, 'lead_gone', { attempt: 1 })
    const secondStart = iso(1000)
    await step(id, 'admitted')
    await step(id, 'note', { text: 'look at x', who: 'owner' })
    await verifiedOnFirstHold(id, { derived: { ...DERIVED, mergedAt: '2026-11-01T10:00:00.000Z', review: REVIEW } })
    await db.sql`
      INSERT INTO factory.sessions (id, claude_session_id, created_at)
      VALUES (${`lead-${id}-2`}, 'claude-two', ${clock.now()}), (${`lead-${id}-1`}, NULL, ${clock.now()})`

    const [first, second, ...more] = await rowsOf(id)
    expect(more).toEqual([])
    expect(first).toMatchObject({
      issueId: id,
      attempt: 1,
      outcome: 'retried',
      admittedAt: firstStart,
      shippedAt: null,
      verifiedAt: null,
      closedAt: null,
      holds: 0,
      asks: 0,
      ownerTouches: 0,
      verifyFirstPass: false,
      reopened: false,
      parks: { wall: 0, lead_gone: 1, unreported: 0, parked: 0 },
      leadSessionIds: [],
    })
    expect(second).toMatchObject({
      attempt: 2,
      outcome: 'done',
      admittedAt: secondStart,
      landedAt: '2026-11-01T10:00:00.000Z',
      holds: 1,
      ownerTouches: 1,
      verifyFirstPass: true,
      reviewTier: 'standard',
      parks: { wall: 0, lead_gone: 0, unreported: 0, parked: 0 },
      leadSessionIds: ['claude-two'],
      repo: TEST_REPO,
    })
    expect(second?.verifiedAt).toBe(second?.closedAt ?? '')
    expect(Date.parse(second?.shippedAt ?? '')).toBeLessThan(Date.parse(second?.verifiedAt ?? ''))
    expect(second?.filedAt).toBe(first?.filedAt ?? '')
  })

  test('a red first hold, then verified, is not a first pass', async () => {
    const id = await working()
    await step(id, 'ship')
    await step(id, 'regression')
    await step(id, 'ship')
    await step(id, 'hold_over', { hold: 2 })
    await step(id, 'verified', { hold: 2 })
    expect(await rowsOf(id)).toMatchObject([{ attempt: 1, outcome: 'done', holds: 2, verifyFirstPass: false }])
  })

  test('a verify_red before the proof is not a first pass either', async () => {
    const id = await working()
    await step(id, 'ship')
    clock.advance(1000)
    await markEvent(db.sql, id, `verify_red:${id}:1`, 'verify_red', clock.now(), { hold: 1 })
    await step(id, 'verified', { hold: 1 })
    expect(await rowsOf(id)).toMatchObject([{ holds: 1, verifyFirstPass: false, outcome: 'done' }])
  })

  test('an Issue still in its first hold has no first pass yet', async () => {
    const id = await working()
    await step(id, 'ship')
    expect(await rowsOf(id)).toMatchObject([{ holds: 1, verifyFirstPass: false, verifiedAt: null, outcome: null }])
  })

  test('an ask, a block, an owner answer and an owner note count', async () => {
    const id = await working()
    await step(id, 'ask', { question: 'which?', default: 'a' })
    await step(id, 'answer', { answer: 'b', who: 'owner' })
    await step(id, 'block', { reason: 'needs a key' })
    await step(id, 'note', { text: 'hello' })
    expect(await rowsOf(id)).toMatchObject([{ asks: 2, ownerTouches: 2 }])
  })

  test('the default answer of an expired question is not an owner touch', async () => {
    const id = await working()
    await step(id, 'ask', { question: 'which?', default: 'a' })
    await step(id, 'answer', { answer: 'a', who: 'default' })
    expect(await rowsOf(id)).toMatchObject([{ asks: 1, ownerTouches: 0 }])
  })

  test('a note on a queued Issue belongs to its first attempt', async () => {
    const id = await file()
    await step(id, 'note', { text: 'before any lead' })
    await step(id, 'admitted')
    expect(await rowsOf(id)).toMatchObject([{ attempt: 1, ownerTouches: 1 }])
  })

  test('a park is counted by its reason', async () => {
    const id = await working()
    await step(id, 'park')
    expect(await rowsOf(id)).toMatchObject([{ parks: { wall: 0, lead_gone: 0, unreported: 0, parked: 1 } }])
  })

  test('an Issue dropped before any admission is attempt 0 with nothing past the filing', async () => {
    const id = await file()
    await step(id, 'stop')
    const [row, ...more] = await rowsOf(id)
    expect(more).toEqual([])
    expect(row).toMatchObject({
      attempt: 0,
      outcome: 'dropped',
      admittedAt: null,
      shippedAt: null,
      verifiedAt: null,
      holds: 0,
      asks: 0,
    })
    expect(row?.closedAt).not.toBeNull()
  })

  test('a reopen after the close is on the attempt that closed, which a later one followed', async () => {
    const id = await working()
    await step(id, 'close', { summary: 'done' })
    await step(id, 'reopen')
    await step(id, 'admitted')
    expect(await rowsOf(id)).toMatchObject([
      { attempt: 1, outcome: 'retried', reopened: true, ownerTouches: 1 },
      { attempt: 2, outcome: null, reopened: false, ownerTouches: 0 },
    ])
  })

  test('events with the same time are told apart by their id', async () => {
    const id = await working()
    for (const kind of ['lead_gone', 'admitted']) {
      await enqueue(db.sql, {
        issueId: id,
        key: `${id}:${kind}:same`,
        kind,
        at: clock.now(),
        payload: kind === 'lead_gone' ? { attempt: 1 } : undefined,
      })
      expect(await pass()).toEqual([])
    }
    expect(await rowsOf(id)).toMatchObject([
      { attempt: 1, parks: { lead_gone: 1 } },
      { attempt: 2, parks: { lead_gone: 0 } },
    ])
  })
})

describe('issue facts: the KPIs and the read', () => {
  /** A verified on its second attempt after a note; B green after a red hold; C asked and was answered; D dropped unadmitted; E a red check, then green. */
  async function seed() {
    const a = await working()
    await step(a, 'lead_gone', { attempt: 1 })
    await step(a, 'admitted')
    await step(a, 'note', { text: 'x', who: 'owner' })
    await verifiedOnFirstHold(a)

    const b = await working()
    await step(b, 'ship')
    await step(b, 'regression')
    await step(b, 'ship')
    await step(b, 'hold_over', { hold: 2 })
    await step(b, 'verified', { hold: 2 })

    const c = await working()
    await step(c, 'ask', { question: 'which?' })
    await step(c, 'answer', { answer: 'b', who: 'owner' })
    await verifiedOnFirstHold(c)

    clock.advance(60_000)
    const sinceD = clock.now()
    const d = await file()
    await step(d, 'stop')

    const e = await working()
    await step(e, 'ship')
    clock.advance(1000)
    await markEvent(db.sql, e, `verify_red:${e}:1`, 'verify_red', clock.now(), { hold: 1 })
    await step(e, 'verified', { hold: 1 })
    return { a, b, c, d, e, sinceD }
  }

  test('the four numbers, each with its numerator and denominator', async () => {
    const { a, b, c, d, e } = await seed()
    const rows = await listFacts(db.sql)
    expect(rows.map((r) => [r.issueId, r.attempt])).toEqual([
      [a, 1],
      [a, 2],
      [b, 1],
      [c, 1],
      [d, 0],
      [e, 1],
    ])
    // 5 Issues, one ask. Verified: A, B, C, E; of those with no ask and no owner touch: B and E.
    // Held attempts: A2, B1, C1, E1; green on the first hold: A2 and C1.
    expect(await kpis(db.sql)).toEqual({
      ownerAsksPerIssue: { value: 0.2, numerator: 1, denominator: 5 },
      zeroTouch: { value: 0.5, numerator: 2, denominator: 4 },
      verifyFirstHold: { value: 0.5, numerator: 2, denominator: 4 },
      windowPointsPerIssue: { value: null, source: 'usage-tracker' },
    })
  })

  test('since keeps the Issues filed at or after it, in the rows and in the KPIs', async () => {
    const { d, e, sinceD } = await seed()
    expect((await listFacts(db.sql, { since: sinceD })).map((r) => r.issueId)).toEqual([d, e])
    expect(await kpis(db.sql, { since: sinceD })).toMatchObject({
      ownerAsksPerIssue: { value: 0, numerator: 0, denominator: 2 },
      zeroTouch: { value: 1, numerator: 1, denominator: 1 },
      verifyFirstHold: { value: 0, numerator: 0, denominator: 1 },
    })
    expect(await listFacts(db.sql, { since: new Date(clock.now().getTime() + 1000) })).toEqual([])
  })

  test('over nothing every rate is null, with its counts', async () => {
    expect(await kpis(db.sql)).toMatchObject({
      ownerAsksPerIssue: { value: null, numerator: 0, denominator: 0 },
      zeroTouch: { value: null, numerator: 0, denominator: 0 },
      verifyFirstHold: { value: null, numerator: 0, denominator: 0 },
    })
  })

  test('the rows and the KPIs parse as the contract', async () => {
    await seed()
    const body = { rows: await listFacts(db.sql), kpi: await kpis(db.sql) }
    expect(IssueFactsRead.parse(JSON.parse(JSON.stringify(body)))).toEqual(body)
  })
})

describe('issue_facts: what it does not read', () => {
  test('neither the migration nor the read touches the usage tracker', () => {
    const migration = readFileSync(join(import.meta.dir, '..', 'migrations', '031_issue_facts.sql'), 'utf8')
    const read = readFileSync(join(import.meta.dir, '..', 'src', 'issues', 'facts.ts'), 'utf8')
    expect(migration).not.toMatch(/usage\./)
    expect(read).not.toMatch(/usage\./)
  })
})
