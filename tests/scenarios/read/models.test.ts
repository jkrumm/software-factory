import { afterAll, beforeAll, expect, test } from 'bun:test'
import { ChainModel, FlowModel, FrictionModel, KpiModel, NeedsModel, type NeedItem } from '@software-factory/contract'
import { bearer, type Caller, startServer, type ServerProcess, startWorld, type World } from '../harness.ts'
import { type Estate, makeEstate, post } from '../intake/support.ts'

/**
 * The computed screens against the real server and Postgres: an Issue is filed through `POST /signals`, the checkpoints
 * the owner would see are rows in the world's database (a lead's `ask` needs a working lead; the read models are views of
 * those rows), and each model is read with the owner's token and the read token.
 */
let world: World
let estate: Estate
let server: ServerProcess
let open: string
let work: string

beforeAll(async () => {
  world = await startWorld()
  estate = await makeEstate(world, [{ repo: 'argo' }, { repo: 'chat', work: true }])
  server = await startServer(world, { env: estate.env })

  open = (await post(server, '/signals', { from: 'owner:hermes', repo: 'argo', title: 'Pick a logger' })).body.issue
  work = (await post(server, '/signals', { from: 'owner:hermes', repo: 'chat', title: 'Rotate the chat key' })).body
    .issue
  const sql = world.db.sql
  await sql`INSERT INTO factory.planning_projects (name, repo, source, project) VALUES
    ('argo', ${`${estate.sourceRoot}/argo`}, 'file', '{}'::jsonb),
    ('chat', ${`${estate.sourceRoot}/chat`}, 'defaults', '{}'::jsonb)
    ON CONFLICT (name) DO UPDATE SET source = EXCLUDED.source`
  await sql`INSERT INTO factory.decisions
    (id, key, issue_id, repo, attempt, question, recommendation, checked, options, no_answer, asked_at)
    VALUES ('decision_scn', 'scn-decision', ${open}, 'argo', 1, 'Which logging library should argo use?', 'pino',
      'read the sizes', '[]'::jsonb, '{"consequence":"console","default":"pino","waitMinutes":60}'::jsonb, now() - interval '2 hours')`
  await sql`INSERT INTO factory.decision_steps (decision_id, step, outcome, at) VALUES ('decision_scn', 'owner', 'open', now())`
  await sql`INSERT INTO factory.errands (id, key, issue_id, attempt, summary, detail, raised_at, reached_owner_at)
    VALUES ('errand_scn', 'scn-errand', ${work}, 1, 'Rotate the chat API key in the portal', NULL, now() - interval '1 hour', now() - interval '1 hour')`
  await sql`INSERT INTO factory.intake_signals (id, source, kind, origin, trust, repo, fingerprint, title, text, received_at, state)
    VALUES ('signal_scn', 'feedback', 'feedback', 'feedback', 'outside', 'chat', 'scn', 'A private complaint', 'private words', now(), 'held')`
}, 60_000)

afterAll(async () => {
  await server.stop()
  await estate.stop()
  await world.stop()
})

async function read<T>(path: string, parse: (json: unknown) => T, as: Caller = 'owner'): Promise<T> {
  const response = await fetch(`${server.url}${path}`, { headers: bearer(as) })
  const text = await response.text()
  if (response.status !== 200) throw new Error(`${path} answered ${response.status}: ${text}`)
  return parse(JSON.parse(text))
}

const needs = (as: Caller) => read('/v1/needs', (json) => NeedsModel.parse(json), as)
const item = (model: { items: NeedItem[] }, id: string) => {
  const found = model.items.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`no need ${id}`)
  return found
}

test('needs: the owner reads everything that waits, the read token gets the work repo’s words replaced', async () => {
  const owner = await needs('owner')
  expect(owner.counts).toEqual({ decision: 1, review: 0, errand: 1, held_signal: 1 })
  expect(item(owner, 'decision_scn')).toMatchObject({
    issue: open,
    repo: 'argo',
    title: 'Which logging library should argo use?',
    stale: false,
    link: { type: 'decision', id: 'decision_scn' },
    redacted: false,
  })
  expect(item(owner, 'decision_scn').defaultAt).not.toBeNull()
  expect(item(owner, 'errand_scn')).toMatchObject({ title: 'Rotate the chat API key in the portal', redacted: false })

  const reader = await needs('read')
  expect(reader.counts).toEqual(owner.counts)
  expect(item(reader, 'decision_scn').title).toBe('Which logging library should argo use?')
  for (const id of ['errand_scn', 'signal_scn']) {
    expect(item(reader, id)).toMatchObject({ redacted: true, repo: 'chat' })
    expect(JSON.stringify(item(reader, id))).not.toMatch(/Rotate|complaint|private words/)
  }
})

test('flow and chain list both Issues, whatever state the loops have moved them to', async () => {
  const flow = await read('/v1/flow', (json) => FlowModel.parse(json))
  const issues = Object.values(flow.states).flatMap((column) => column.issues)
  expect(issues.map((i) => i.id).sort()).toEqual([open, work].sort())
  expect(issues.find((i) => i.id === open)).toMatchObject({ repo: 'argo', title: 'Pick a logger', origin: 'you' })
  expect(flow.perProject.map((p) => [p.repo, p.open])).toEqual([
    ['argo', 1],
    ['chat', 1],
  ])

  const chain = await read('/v1/chain', (json) => ChainModel.parse(json))
  expect(chain.nodes.map((n) => n.id).sort()).toEqual([open, work].sort())
  expect(chain.edges).toEqual([])
})

test('kpis and friction count the two Issues; the read token may read them; a bad window is refused', async () => {
  const kpis = await read('/v1/kpis?days=7', (json) => KpiModel.parse(json))
  expect(kpis.days).toBe(7)
  const touches = kpis.kpis.find((k) => k.key === 'avoidable_touches')
  expect(touches).toMatchObject({ n: 2, count: 0, value: 0, measured: true })
  expect(kpis.kpis.find((k) => k.key === 'asks')).toMatchObject({ n: 2, count: 1, value: 0.5 })
  // no usage schema in this database: cost is unmeasured, not an error
  expect(kpis.kpis.find((k) => k.key === 'cost')).toMatchObject({ measured: false, value: null })

  const friction = await read('/v1/friction', (json) => FrictionModel.parse(json), 'read')
  expect(friction.issues).toBe(2)
  expect(friction.counts.find((c) => c.key === 'signal_held:total')?.count).toBe(1)

  const bad = await fetch(`${server.url}/v1/kpis?days=0`, { headers: bearer('owner') })
  expect(bad.status).toBe(422)
  expect((await fetch(`${server.url}/v1/needs`)).status).toBe(401)
})

test('signals under the read token carry no text of an outside signal', async () => {
  const response = await fetch(`${server.url}/v1/signals?state=held`, { headers: bearer('read') })
  expect(response.status).toBe(200)
  const body = (await response.json()) as { signals: { id: string; text: string; redacted: boolean }[] }
  expect(body.signals.find((s) => s.id === 'signal_scn')).toMatchObject({ text: '', redacted: true })
  const owner = (await (
    await fetch(`${server.url}/v1/signals?state=held`, { headers: bearer('owner') })
  ).json()) as typeof body
  expect(owner.signals.find((s) => s.id === 'signal_scn')).toMatchObject({ text: 'private words', redacted: false })
})
