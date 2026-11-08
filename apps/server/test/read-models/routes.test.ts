import { afterAll, beforeAll, expect, test } from 'bun:test'
import { ChainModel, FlowModel, MachineModel, NeedsModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { createApp } from '../../src/api/app.ts'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'

/** The routes behind the real auth plugin: who may read, the redaction by caller, the days query, the unbound 503. */
const TOKENS = {
  owner: 'owner-token-0123456789',
  agent: 'agent-token-0123456789',
  machine: 'door-token-0123456789',
  read: 'read-token-0123456789',
}
let db: TestCluster
let app: ReturnType<typeof createApp>
const base = { tokens: TOKENS, health: { read: () => Promise.reject(new Error('unused')) }, log: () => {} }

const get = (target: ReturnType<typeof createApp>, path: string, token?: string) =>
  target.handle(new Request(`http://localhost${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }))

beforeAll(async () => {
  db = await startTestCluster()
  await migrate(db.sql, await loadMigrations())
  await db.sql`INSERT INTO factory.issues (id, repo, state, wait_reason, version) VALUES ('issue_1', 'work-app', 'waiting', 'errand', 2)`
  await db.sql`INSERT INTO factory.errands (id, key, issue_id, attempt, summary, raised_at)
    VALUES ('errand_1', 'k1', 'issue_1', 1, 'Rotate the key in the portal', now())`
  // issue_1 is in a repo no project.yaml describes (a work repo, even though the factory knows no project of that name);
  // issue_2 is in a project with a project.yaml of its own.
  await db.sql`INSERT INTO factory.issues (id, repo, state, version) VALUES ('issue_2', 'open-app', 'queued', 1)`
  await db.sql`INSERT INTO factory.planning_projects (name, repo, source, project, plan)
    VALUES ('open-app', '/src/open-app', 'file', '{}'::jsonb, '{"version":1,"rows":[]}'::jsonb)`
  for (const [n, id, repo, title] of [
    [1, 'issue_1', 'work-app', 'Fix SECRET payroll export'],
    [2, 'issue_2', 'open-app', 'Tidy the open app'],
  ] as const) {
    await db.sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, to_state)
      VALUES (${`event_${n}`}, ${id}, ${`key_${n}`}, 'filed', ${JSON.stringify({ repo, title, kind: 'feature', origin: 'you' })}::text::jsonb,
        'factory', now(), 'applied', 1, 'settling')`
  }
  // a work project (defaults only) with two plan rows, one after the other, and a queue scope of its own
  await db.sql`INSERT INTO factory.planning_projects (name, repo, source, project, plan)
    VALUES ('work-plan', '/src/work-plan', 'defaults', '{}'::jsonb, ${JSON.stringify({
      version: 1,
      rows: [
        { key: 'fix-payroll-export', title: 'SECRET plan row', facts: {} },
        { key: 'second', title: 'Second SECRET row', facts: {}, after: ['fix-payroll-export'] },
      ],
    })}::text::jsonb)`
  await db.sql`INSERT INTO factory.capacity_queue_states (project, state, set_at)
    VALUES ('work-plan', 'drain', now()), ('open-app', 'pace', now())`
  app = createApp({ ...base, readModels: { sql: db.sql } })
})
afterAll(() => db.stop())

test('every model answers the owner, the agent and the read token; nothing without a token', async () => {
  for (const path of ['/v1/needs', '/v1/flow', '/v1/chain', '/v1/kpis', '/v1/friction']) {
    expect((await get(app, path)).status).toBe(401)
    for (const token of [TOKENS.owner, TOKENS.agent, TOKENS.read])
      expect((await get(app, path, token)).status).toBe(200)
    expect((await get(app, path, TOKENS.machine)).status).toBe(403)
  }
})

test('needs: the owner reads the words of a work repo, the read token does not', async () => {
  const owner = NeedsModel.parse(await (await get(app, '/v1/needs', TOKENS.owner)).json())
  expect(owner.items[0]).toMatchObject({ id: 'errand_1', title: 'Rotate the key in the portal', redacted: false })
  const read = NeedsModel.parse(await (await get(app, '/v1/needs', TOKENS.read)).json())
  expect(read.items[0]).toMatchObject({ id: 'errand_1', kind: 'errand', issue: 'issue_1', redacted: true })
  expect(read.items[0]?.title).not.toContain('Rotate')
  expect(read.counts.errand).toBe(1)
})

test('days: 1 to 90, default 7; anything else is a 422 with an ErrorBody', async () => {
  const seven = (await (await get(app, '/v1/kpis', TOKENS.owner)).json()) as { days: number }
  expect(seven.days).toBe(7)
  const ninety = (await (await get(app, '/v1/friction?days=90', TOKENS.owner)).json()) as { days: number }
  expect(ninety.days).toBe(90)
  for (const days of ['0', '91', 'x', '-1', '7.5']) {
    const response = await get(app, `/v1/kpis?days=${days}`, TOKENS.owner)
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ code: 'invalid_request' })
  }
})

test('machine: the host reading with its ceilings for the owner and the read token; a failed reading is a 503', async () => {
  const reading = {
    load: 4.2,
    loadCeiling: 60,
    memory: { swapoutMbPer300s: 0, swapUsedPct: 12.5 },
    memoryCeilings: { swapoutMbPer300s: 2048, swapUsedPct: 75 },
  }
  const bound = createApp({ ...base, readModels: { sql: db.sql, machine: () => Promise.resolve(reading) } })
  expect((await get(bound, '/v1/machine')).status).toBe(401)
  expect((await get(bound, '/v1/machine', TOKENS.machine)).status).toBe(403)
  for (const token of [TOKENS.owner, TOKENS.read])
    expect(MachineModel.parse(await (await get(bound, '/v1/machine', token)).json())).toMatchObject(reading)
  const blind = createApp({ ...base, readModels: { sql: db.sql, machine: () => Promise.resolve(null) } })
  expect((await get(blind, '/v1/machine', TOKENS.owner)).status).toBe(503)
  expect((await get(app, '/v1/machine', TOKENS.owner)).status).toBe(503)
})

test('unbound, the models answer 503', async () => {
  const unbound = createApp(base)
  const response = await get(unbound, '/v1/flow', TOKENS.owner)
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ code: 'unavailable' })
})

test('flow and chain: the read token gets no title and no repo name of a work repo, and the owner does', async () => {
  for (const path of ['/v1/flow', '/v1/chain']) {
    const owner = await (await get(app, path, TOKENS.owner)).text()
    expect(owner).toContain('Fix SECRET payroll export')
    expect(owner).toContain('work-app')
    const read = await (await get(app, path, TOKENS.read)).text()
    expect(read).not.toContain('SECRET')
    expect(read).not.toContain('work-app')
    // an Issue of a project with its own project.yaml keeps its words
    expect(read).toContain('Tidy the open app')
  }
  // origin is a shape, not words: the read token sees it for a work repo's Issue too
  const flowRead = FlowModel.parse(await (await get(app, '/v1/flow', TOKENS.read)).json())
  const readIssues = Object.values(flowRead.states).flatMap((column) => column.issues)
  expect(readIssues.length).toBeGreaterThan(0)
  expect(readIssues.every((i) => typeof i.origin === 'string')).toBe(true)
})

test('signals: the read token gets no word of any signal', async () => {
  const { redactSignals } = await import('../../src/read/signals.ts')
  const [out] = redactSignals([
    {
      id: 'signal_1',
      source: 'owner:cli',
      kind: 'request',
      origin: 'you',
      trust: 'owner',
      repo: 'work-app',
      title: 'Fix SECRET payroll export',
      text: 'the text',
      link: 'https://example.com/secret',
      receivedAt: '2026-11-07T10:00:00.000Z',
      state: 'filed',
      issue: 'issue_1',
      dismissedReason: null,
      dismissedBy: null,
      screenNote: null,
      redacted: false,
    },
  ])
  expect(JSON.stringify(out)).not.toMatch(/SECRET|work-app|example\.com/)
  expect(out).toMatchObject({ id: 'signal_1', trust: 'owner', state: 'filed', issue: 'issue_1', redacted: true })
})

test('chain and flow: a work project’s plan rows, edges and queue scope leave no name for the read token', async () => {
  const owner = await (await get(app, '/v1/chain', TOKENS.owner)).text()
  expect(owner).toContain('row:work-plan:fix-payroll-export')
  const read = await (await get(app, '/v1/chain', TOKENS.read)).text()
  expect(read).not.toMatch(/work-plan|fix-payroll-export|SECRET/)
  const chain = ChainModel.parse(JSON.parse(read))
  // the two rows are still there, with an edge between them, under opaque ids
  const rows = chain.nodes.filter((node) => node.kind === 'row')
  expect(rows).toHaveLength(2)
  expect(chain.edges).toHaveLength(1)
  expect(rows.map((node) => node.id)).toContain(chain.edges[0]?.from ?? '')
  expect(rows.map((node) => node.id)).toContain(chain.edges[0]?.to ?? '')

  const flowOwner = FlowModel.parse(await (await get(app, '/v1/flow', TOKENS.owner)).json())
  expect(flowOwner.queueStates.projects).toEqual({ 'work-plan': 'drain', 'open-app': 'pace' })
  const flowRead = FlowModel.parse(await (await get(app, '/v1/flow', TOKENS.read)).json())
  expect(flowRead.queueStates.projects).toEqual({ 'open-app': 'pace' })
})
