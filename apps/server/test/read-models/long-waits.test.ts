import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { NeedsModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import type { SQL } from 'bun'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { loadEdges } from '../../src/read/issues.ts'
import { readLongWaits } from '../../src/read/long-waits.ts'
import { needsModel, readNeeds } from '../../src/read/needs.ts'
import { loadNeedsSettings } from '../../src/read/needs-settings.ts'

/**
 * A timed wait that other open Issues wait behind reaches Needs you with its until-time and the count held only once its time
 * has passed and the Issue is still asleep (until then it is information: Flow shows the waiting Issue); a leaf, a short
 * wait and a wait that ended do not. Seeded with SQL over a real Postgres.
 */
let db: TestCluster
let sql: SQL
const NOW = new Date('2026-11-09T23:30:00Z')
const HOUR = 3_600_000
const at = (ms: number): Date => new Date(NOW.getTime() + ms)
const json = (value: unknown): string => JSON.stringify(value)

beforeAll(async () => {
  db = await startTestCluster()
  sql = db.sql
  await migrate(sql, await loadMigrations())
})
afterAll(() => db.stop())

beforeEach(async () => {
  await sql`TRUNCATE factory.planning_edges, factory.issue_events, factory.issues CASCADE`
})

let keys = 0
async function event(id: string, version: number, kind: string, when: Date, to: string, wait: unknown = null) {
  await sql`INSERT INTO factory.issue_events
    (id, issue_id, key, kind, payload, actor, at, result, version, from_state, to_state, wait)
    VALUES (${`event_${++keys}`}, ${id}, ${`key_${keys}`}, ${kind},
      ${json(kind === 'filed' ? { repo: 'app', title: 'Wait for the cooldown', kind: 'feature', origin: 'you' } : {})}::text::jsonb,
      'factory', ${when}, 'applied', ${version}, ${version === 1 ? null : 'working'}, ${to},
      ${wait === null ? null : json(wait)}::text::jsonb)`
}

/** An Issue deferred to a time at `deferredAt`, the wait the event `since` began. */
async function deferred(n: number, deferredAt: Date, until: Date) {
  const id = `issue_${n}`
  await sql`INSERT INTO factory.issues (id, repo, state, wait_reason, version) VALUES (${id}, 'app', 'waiting', 'timer', 2)`
  await event(id, 1, 'filed', at(-24 * HOUR), 'settling')
  await event(id, 2, 'deferred', deferredAt, 'waiting', {
    reason: 'timer',
    until: until.toISOString(),
    since: 2,
    told: 1,
  })
  return id
}

/** An open Issue that runs only after `blocker`, the way `planning_edges` stores it. */
async function after(n: number, blocker: string, state = 'queued') {
  const id = `issue_${n}`
  await sql`INSERT INTO factory.issues (id, repo, state, version) VALUES (${id}, 'app', ${state}, 1)`
  await event(id, 1, 'filed', at(-24 * HOUR), 'settling')
  await sql`INSERT INTO factory.planning_edges (issue_id, after_issue, created_at) VALUES (${id}, ${blocker}, ${at(-24 * HOUR)})`
  return id
}

/** An Issue in a dependency wait on `blockers`, the way a lead's `defer --after` stores it. */
async function waitingAfter(n: number, blockers: string[]) {
  const id = `issue_${n}`
  await sql`INSERT INTO factory.issues (id, repo, state, wait_reason, version) VALUES (${id}, 'app', 'waiting', 'dependency', 2)`
  await event(id, 1, 'filed', at(-24 * HOUR), 'settling')
  await event(id, 2, 'deferred', at(-HOUR), 'waiting', { reason: 'dependency', after: blockers, since: 2, told: 1 })
  return id
}

const longWaits = async (options?: { longWaitMs?: number }, now = NOW) =>
  (await readNeeds(sql, now, options)).items.filter((item) => item.kind === 'long_wait')

describe('a timed wait with Issues behind it', () => {
  test('a deferral past its time with 3 dependents appears with its until-time and the count 3', async () => {
    const head = await deferred(1, at(-3 * HOUR), at(-HOUR / 2))
    await after(2, head)
    await after(3, head, 'settling')
    await waitingAfter(4, [head])

    const model = NeedsModel.parse(needsModel(await readNeeds(sql, NOW), { redact: false }))
    expect(model.counts.long_wait).toBe(1)
    expect(model.items).toEqual([
      expect.objectContaining({
        kind: 'long_wait',
        id: head,
        issue: head,
        repo: 'app',
        title: 'Wait for the cooldown',
        since: at(-3 * HOUR).toISOString(),
        ageMs: 3 * HOUR,
        stale: false,
        link: { type: 'issue', id: head },
        origin: 'you',
        wait: { reason: 'timer', until: at(-HOUR / 2).toISOString(), held: 3 },
        redacted: false,
      }),
    ])
    expect(model.items[0]?.summary).not.toContain('T01:00')
    expect(model.items[0]?.summary).toContain('3 open Issues')
  })

  test('dependents count through the chain, once each, and a closed one is not held', async () => {
    const head = await deferred(1, at(-4 * HOUR), at(-HOUR))
    const middle = await after(2, head)
    await after(3, middle)
    await waitingAfter(4, [head, middle])
    const closed = await after(5, head)
    await sql`UPDATE factory.issues SET state = 'closed', outcome = 'done' WHERE id = ${closed}`

    expect((await longWaits())[0]?.wait).toMatchObject({ held: 3 })
  })

  test('each held Issue is listed with what it waits on directly, so a middle blocker shows', async () => {
    const head = await deferred(1, at(-4 * HOUR), at(-HOUR))
    const middle = await after(2, head)
    await after(3, middle)
    await waitingAfter(4, [head, middle])

    const [wait] = await readLongWaits(sql, HOUR)
    expect(wait?.held).toBe(3)
    expect(wait?.heldIssues).toEqual([
      { issue: 'issue_2', after: ['issue_1'] },
      { issue: 'issue_3', after: ['issue_2'] },
      { issue: 'issue_4', after: ['issue_1', 'issue_2'] },
    ])
  })

  test('an Issue shows its stored edges and dependency waits, and who waits on it', async () => {
    const head = await deferred(1, at(-4 * HOUR), at(-HOUR))
    const middle = await after(2, head)
    await waitingAfter(4, [head, middle])

    expect(await loadEdges(sql, middle)).toEqual({
      after: [{ issue: head, via: 'edge', open: true, satisfied: false }],
      before: [{ issue: 'issue_4', via: 'wait', open: true, satisfied: false }],
    })
    expect(await loadEdges(sql, 'issue_4')).toEqual({
      after: [
        { issue: head, via: 'wait', open: true, satisfied: false },
        { issue: middle, via: 'wait', open: true, satisfied: false },
      ],
      before: [],
    })
    expect((await loadEdges(sql, head)).before).toEqual([
      { issue: middle, via: 'edge', open: true, satisfied: false },
      { issue: 'issue_4', via: 'wait', open: true, satisfied: false },
    ])
  })

  test('a satisfied edge holds nobody back', async () => {
    const head = await deferred(1, at(-4 * HOUR), at(-HOUR))
    await after(2, head)
    await sql`UPDATE factory.planning_edges SET satisfied_at = ${at(-HOUR)}`

    expect(await longWaits()).toEqual([])
  })
})

describe('what stays off Needs you', () => {
  test('a timer still running is information, not a request: it stays off until its time has passed', async () => {
    const head = await deferred(1, at(-HOUR), at(3 * HOUR))
    await after(2, head)

    expect(await longWaits()).toEqual([])
    expect(needsModel(await readNeeds(sql, NOW), { redact: false }).counts.long_wait).toBe(0)
    // the same Issue, once its time has gone by
    expect(await longWaits(undefined, at(3 * HOUR + 60_000))).toHaveLength(1)
  })

  test('a deferred leaf Issue does not appear', async () => {
    await deferred(1, at(-HOUR), at(5 * HOUR))
    await sql`INSERT INTO factory.issues (id, repo, state, version) VALUES ('issue_2', 'app', 'queued', 1)`
    await event('issue_2', 1, 'filed', at(-HOUR), 'settling')

    expect(await longWaits()).toEqual([])
  })

  test('a wait shorter than the threshold does not appear, whatever is held behind it', async () => {
    const head = await deferred(1, at(-50 * 60_000), at(-10 * 60_000))
    await after(2, head)

    expect(await longWaits()).toEqual([])
    expect(await longWaits({ longWaitMs: 30 * 60_000 })).toHaveLength(1)
  })

  test('a dependency wait is not a timed one', async () => {
    const blocker = await deferred(1, at(-10 * 60_000), at(20 * 60_000))
    const head = await waitingAfter(2, [blocker])
    await after(3, head)

    expect(await longWaits()).toEqual([])
  })
})

describe('the entry clears with the wait', () => {
  test('when the Issue resumes', async () => {
    const head = await deferred(1, at(-4 * HOUR), at(-HOUR))
    await after(2, head)
    expect(await longWaits()).toHaveLength(1)

    await sql`UPDATE factory.issues SET state = 'working', wait_reason = NULL, version = 3 WHERE id = ${head}`
    await event(head, 3, 'woken', NOW, 'working')

    expect(await longWaits()).toEqual([])
  })

  test('when the Issue closes', async () => {
    const head = await deferred(1, at(-4 * HOUR), at(-HOUR))
    await after(2, head)
    expect(await longWaits()).toHaveLength(1)

    await sql`UPDATE factory.issues SET state = 'closed', wait_reason = NULL, outcome = 'dropped', version = 3 WHERE id = ${head}`
    await event(head, 3, 'closed', NOW, 'closed')

    expect(await longWaits()).toEqual([])
  })

  test('a deferral again starts a new wait from its own event', async () => {
    const head = await deferred(1, at(-4 * HOUR), at(-HOUR))
    await after(2, head)
    await sql`UPDATE factory.issues SET version = 3 WHERE id = ${head}`
    await event(head, 3, 'deferred', at(-5 * 60_000), 'waiting', {
      reason: 'timer',
      until: at(25 * 60_000).toISOString(),
      since: 3,
      told: 2,
    })

    expect(await longWaits()).toEqual([])
  })
})

describe('under the read token', () => {
  test('a work repo’s words go, its until-time and count stay', async () => {
    const head = await deferred(1, at(-4 * HOUR), at(-HOUR))
    await after(2, head)

    const read = needsModel(await readNeeds(sql, NOW), { redact: true })
    expect(read.items[0]).toMatchObject({
      redacted: true,
      wait: { reason: 'timer', until: at(-HOUR).toISOString(), held: 1 },
    })
    expect(read.items[0]?.title).not.toContain('cooldown')
  })
})

describe('the setting', () => {
  test('one hour unless FACTORY_LONG_WAIT_MS says otherwise', () => {
    expect(loadNeedsSettings({}).longWaitMs).toBe(HOUR)
    expect(loadNeedsSettings({ FACTORY_LONG_WAIT_MS: '1800000' }).longWaitMs).toBe(1_800_000)
    expect(() => loadNeedsSettings({ FACTORY_LONG_WAIT_MS: 'soon' })).toThrow('FACTORY_LONG_WAIT_MS')
  })
})
