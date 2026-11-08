import { afterAll, beforeAll, expect, test } from 'bun:test'
import { FindingClassesModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { createApp } from '../../src/api/app.ts'
import { findingClasses } from '../../src/app/loops/finding-classes.ts'
import { loopReads } from '../../src/read/loops.ts'

/** The finding classes over a real Postgres: held, probation and open in order, with their counts. */
let db: TestCluster
const NOW = new Date('2026-11-07T12:00:00Z')
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

beforeAll(async () => {
  db = await startTestCluster()
  await migrate(db.sql, await loadMigrations())
  // open: two done, one dropped, one still open
  await finding('hygiene', 'app', 'links', day(10, 1), day(10, 2), 'done')
  await finding('hygiene', 'app', 'links', day(10, 3), day(10, 4), 'done')
  await finding('hygiene', 'app', 'links', day(10, 5), day(10, 6), 'dropped')
  await finding('hygiene', 'app', 'links', day(11, 5), null)
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
  const model = FindingClassesModel.parse(await findingClasses(loopReads(db.sql), NOW))
  expect(model.at).toBe(NOW.toISOString())
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
    },
  ])
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
