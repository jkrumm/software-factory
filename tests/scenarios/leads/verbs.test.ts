import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { type LeadsWorld, startLeadsWorld } from './support.ts'

let w: LeadsWorld

beforeAll(async () => {
  w = await startLeadsWorld()
})

afterAll(async () => {
  await w.stop()
})

const body = (value: unknown) => JSON.stringify(value)

test('the lead closes its Issue done: finalize takes the terminal and the worktree away, once', async () => {
  const issue = await w.admitted()
  await w.tick()
  const [terminal] = w.terminals()
  expect(existsSync(terminal?.cwd ?? '')).toBe(true)

  const closed = await w.cli([
    'issue',
    'close',
    issue,
    '--body',
    body({ attempt: 1, outcome: 'done', reason: 'nothing to deploy', call: 'c1' }),
  ])
  expect(closed.code).toBe(0)
  expect(JSON.parse(closed.out)).toMatchObject({ result: 'applied', issue: { state: 'closed', outcome: 'done' } })

  // The same call again is the same event.
  const again = await w.cli([
    'issue',
    'close',
    issue,
    '--body',
    body({ attempt: 1, outcome: 'done', reason: 'nothing to deploy', call: 'c1' }),
  ])
  expect(JSON.parse(again.out)).toMatchObject({ result: 'replayed' })

  expect((await w.tick()).outbox.failed).toBe(0)
  expect(w.terminals()).toHaveLength(0)
  expect(existsSync(terminal?.cwd ?? '')).toBe(false)
  const [fin] = await w.world.db.sql`SELECT * FROM factory.lead_finalizations WHERE issue_id = ${issue}`
  expect(fin).toMatchObject({ attempt: 1, worktree_kept: null })
  expect(fin?.done_at).not.toBeNull()
  await w.tick()
  const done = await w.world.db.sql`SELECT 1 FROM factory.lead_finalizations WHERE issue_id = ${issue}`
  expect(done).toHaveLength(1)
})

test("defer and block are the lead's; a verb of another attempt is refused with exit 5", async () => {
  const issue = await w.admitted()
  await w.tick()
  const stale = await w.cli(['issue', 'block', issue, '--body', body({ attempt: 2, reason: 'wrong attempt' })])
  expect(stale.code).toBe(5)

  const deferred = await w.cli(['issue', 'defer', issue, '--body', body({ attempt: 1, after: ['issue_999'] })])
  expect(deferred.code).toBe(0)
  expect(JSON.parse(deferred.out)).toMatchObject({ issue: { state: 'waiting', waitReason: 'dependency' } })

  const blocked = await w.admitted()
  await w.tick()
  const result = await w.cli([
    'issue',
    'block',
    blocked,
    '--body',
    body({ attempt: 1, reason: 'the caller contract is broken' }),
  ])
  expect(JSON.parse(result.out)).toMatchObject({ issue: { state: 'waiting', waitReason: 'blocked' } })
})

test('a bad body is exit 2 and the bare Issue number works', async () => {
  const bad = await w.cli([
    'issue',
    'close',
    'issue_1',
    '--body',
    body({ attempt: 1, outcome: 'finished', reason: 'x' }),
  ])
  expect(bad.code).toBe(2)
  const missing = await w.cli(['lead', 'get', '999'])
  expect(missing.code).toBe(4)
})
