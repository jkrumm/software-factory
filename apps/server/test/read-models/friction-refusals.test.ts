import { afterAll, beforeAll, expect, test } from 'bun:test'
import { FrictionModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import type { SQL } from 'bun'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { postgresRefusalSink } from '../../src/adapters/postgres/refusal-sink.ts'
import { readFriction } from '../../src/read/friction.ts'

/** The refused requests of the friction read, over a real Postgres. */
let db: TestCluster
let sql: SQL
const NOW = new Date('2026-11-22T12:00:00Z')
const ago = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000)

beforeAll(async () => {
  db = await startTestCluster()
  sql = db.sql
  await migrate(sql, await loadMigrations())
})
afterAll(() => db.stop())

test('the sink stores a refusal as columns, and friction counts them by operation and status with callers and fields', async () => {
  const sink = postgresRefusalSink(sql, (message) => {
    throw new Error(message)
  })
  const refuse = (operation: string, caller: 'owner' | 'agent', status: number, fields: string[], at = ago(2)) =>
    sink({ at, operation, caller, status, fields })
  refuse('issue.list', 'agent', 422, ['limit'])
  refuse('issue.list', 'agent', 422, ['limit', 'state'])
  refuse('issue.list', 'owner', 422, ['state'])
  refuse('issue.close', 'agent', 403, [])
  refuse('issue.list', 'agent', 422, ['limit'], ago(24 * 30))
  await Bun.sleep(300)

  const columns =
    await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'api_refusals' ORDER BY ordinal_position`
  expect(columns.map((c: { column_name: string }) => c.column_name)).toEqual([
    'id',
    'at',
    'operation',
    'caller',
    'status',
    'fields',
  ])

  const model = FrictionModel.parse(await readFriction(sql, { now: NOW, days: 7 }))
  const refused = model.counts.filter((c) => c.group === 'api_refused')
  expect(refused.find((c) => c.key === 'api_refused:total')?.count).toBe(4)
  const list = refused.find((c) => c.key === 'api_refused:issue.list:422')
  expect(list?.count).toBe(3)
  expect(list?.label).toBe('issue.list refused with 422 (agent 2, owner 1; fields: limit 2, state 2)')
  expect(refused.find((c) => c.key === 'api_refused:issue.close:403')?.count).toBe(1)
})
