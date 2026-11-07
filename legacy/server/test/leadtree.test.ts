import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createIssue } from '../src/issues/create.ts'
import { WorktreeMaker } from '../src/issues/leadtree.ts'
import { TEST_REPO, TEST_ROOT } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'
import { FakeWorktrees } from './support/worktree.ts'

let db: TestDb
let clock: FakeClock
let worktrees: FakeWorktrees
let n = 0

beforeAll(async () => {
  db = await startTestDb()
})
afterAll(() => db.stop())
beforeEach(async () => {
  await db.reset()
  clock = new FakeClock()
  worktrees = new FakeWorktrees()
  n = 0
})

const maker = (options: { concurrency?: number } = {}) =>
  new WorktreeMaker({ sql: db.sql, worktrees, now: () => clock.now(), retryBudgetMs: 10 * 60_000, ...options })

async function working(attempt = 1): Promise<number> {
  const { issue } = await createIssue(
    db.sql,
    { source: 'request', sourceKey: `k${++n}`, repo: TEST_REPO, title: 't', facts: {} },
    { repoRoots: [TEST_ROOT], now: clock.now() },
  )
  await db.sql`UPDATE factory.issues SET state = 'working', attempt = ${attempt} WHERE id = ${issue.id}`
  return issue.id
}
const want = (issue: number, attempt: number) =>
  db.sql`
    INSERT INTO factory.lead_worktrees (issue_id, attempt, status, first_at, next_at)
    VALUES (${issue}, ${attempt}, 'pending', ${clock.now()}, ${clock.now()})`
const rows = (): Promise<{ issue_id: number; attempt: number; status: string; tries: number }[]> =>
  db.sql`SELECT issue_id, attempt, status, tries FROM factory.lead_worktrees ORDER BY issue_id, attempt`

describe('WorktreeMaker', () => {
  test('makes only the current attempt of an Issue, once, even with an older one pending', async () => {
    const id = await working(2)
    await want(id, 1)
    await want(id, 2)
    const pump = maker()
    await pump.start()
    await pump.settled()
    expect(worktrees.made.map((w) => w.branch)).toEqual([`factory/${id}-2`])
    expect(await rows()).toEqual([
      { issue_id: id, attempt: 1, status: 'pending', tries: 0 },
      { issue_id: id, attempt: 2, status: 'made', tries: 1 },
    ])
  })

  test('the retry budget runs from the first try that was started, not from the request', async () => {
    const [first, second] = [await working(), await working()] as [number, number]
    await want(first, 1)
    await want(second, 1)
    worktrees.failure = new Error('flaky')
    const pump = maker({ concurrency: 1 })
    await pump.start()
    await pump.settled()
    // The second waited behind the first for far longer than the budget; its first failure is its first, not its last.
    clock.advance(40 * 60_000)
    await db.sql`UPDATE factory.lead_worktrees SET next_at = ${clock.now()} WHERE issue_id = ${first}`
    await db.sql`UPDATE factory.lead_worktrees SET status = 'made' WHERE issue_id = ${first}`
    await pump.start()
    await pump.settled()
    expect((await rows()).find((r) => r.issue_id === second)).toMatchObject({ status: 'pending', tries: 1 })
  })

  test('after stop it starts nothing and waits for what runs', async () => {
    const id = await working()
    await want(id, 1)
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const create = worktrees.create.bind(worktrees)
    worktrees.create = async (input) => {
      await gate
      return create(input)
    }
    const pump = maker()
    await pump.start()
    const stopping = pump.stop(5_000)
    release()
    await stopping
    expect((await rows())[0]).toMatchObject({ status: 'made' })
    const later = await working()
    await want(later, 1)
    await pump.start()
    await pump.settled()
    expect((await rows()).find((r) => r.issue_id === later)).toMatchObject({ status: 'pending', tries: 0 })
  })
})
