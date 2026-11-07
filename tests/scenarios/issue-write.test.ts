import { afterAll, beforeAll, expect, test } from 'bun:test'
import { InternalTestEventAnswer, type InternalTestEventBody } from '@software-factory/contract'
import { bearer, type ServerProcess, startServer, startWorld, type World } from './harness.ts'

/**
 * An Issue from filed to closed through the write path, against the real server process and Postgres: the event log,
 * the version and the outbox. The entry is the internal test route (`FACTORY_INTERNAL_TEST_ROUTES=1`) until package 8.
 */
let world: World
let server: ServerProcess

beforeAll(async () => {
  world = await startWorld()
  server = await startServer(world, { env: { FACTORY_INTERNAL_TEST_ROUTES: '1' } })
})

afterAll(async () => {
  await server.stop()
  await world.stop()
})

async function post(path: string, body: InternalTestEventBody): Promise<InternalTestEventAnswer> {
  const response = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer() },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (response.status !== 200) throw new Error(`${path} answered ${response.status}: ${text}`)
  return InternalTestEventAnswer.parse(JSON.parse(text))
}

const FILED: InternalTestEventBody = {
  key: 'filed:signal:scenario-1',
  kind: 'filed',
  payload: { repo: 'example', title: 'the probe on /health fails', kind: 'bug', origin: 'infrastructure' },
  actor: 'factory',
}

/** The path after filed, each with its key: the same list twice is a replay. */
const PATH = (id: string): InternalTestEventBody[] => [
  { key: `${id}:settled`, kind: 'settled', payload: {}, actor: 'factory' },
  { key: `${id}:admitted:1`, kind: 'admitted', payload: {}, actor: 'factory' },
  {
    key: `${id}:lead_started:1`,
    kind: 'lead_started',
    payload: { attempt: 1, terminal: `lead-${id}-1` },
    actor: 'factory',
  },
  { key: `${id}:1:shipped:call-1`, kind: 'shipped', payload: { attempt: 1 }, actor: 'lead' },
  { key: `${id}:watch_passed:1`, kind: 'watch_passed', payload: { watch: 1 }, actor: 'factory' },
]

let issueId = ''

async function snapshot() {
  const sql = world.db.sql
  const [issue] = await sql`SELECT state, outcome, version FROM factory.issues WHERE id = ${issueId}`
  const events = await sql`
    SELECT kind, result, version, from_state, to_state FROM factory.issue_events WHERE issue_id = ${issueId} ORDER BY at, version`
  const effects =
    await sql`SELECT key, kind, done_at FROM factory.issue_effects WHERE issue_id = ${issueId} ORDER BY version, position`
  return { issue, events, effects }
}

test('filed, settled, admitted, lead started, shipped, watch passed: closed, with its log and its outbox', async () => {
  const filed = await post('/internal/test/issues', FILED)
  expect(filed).toMatchObject({ result: 'applied', issue: { state: 'settling', version: 1 } })
  issueId = filed.issue.id

  const answers = []
  for (const body of PATH(issueId)) answers.push(await post(`/internal/test/issues/${issueId}/events`, body))
  expect(answers.map((a) => [a.result, a.issue.state, a.issue.version])).toEqual([
    ['applied', 'queued', 2],
    ['applied', 'working', 3],
    ['applied', 'working', 4],
    ['applied', 'watching', 5],
    ['applied', 'closed', 6],
  ])

  const { issue, events, effects } = await snapshot()
  expect(issue).toEqual({ state: 'closed', outcome: 'done', version: 6 })
  expect(events).toEqual([
    { kind: 'filed', result: 'applied', version: 1, from_state: null, to_state: 'settling' },
    { kind: 'settled', result: 'applied', version: 2, from_state: 'settling', to_state: 'queued' },
    { kind: 'admitted', result: 'applied', version: 3, from_state: 'queued', to_state: 'working' },
    { kind: 'lead_started', result: 'applied', version: 4, from_state: 'working', to_state: 'working' },
    { kind: 'shipped', result: 'applied', version: 5, from_state: 'working', to_state: 'watching' },
    { kind: 'watch_passed', result: 'applied', version: 6, from_state: 'watching', to_state: 'closed' },
  ])
  // Nothing runs the outbox yet (no tick until package 4 or 7): the effects wait, in their order, undone.
  expect(effects).toEqual([
    { key: `start_lead:${issueId}:1`, kind: 'start_lead', done_at: null },
    { key: `start_watch:${issueId}:1`, kind: 'start_watch', done_at: null },
    { key: `finalize:${issueId}:1`, kind: 'finalize', done_at: null },
  ])
})

test('the same events again are replays: nothing doubles', async () => {
  const before = await snapshot()
  const filed = await post('/internal/test/issues', FILED)
  expect(filed).toMatchObject({ result: 'replayed', issue: { id: issueId, version: 6 } })
  for (const body of PATH(issueId)) {
    const again = await post(`/internal/test/issues/${issueId}/events`, body)
    expect(again).toMatchObject({ result: 'replayed', issue: { state: 'closed', version: 6 }, effects: [] })
  }
  expect(await snapshot()).toEqual(before)
  const [issues] = await world.db.sql`SELECT count(*)::int AS n FROM factory.issues`
  expect(issues?.n).toBe(1)
})

test('a closed Issue refuses a lead verb, stores the refusal and keeps its version', async () => {
  const refused = await post(`/internal/test/issues/${issueId}/events`, {
    key: `${issueId}:1:shipped:call-2`,
    kind: 'shipped',
    payload: { attempt: 1 },
    actor: 'lead',
  })
  expect(refused).toMatchObject({ result: 'refused', detail: 'it is closed: reopen it first', issue: { version: 6 } })
  const [row] = await world.db
    .sql`SELECT max(version) AS version, count(*)::int AS n FROM factory.issue_events WHERE issue_id = ${issueId}`
  expect(row).toEqual({ version: 6, n: 7 })
})

test('writing Issues called neither hc nor agw', async () => {
  expect(await world.calls()).toEqual([])
})
