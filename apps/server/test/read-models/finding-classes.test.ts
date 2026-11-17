import { afterAll, beforeAll, expect, test } from 'bun:test'
import { FindingClassesModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { createApp } from '../../src/api/app.ts'
import { findingClasses } from '../../src/app/loops/finding-classes.ts'
import { readClassSeats, readClassesOut } from '../../src/read/finding-seats.ts'
import { loopReads } from '../../src/read/loops.ts'

/** The finding classes over a real Postgres: held, probation and open in order, with their counts. */
let db: TestCluster
const NOW = new Date('2026-11-07T12:00:00Z')
const NO_STARTS = {
  starts: 0,
  movedUp: 0,
  finishedWatches: 0,
  finishedPassRate: null,
  windowStarts: 0,
  windowMovedUp: 0,
  windowShare: null,
  out: false,
  why: null,
}
const day = (month: number, d: number) => new Date(Date.UTC(2026, month - 1, d))
const TOKENS = {
  owner: 'owner-token-0123456789',
  agent: 'agent-token-0123456789',
  machine: 'door-token-0123456789',
  read: 'read-token-0123456789',
}

let n = 0
/** An Issue a class filed, closed (with an outcome) or still open. */
async function finding(loop: string, repo: string, cls: string, filed: Date, closed: Date | null, outcome?: string) {
  const id = `issue_${++n}`
  await db.sql`INSERT INTO factory.issues (id, repo, state, outcome, version)
    VALUES (${id}, ${repo}, ${closed ? 'closed' : 'queued'}, ${outcome ?? null}, ${closed ? 2 : 1})`
  await db.sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, to_state)
    VALUES (${`ev_f_${n}`}, ${id}, ${`k_f_${n}`}, 'filed', '{}'::jsonb, 'factory', ${filed}, 'applied', 1, 'settling')`
  if (closed)
    await db.sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, to_state)
      VALUES (${`ev_c_${n}`}, ${id}, ${`k_c_${n}`}, 'closed', '{}'::jsonb, 'factory', ${closed}, 'applied', 2, 'closed')`
  await db.sql`INSERT INTO factory.loop_findings (issue_id, loop, repo, class, key) VALUES (${id}, ${loop}, ${repo}, ${cls}, ${`${cls}:${n}`})`
}

/** The first lead of the Issue `n` back started, on the light seat (a rule) or the lead row, and moved up or not. */
async function lead(back: number, at: Date, light: boolean, movedUp: boolean) {
  const id = `issue_${n - back}`
  await db.sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, from_state, to_state)
    VALUES (${`ev_l_${id}`}, ${id}, ${`k_l_${id}`}, 'lead_started', ${{ attempt: 1, seat: light ? { rule: 'hygiene:links' } : { role: 'lead' } }}, 'factory', ${at}, 'applied', 10, 'working', 'working')`
  if (movedUp)
    await db.sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, from_state, to_state)
      VALUES (${`ev_m_${id}`}, ${id}, ${`k_m_${id}`}, 'moved_up', ${{ attempt: 1 }}, 'factory', ${at}, 'applied', 11, 'working', 'working')`
}

beforeAll(async () => {
  db = await startTestCluster()
  await migrate(db.sql, await loadMigrations())
  // open: two done, one dropped, one still open
  await finding('hygiene', 'app', 'links', day(10, 1), day(10, 2), 'done')
  await finding('hygiene', 'app', 'links', day(10, 3), day(10, 4), 'done')
  await finding('hygiene', 'app', 'links', day(10, 5), day(10, 6), 'dropped')
  await finding('hygiene', 'app', 'links', day(11, 5), null)
  // links: four Issues started light and three moved up; one shipped and passed its first watch, one shipped and regressed
  await lead(3, day(10, 1), true, true)
  await lead(2, day(10, 3), true, true)
  await lead(1, day(10, 5), true, false)
  await lead(0, day(11, 5), true, true)
  for (const [back, answer] of [
    [3, 'passed'],
    [2, 'regressed'],
  ] as const)
    await db.sql`INSERT INTO factory.quality_watches (key, issue_id, attempt, watch, started_at, window_ms, answer, answered_at)
      VALUES (${`w:${n - back}`}, ${`issue_${n - back}`}, 1, 1, ${day(10, 8)}, 0, ${answer}, ${day(10, 9)})`
  // held: three dropped or cancelled, the last closed 6 days ago
  await finding('hygiene', 'app', 'cochange', day(10, 25), day(10, 28), 'dropped')
  await finding('hygiene', 'web', 'cochange', day(10, 26), day(10, 30), 'cancelled')
  await finding('hygiene', 'app', 'cochange', day(10, 27), day(11, 1), 'dropped')
  // probation: the same, closed more than 14 days ago
  await finding('friction', 'software-factory', 'touch', day(9, 20), day(9, 25), 'dropped')
  await finding('friction', 'software-factory', 'touch', day(9, 21), day(9, 26), 'dropped')
  await finding('friction', 'software-factory', 'touch', day(9, 22), day(9, 27), 'cancelled')
})
afterAll(() => db.stop())

test('held first, then probation, then open, with the counts the verdict stands on', async () => {
  const seats = { bound: 0.5, byClass: await readClassSeats(db.sql, 0.5) }
  const model = FindingClassesModel.parse(await findingClasses(loopReads(db.sql), NOW, seats))
  expect(model.at).toBe(NOW.toISOString())
  expect(model.bound).toBe(0.5)
  expect(model.classes).toEqual([
    {
      loop: 'hygiene',
      class: 'cochange',
      status: 'held',
      issues: 3,
      decided: 3,
      noise: 3,
      share: 1,
      open: 0,
      heldUntil: day(11, 15).toISOString(),
      seat: { ...NO_STARTS },
    },
    {
      loop: 'friction',
      class: 'touch',
      status: 'probation',
      issues: 3,
      decided: 3,
      noise: 3,
      share: 1,
      open: 0,
      heldUntil: day(10, 11).toISOString(),
      seat: null,
    },
    {
      loop: 'hygiene',
      class: 'links',
      status: 'open',
      issues: 4,
      decided: 3,
      noise: 1,
      share: 1 / 3,
      open: 1,
      heldUntil: null,
      // four light starts, three moved up (75 %, above the bound 50 %); two first watches finished on the seat, one passed
      seat: {
        starts: 4,
        movedUp: 3,
        finishedWatches: 2,
        finishedPassRate: 0.5,
        windowStarts: 4,
        windowMovedUp: 3,
        windowShare: 0.75,
        out: true,
        why: '3 of its last 4 light starts moved up (75 %), above the bound 50 %',
      },
    },
  ])
})

test('a class is out above the bound and in again at or under it; with no bound none is out', async () => {
  expect(await readClassesOut(db.sql, 0.5)).toEqual(new Set(['links']))
  expect(await readClassesOut(db.sql, 0.75)).toEqual(new Set())
  expect(await readClassesOut(db.sql, null)).toEqual(new Set())
})

test('GET /v1/finding-classes answers the owner, the agent and the read token, and nobody without a token', async () => {
  const app = createApp({
    tokens: TOKENS,
    health: { read: () => Promise.reject(new Error('unused')) },
    log: () => {},
    readModels: { sql: db.sql, now: () => NOW },
  })
  const get = (token?: string) =>
    app.handle(
      new Request('http://localhost/v1/finding-classes', {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }),
    )
  expect((await get()).status).toBe(401)
  expect((await get(TOKENS.machine)).status).toBe(403)
  for (const token of [TOKENS.owner, TOKENS.agent, TOKENS.read]) {
    const response = await get(token)
    expect(response.status).toBe(200)
    expect(FindingClassesModel.parse(await response.json()).classes.map((c) => c.status)).toEqual([
      'held',
      'probation',
      'open',
    ])
  }
})
