import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { lockCapacity } from '../src/capacity.ts'
import { createIssue } from '../src/issues/create.ts'
import { type Effect, type EffectPorts } from '../src/issues/effects.ts'
import { enqueue } from '../src/issues/inbox.ts'
import { noteText } from '../src/issues/lead.ts'
import { issuePass } from '../src/issues/worker.ts'
import { releaseClaim, tryClaim } from '../src/projects/claims.ts'
import { TEST_REPO, TEST_ROOT } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

let db: TestDb
let clock: FakeClock
let n = 0
let calls: { kind: string; payload: Record<string, unknown> | null }[] = []

beforeAll(async () => {
  db = await startTestDb()
})
afterAll(() => db.stop())
beforeEach(async () => {
  await db.reset()
  clock = new FakeClock()
  n = 0
  calls = []
  await db.sql`
    INSERT INTO factory.projects (name, repo, manifest, make_targets, synced_at, created_at)
    VALUES ('iris', ${TEST_REPO}, NULL, NULL, ${clock.now()}, ${clock.now()})`
})

const ports: EffectPorts = Object.fromEntries(
  (['start_lead', 'note_lead', 'verify', 'finalize'] as const).map((kind) => [
    kind,
    async (effect: Effect) => {
      calls.push({ kind, payload: effect.payload })
    },
  ]),
)

const pass = () => issuePass(db.sql, { now: () => clock.now(), ports })

async function file(): Promise<number> {
  const { issue } = await createIssue(
    db.sql,
    { source: 'request', sourceKey: `k${++n}`, repo: TEST_REPO, title: 'a title', facts: {} },
    { repoRoots: [TEST_ROOT], now: clock.now() },
  ).then((made) => ({ issue: made.issue }))
  await db.sql`UPDATE factory.issues SET classified_at = ${clock.now()} WHERE id = ${issue.id}`
  return issue.id
}

async function send(issueId: number, kind: string, payload?: Record<string, unknown>): Promise<void> {
  await enqueue(db.sql, { issueId, key: `${issueId}:${kind}:${++n}`, kind, at: clock.now(), payload })
  expect(await pass()).toEqual([])
}

const state = async (id: number): Promise<{ state: string; reason: string | null }> => {
  const [row]: { state: string; reason: string | null }[] =
    await db.sql`SELECT state, reason FROM factory.issues WHERE id = ${id}`
  if (!row) throw new Error(`no issue ${id}`)
  return row
}

/** The Issues holding or queued for the project's claim, as `id:held|queued`. */
const claims = async (): Promise<string[]> => {
  const rows: { issue_id: number; held: boolean }[] = await db.sql`
    SELECT issue_id, held_at IS NOT NULL AS held FROM factory.claims ORDER BY issue_id`
  return rows.map((r) => `${r.issue_id}:${r.held ? 'held' : 'queued'}`)
}

/** An Issue admitted the way admission does it: it takes the claim, then its lead is started. */
async function admitted(): Promise<number> {
  const id = await file()
  await pass()
  expect(await state(id)).toEqual({ state: 'working', reason: null })
  return id
}

/** What finalize's `giveBack` does for a closed Issue (the fake finalize port above does nothing). */
async function giveBack(id: number): Promise<void> {
  await db.sql.begin(async (tx) => {
    await lockCapacity(tx)
    await releaseClaim(tx, id)
  })
}

const notes = () => calls.filter((c) => c.kind === 'note_lead')

describe('a decision wait frees the repo', () => {
  test('the next Issue is admitted while the first waits on the owner, and the first keeps its Issue', async () => {
    const first = await admitted()
    const second = await file()
    await pass()
    expect(await state(second)).toEqual({ state: 'queued', reason: null })
    expect(await claims()).toEqual([`${first}:held`, `${second}:queued`])

    await send(first, 'ask', { question: 'which one?' })
    expect(await state(first)).toEqual({ state: 'waiting', reason: 'decision' })
    // released in the same pass, and the queued Issue took the place in the pass after
    await pass()
    expect(await state(second)).toEqual({ state: 'working', reason: null })
    expect(await claims()).toEqual([`${second}:held`])
    expect(await state(first)).toEqual({ state: 'waiting', reason: 'decision' })
  })

  test('a claim an Issue held before it asked is released by the next pass too', async () => {
    const first = await admitted()
    await db.sql`UPDATE factory.issues SET state = 'waiting', reason = 'decision' WHERE id = ${first}`
    expect(await claims()).toEqual([`${first}:held`])
    await pass()
    expect(await claims()).toEqual([])
  })
})

describe('an answer takes the claim back', () => {
  test('free: the Issue works again with the claim, and its lead is told the answer and to rebase', async () => {
    const id = await admitted()
    await send(id, 'ask', { question: 'which one?' })
    await pass()
    expect(await claims()).toEqual([])
    await send(id, 'answer', { answer: 'b', who: 'owner' })
    await pass()
    // answered, then given the claim and woken by the next pass
    expect(await state(id)).toEqual({ state: 'working', reason: null })
    expect(await claims()).toEqual([`${id}:held`])
    expect(notes()).toHaveLength(1)
    const text = noteText(id, { ...notes()[0]?.payload })
    expect(text).toContain('your question was answered: b')
    expect(text).toContain('rebase your branch onto the default branch')
  })

  test('held by another lead: the Issue waits for the claim, nobody works beside it, and it goes first when the claim is free', async () => {
    const first = await admitted()
    const second = await file()
    await pass()
    await send(first, 'ask', { question: 'q?' })
    await pass()
    expect(await state(second)).toEqual({ state: 'working', reason: null })
    const third = await file()
    await pass()

    await send(first, 'answer', { answer: 'yes', who: 'owner' })
    await pass()
    expect(await state(first)).toEqual({ state: 'waiting', reason: 'claim' })
    expect(await claims()).toEqual([`${first}:queued`, `${second}:held`, `${third}:queued`])
    expect(notes()).toHaveLength(0)

    // the working lead closes: the older waiting Issue is ahead of the Issue queued since
    await send(second, 'drop', { reason: 'not needed' })
    await giveBack(second)
    await pass()
    expect(await state(first)).toEqual({ state: 'working', reason: null })
    expect(await state(third)).toEqual({ state: 'queued', reason: null })
    expect(await claims()).toEqual([`${first}:held`, `${third}:queued`])
    expect(notes()).toHaveLength(1)
  })

  test('a note to a lead that has no place is not typed until it has one', async () => {
    const first = await admitted()
    await send(first, 'ask', { question: 'q?' })
    await send(first, 'note', { text: 'a fact' })
    expect(await state(first)).toEqual({ state: 'waiting', reason: 'decision' })
    // the fake port is called for it (the guard is in the real one); the effect itself is recorded
    const rows = await db.sql`SELECT 1 FROM factory.issue_effects WHERE issue_id = ${first} AND kind = 'note_lead'`
    expect(rows).toHaveLength(1)
  })

  test('closing a waiting Issue gives the claim it queued for back', async () => {
    const first = await admitted()
    const second = await file()
    await pass()
    await send(first, 'ask', { question: 'q?' })
    await pass()
    await send(first, 'answer', { answer: 'yes', who: 'owner' })
    await pass()
    expect(await state(first)).toEqual({ state: 'waiting', reason: 'claim' })
    await send(first, 'stop', { reason: 'no longer needed' })
    await giveBack(first)
    expect(await state(first)).toMatchObject({ state: 'closed' })
    expect(await claims()).toEqual([`${second}:held`])
  })

  test('tryClaim counts a waiting Issue as ahead of a younger one only while it waits for the claim', async () => {
    const first = await admitted()
    await send(first, 'ask', { question: 'q?' })
    await pass()
    const second = await file()
    await pass()
    await send(first, 'answer', { answer: 'x', who: 'owner' })
    const third = await file()
    await db.sql.begin(async (tx) => {
      await lockCapacity(tx)
      expect(await tryClaim(tx, third, clock.now())).toBe('queued')
    })
    expect(await state(second)).toEqual({ state: 'working', reason: null })
  })
})

describe('a timed wait frees the repo too', () => {
  const waitOf = (hours: number) => ({ until: new Date(clock.now().getTime() + hours * 3_600_000).toISOString() })

  test('the next Issue is admitted while the first counts for hours, and the first keeps its Issue', async () => {
    const first = await admitted()
    const second = await file()
    await pass()
    expect(await claims()).toEqual([`${first}:held`, `${second}:queued`])
    await send(first, 'wait', waitOf(24))
    expect(await state(first)).toEqual({ state: 'waiting', reason: 'wait' })
    await pass()
    expect(await state(second)).toEqual({ state: 'working', reason: null })
    expect(await claims()).toEqual([`${second}:held`])
    expect(await state(first)).toEqual({ state: 'waiting', reason: 'wait' })
  })

  test('the timer ends it through the claim: free, the lead is woken and told to rebase; held by another lead, it waits for it', async () => {
    const first = await admitted()
    await send(first, 'wait', waitOf(1))
    await pass()
    expect(await claims()).toEqual([])

    clock.advance(3_600_000)
    await pass()
    await pass()
    expect(await state(first)).toEqual({ state: 'working', reason: null })
    expect(await claims()).toEqual([`${first}:held`])
    expect(notes()).toHaveLength(1)
    const text = noteText(first, { ...notes()[0]?.payload })
    expect(text).toContain('your wait is over')
    expect(text).not.toContain('your question was answered')
    expect(text).toContain('rebase your branch onto the default branch')

    // a second wait of the same Issue ends by its own wake, not the first's
    const second = await file()
    await send(first, 'wait', waitOf(1))
    await pass()
    await pass()
    expect(await state(second)).toEqual({ state: 'working', reason: null })
    clock.advance(3_600_000)
    await pass()
    await pass()
    expect(await state(first)).toEqual({ state: 'waiting', reason: 'claim' })
    expect(await claims()).toEqual([`${first}:queued`, `${second}:held`])
    expect(notes()).toHaveLength(1)

    await send(second, 'drop', { reason: 'not needed' })
    await giveBack(second)
    await pass()
    expect(await state(first)).toEqual({ state: 'working', reason: null })
    expect(notes()).toHaveLength(2)
  })

  test('an owner note with wake, or the lead’s own phase, leaves the wait through the claim as well', async () => {
    const first = await admitted()
    await send(first, 'wait', waitOf(24))
    await pass()
    await send(first, 'note', { text: 'go on', wake: true })
    expect(await state(first)).toEqual({ state: 'waiting', reason: 'claim' })
    await pass()
    expect(await state(first)).toEqual({ state: 'working', reason: null })
    expect(await claims()).toEqual([`${first}:held`])

    await send(first, 'wait', waitOf(24))
    await pass()
    await send(first, 'phase', { phase: 'build' })
    expect(await state(first)).toEqual({ state: 'waiting', reason: 'claim' })
    await pass()
    expect(await state(first)).toEqual({ state: 'working', reason: null })
    expect(await claims()).toEqual([`${first}:held`])
  })
})
