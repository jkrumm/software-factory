import { afterAll, beforeAll, expect, test } from 'bun:test'
import { FrictionModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import type { SQL } from 'bun'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { readFriction } from '../../src/read/friction.ts'

/** The stall counts of the friction read, over a real Postgres: a block that moved a light lead up is the seat's cost, not a stall. */
let db: TestCluster
let sql: SQL
const NOW = new Date('2026-11-07T12:00:00Z')
const ago = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000)

beforeAll(async () => {
  db = await startTestCluster()
  sql = db.sql
  await migrate(sql, await loadMigrations())
})
afterAll(() => db.stop())

let keys = 0
async function event(
  issueId: string,
  version: number,
  kind: string,
  at: Date,
  from: string | null,
  to: string,
  wait?: object,
) {
  await sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, from_state, to_state, wait)
    VALUES (${`event_${++keys}`}, ${issueId}, ${`key_${keys}`}, ${kind}, '{}'::jsonb, 'factory', ${at}, 'applied', ${version},
      ${from}, ${to}, ${wait ? JSON.stringify(wait) : null}::text::jsonb)`
}

async function blocked(issueId: string, detail: string, movedUp: boolean) {
  await sql`INSERT INTO factory.issues (id, repo, state, wait_reason, version)
    VALUES (${issueId}, 'app', ${movedUp ? 'queued' : 'waiting'}, ${movedUp ? null : 'blocked'}, ${movedUp ? 5 : 4})`
  await event(issueId, 1, 'filed', ago(5), null, 'settling')
  await event(issueId, 2, 'settled', ago(4.9), 'settling', 'queued')
  await event(issueId, 3, 'admitted', ago(4.8), 'queued', 'working')
  await event(issueId, 4, 'stalled', ago(4.7), 'working', 'waiting', { reason: 'blocked', detail, since: 4, told: 4 })
  if (movedUp) await event(issueId, 5, 'moved_up', ago(4.7), 'waiting', 'queued')
}

test('a stall the next event moved up is not counted; one that waits on is', async () => {
  await blocked('issue_1', 'beyond the light seat', true)
  await blocked('issue_2', 'the repo has no CI', false)
  const model = FrictionModel.parse(await readFriction(sql, { now: NOW, days: 7 }))
  expect(model.counts.find((c) => c.key === 'stall:blocked')?.count).toBe(1)
})
