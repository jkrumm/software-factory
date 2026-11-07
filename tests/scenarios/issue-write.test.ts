import { afterAll, beforeAll, expect, test } from 'bun:test'
import { admit, fileIssue, must, run, settle } from './flow.ts'
import { type LeadsWorld, startLeadsWorld } from './leads/support.ts'

/**
 * An Issue from filed to closed through the real routes, against the real server process and Postgres: the event log, the
 * version and the outbox. `issue new`, planning and capacity move it to `working`; the lead's `issue close` ends it. The
 * leads' loop never runs here, so the outbox rows wait undone, in their order.
 */
let w: LeadsWorld

beforeAll(async () => {
  w = await startLeadsWorld()
})

afterAll(async () => {
  await w.stop()
})

const KEY = 'filed-scenario-1'
const FILED = { repo: 'example', title: 'the probe on /health fails', key: KEY }
const CLOSE = ['--attempt', '1', '--outcome', 'done', '--reason', 'nothing to deploy', '--call', 'call-1']

let issueId = ''

async function snapshot() {
  const sql = w.world.db.sql
  const [issue] = await sql`SELECT state, outcome, version FROM factory.issues WHERE id = ${issueId}`
  const events = await sql`
    SELECT kind, result, version, from_state, to_state FROM factory.issue_events WHERE issue_id = ${issueId} ORDER BY at, version`
  const effects =
    await sql`SELECT key, kind, done_at FROM factory.issue_effects WHERE issue_id = ${issueId} ORDER BY version, position`
  return { issue, events, effects }
}

test('filed, settled, admitted, closed by its lead: closed, with its log and its outbox', async () => {
  issueId = await fileIssue(w, FILED)
  expect((await snapshot()).issue).toEqual({ state: 'settling', outcome: null, version: 1 })

  await settle(w, issueId)
  expect((await snapshot()).issue).toEqual({ state: 'queued', outcome: null, version: 2 })
  const admitted = await admit(w)
  expect(admitted.admitted.map((a) => [a.issue, a.attempt])).toEqual([[issueId, 1]])
  expect((await snapshot()).issue).toEqual({ state: 'working', outcome: null, version: 3 })

  const closed = await must(w, ['issue', 'close', issueId, ...CLOSE], 'agent')
  expect(closed.json).toMatchObject({ result: 'applied', issue: { state: 'closed', outcome: 'done', version: 4 } })

  const { issue, events, effects } = await snapshot()
  expect(issue).toEqual({ state: 'closed', outcome: 'done', version: 4 })
  expect(events).toEqual([
    { kind: 'filed', result: 'applied', version: 1, from_state: null, to_state: 'settling' },
    { kind: 'settled', result: 'applied', version: 2, from_state: 'settling', to_state: 'queued' },
    { kind: 'admitted', result: 'applied', version: 3, from_state: 'queued', to_state: 'working' },
    { kind: 'closed', result: 'applied', version: 4, from_state: 'working', to_state: 'closed' },
  ])
  // Nothing ran the outbox: the effects wait, in their order, undone.
  expect(effects).toEqual([
    { key: `start_lead:${issueId}:1`, kind: 'start_lead', done_at: null },
    { key: `finalize:${issueId}:1`, kind: 'finalize', done_at: null },
  ])
})

test('the same calls again are replays: nothing doubles', async () => {
  const before = await snapshot()
  const again = await must(w, ['issue', 'new', '--repo', FILED.repo, '--title', FILED.title, '--key', KEY])
  expect(again.json).toMatchObject({ issue: issueId, filed: false })
  expect((await must(w, ['issue', 'close', issueId, ...CLOSE], 'agent')).json).toMatchObject({
    result: 'replayed',
    issue: { state: 'closed', version: 4 },
  })
  const settled = await run(w, ['planning', 'settle', '--body', JSON.stringify({ issue: issueId, after: [] })])
  expect(settled.json).toMatchObject({ result: 'replayed' })
  expect((await admit(w)).admitted).toEqual([])
  expect(await snapshot()).toEqual(before)
  const [issues] = await w.world.db.sql`SELECT count(*)::int AS n FROM factory.issues`
  expect(issues?.n).toBe(1)
})

test('a closed Issue refuses a lead verb, stores the refusal once and keeps its version', async () => {
  const verb = [
    'issue',
    'close',
    issueId,
    '--attempt',
    '1',
    '--outcome',
    'dropped',
    '--reason',
    'too late',
    '--call',
    'call-2',
  ]
  const refused = await run(w, verb, 'agent')
  expect(refused.code).toBe(5)
  expect(refused.err).toContain('it is closed already')
  // The same call again is the stored refusal, not a second one.
  const again = await run(w, verb, 'agent')
  expect(again.json).toMatchObject({ result: 'replayed', detail: 'it is closed already', issue: { version: 4 } })
  const [row] = await w.world.db
    .sql`SELECT max(version) AS version, count(*)::int AS n FROM factory.issue_events WHERE issue_id = ${issueId}`
  expect(row).toEqual({ version: 4, n: 5 })
  const [refusal] = await w.world.db
    .sql`SELECT kind, result, detail FROM factory.issue_events WHERE issue_id = ${issueId} AND result = 'refused'`
  expect(refusal).toMatchObject({ kind: 'closed', result: 'refused', detail: 'it is closed already' })
})

test('writing Issues called neither hc nor agw', async () => {
  expect(await w.world.calls()).toEqual([])
})
