import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  emptyWorkCounts,
  openOfWork,
  ProjectHygieneModel,
  ProjectIndexModel,
  ProjectPageModel,
  ProjectSetupModel,
} from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { createApp } from '../../src/api/app.ts'
import { JUDGMENT_PREFIX } from '../../src/domains/loops/hygiene.ts'
import { PROBES } from '../../src/domains/loops/hygiene-model.ts'
import { BUILT_IN_PROBES, DOCUMENT_PREFIX } from '../../src/read/project-page.ts'

/** `GET /v1/projects`, `/v1/projects/:name` and `/v1/projects/:name/hygiene`: every figure equals the stored facts, and a work project is not found for the read token. */
const TOKENS = {
  owner: 'owner-token-0123456789',
  agent: 'agent-token-0123456789',
  machine: 'door-token-0123456789',
  read: 'read-token-0123456789',
}
const T0 = new Date('2026-11-16T12:00:00Z')
const ago = (hours: number) => new Date(T0.getTime() - hours * 3_600_000)

let db: TestCluster
let app: ReturnType<typeof createApp>
let keys = 0

const call = (path: string, token: string) =>
  app.handle(new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${token}` } }))
const get = async (path: string, token = TOKENS.owner) => {
  const response = await call(path, token)
  expect(response.status).toBe(200)
  return response.json()
}

async function issue(id: string, repo: string, title: string, state: string, at: Date, outcome: string | null = null) {
  const wait = state === 'waiting' ? 'decision' : null
  await db.sql`INSERT INTO factory.issues (id, repo, state, version, outcome, wait_reason) VALUES (${id}, ${repo}, ${state}, 1, ${outcome}, ${wait})`
  await event(id, 1, 'filed', at, { payload: { repo, title, kind: 'feature', origin: 'you' }, to: state })
}

async function event(
  issueId: string,
  version: number,
  kind: string,
  at: Date,
  o: { payload?: unknown; outcome?: string; to?: string } = {},
) {
  await db.sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, to_state, outcome)
    VALUES (${`event_${++keys}`}, ${issueId}, ${`key_${keys}`}, ${kind}, ${JSON.stringify(o.payload ?? {})}::text::jsonb, 'factory', ${at},
      'applied', ${version}, ${o.to ?? 'queued'}, ${o.outcome ?? null})`
}

const project = {
  leads: 3,
  lanes: { apple: { leads: 1, memoryMib: 18432 } },
  slots: { run: '45m' },
  checks: { fast: 'make check-fast', full: 'make check', ci: true },
  deploy: {
    mode: 'make',
    hold: '30m',
    targets: [{ name: 'prod', host: 'macmini', verify: 'make verify' }],
    probes: [{ name: 'health', http: 'https://example.com/health' }],
  },
  hygiene: {
    check: false,
    reason: 'needs a lab',
    skip: [{ probe: 'browser', reason: 'no UI' }],
    probes: [{ name: 'bundle', target: 'bundle-size' }],
  },
  signals: { github: {}, kuma: {} },
}

beforeAll(async () => {
  db = await startTestCluster()
  await migrate(db.sql, await loadMigrations())
  app = createApp({
    tokens: TOKENS,
    health: { read: () => Promise.reject(new Error('unused')) },
    log: () => {},
    readModels: { sql: db.sql, now: () => T0 },
  })
  await db.sql`INSERT INTO factory.planning_projects (name, repo, source, project, plan, branch, synced_at) VALUES
    ('open-app', '/src/open-app', 'file', ${JSON.stringify(project)}::text::jsonb, '{"version":1,"rows":[]}'::jsonb, 'master', ${ago(1)}),
    ('work-app', '/src/work-app', 'file', '{"work":true}'::jsonb, NULL, 'main', ${ago(1)}),
    ('bare', '/src/bare', 'defaults', '{}'::jsonb, NULL, NULL, NULL)`

  await issue('issue_1', 'open-app', 'Working one', 'working', ago(2))
  await issue('issue_2', 'open-app', 'Waiting one', 'waiting', ago(3))
  await issue('issue_3', 'open-app', 'Queued one', 'queued', ago(1))
  await issue('issue_4', 'open-app', 'Held for Watch', 'watching', ago(5))
  // shipped: two in the last 7 days (today and 3 days ago), one in the 7 before, one older (not counted)
  await issue('issue_5', 'open-app', 'Shipped today', 'closed', ago(2), 'done')
  await issue('issue_6', 'open-app', 'Shipped earlier', 'closed', ago(80), 'healed')
  await issue('issue_7', 'open-app', 'Shipped last week', 'closed', ago(24 * 9), 'done')
  await issue('issue_8', 'open-app', 'Shipped long ago', 'closed', ago(24 * 20), 'done')
  await issue('issue_9', 'open-app', 'Dropped', 'closed', ago(10), 'dropped')
  await issue('issue_10', 'work-app', 'SECRET payroll export', 'working', ago(1))
  await event('issue_4', 2, 'regressed', ago(6), { payload: { watch: 1, detail: 'broke' }, to: 'waiting' })
  await db.sql`INSERT INTO factory.intake_incidents (issue_id, group_key, opened_at, last_alert_at) VALUES ('issue_3', 'prod', ${ago(4)}, ${ago(3)})`
  await db.sql`INSERT INTO factory.intake_door_routes (source, monitor, repo, quiet, last_event) VALUES
    ('kuma', 'open-app prod', 'open-app', 2, 'up'), ('kuma', 'other', 'work-app', 0, 'down')`

  const pass = (id: string, repo: string, at: Date, report: unknown, filed: unknown, over: unknown, failed: unknown) =>
    db.sql`INSERT INTO factory.hygiene_passes (id, repo, at, ref, report, judgment, filed, over_budget, failed)
      VALUES (${id}, ${repo}, ${at}, 'abc123', ${JSON.stringify(report)}::text::jsonb,
        '{"outcome":"answered","attempts":1,"judgedAt":null,"reason":"read 3","findings":[]}'::jsonb,
        ${JSON.stringify(filed)}::text::jsonb, ${JSON.stringify(over)}::text::jsonb, ${JSON.stringify(failed)}::text::jsonb)`
  await pass('hp_old', 'open-app', ago(24 * 8), { ref: 'old', runs: [], findings: [], stale: [], slop: [] }, [], [], [])
  await pass(
    'hp_new',
    '/src/open-app',
    ago(24),
    {
      ref: 'abc123',
      runs: [
        { probe: 'links', outcome: 'found', detail: 'links, 2s' },
        { probe: 'deps', outcome: 'clean', detail: 'deps, 5s' },
        { probe: 'probe', outcome: 'found', detail: 'bundle: make bundle-size, 3s, exit 1' },
      ],
      findings: [
        { probe: 'links', key: 'links:docs/a.md', title: 'Hygiene: broken links', count: 2 },
        { probe: 'probe', key: 'probe:bundle', title: 'Hygiene: project probe bundle is red', count: 1 },
        { probe: 'deps', key: 'deps', title: 'Hygiene: outdated', count: 3 },
      ],
      stale: [{}, {}],
      slop: [{}],
    },
    [
      { key: 'links:docs/a.md', title: 'Hygiene: broken links' },
      { key: 'judgment:docs/b.md', title: 'Stale doc b' },
    ],
    [{ key: 'probe:bundle', title: 'Hygiene: project probe bundle is red' }],
    [{ key: 'deps', reason: 'intake refused it' }],
  )
})
afterAll(() => db.stop())

test("the built-in probes and the judgment key prefix are the hygiene loop's", () => {
  expect([...BUILT_IN_PROBES]).toEqual(PROBES.filter((probe) => probe !== 'probe'))
  expect(DOCUMENT_PREFIX).toBe(JUDGMENT_PREFIX)
})

test('the list counts the Issues and names the newest hygiene pass', async () => {
  const model = ProjectIndexModel.parse(await get('/v1/projects'))
  const open = model.projects.find((p) => p.name === 'open-app')
  expect(open?.counts.done7d).toBe(2)
  expect(open?.counts.work).toMatchObject({ running: 1, checking: 1, paused: 1 })
  expect(openOfWork(open?.counts.work ?? emptyWorkCounts())).toBe(4)
  expect(open?.work).toBe(false)
  expect(open?.hygiene).toEqual({ lastPassAt: ago(24).toISOString(), outcome: 'answered', findings: 4 })
  expect(model.projects.find((p) => p.name === 'work-app')?.work).toBe(true)
  const bare = model.projects.find((p) => p.name === 'bare')
  expect(bare?.work).toBe(true)
  expect(bare?.hygiene).toEqual({ lastPassAt: null, outcome: null, findings: 0 })
})

test('the read token hears of no work project', async () => {
  const model = ProjectIndexModel.parse(await get('/v1/projects', TOKENS.read))
  expect(model.projects.map((p) => p.name)).toEqual(['open-app'])
  for (const path of ['/v1/projects/work-app', '/v1/projects/work-app/hygiene', '/v1/projects/bare']) {
    expect((await call(path, TOKENS.read)).status).toBe(404)
  }
  expect((await call('/v1/projects/work-app', TOKENS.owner)).status).toBe(200)
  expect((await call('/v1/projects/nothing', TOKENS.owner)).status).toBe(404)
  const page = ProjectPageModel.parse(await get('/v1/projects/open-app', TOKENS.read))
  expect(page.production.monitors).toEqual([])
})

test("the setup is the project.yaml in force as a form with the schema's descriptions, and as YAML", async () => {
  const setup = ProjectSetupModel.parse(await get('/v1/projects/open-app/setup'))
  expect(setup.project).toBe('open-app')
  const field = (path: string) => setup.fields.find((f) => f.path === path)
  expect(field('leads')).toMatchObject({ value: '3', isDefault: false })
  expect(field('leads')?.description).toContain('leads may work')
  expect(field('slots.run')).toMatchObject({ value: '45m', isDefault: false })
  expect(field('checks.fast')).toMatchObject({ value: 'make check-fast' })
  expect(field('deploy.hold')).toMatchObject({ value: '30m', isDefault: false })
  expect(field('deploy.hold')?.description).toContain('watched')
  expect(field('deploy.targets')?.value).toContain('verify: make verify')
  expect(field('lanes')?.value).toContain('memoryMib: 18432')
  // a parent whose children are listed carries no value of its own, and the children follow it in order
  expect(field('deploy')?.value).toBe('')
  expect(setup.fields.findIndex((f) => f.path === 'deploy')).toBeLessThan(
    setup.fields.findIndex((f) => f.path === 'deploy.hold'),
  )
  // a key the file does not set reads as unset and default; the dropped legacy keys are not part of the form
  expect(field('host')).toMatchObject({ value: '', isDefault: true })
  expect(field('jobs')).toBeUndefined()
  expect(setup.yaml).toContain('leads: 3')
  expect((await call('/v1/projects/work-app/setup', TOKENS.read)).status).toBe(404)
  expect((await call('/v1/projects/nothing/setup', TOKENS.owner)).status).toBe(404)
})

test('the page shows the shipped bars and the production facts', async () => {
  const page = ProjectPageModel.parse(await get('/v1/projects/open-app'))
  expect(page.branch).toBe('master')
  // 2 h ago and 80 h ago are in the last 7 days; 9 days ago is before; 20 days ago is out of both windows
  expect(page.shipped.days).toEqual([0, 0, 0, 1, 0, 0, 1])
  // the same by the hour: the last hour ends at the clock, so 2 h ago is the third bar from the end
  expect(page.shipped.hours).toHaveLength(168)
  expect(page.shipped.hours.at(-3)).toBe(1)
  expect(page.shipped.hours.at(-1 - 80)).toBe(1)
  expect(page.shipped.hours.reduce((a, b) => a + b, 0)).toBe(2)
  expect(page.shipped.before).toBe(1)
  expect(page.shipped.items.map((i) => i.id)).toEqual(['issue_5', 'issue_6'])
  expect(page.production.watching.map((i) => i.id)).toEqual(['issue_4'])
  expect(page.production.incidents).toEqual([
    { id: 'issue_3', title: 'Queued one', kind: 'feature', openedAt: ago(4).toISOString(), open: true },
  ])
  expect(page.production.regressions.map((r) => r.id)).toEqual(['issue_4'])
  expect(page.production.monitors).toEqual([
    { source: 'kuma', monitor: 'open-app prod', lastEvent: 'up', quiet: 2, lastQuietAt: null },
  ])
})

test('a path of the repo, or of a worktree below it, finds the project and names it', async () => {
  const page = ProjectPageModel.parse(
    await get(`/v1/projects/${encodeURIComponent('/src/open-app/.claude/worktrees/x')}`),
  )
  expect(page.name).toBe('open-app')
  expect(page.repo).toBe('/src/open-app')
  const hygiene = ProjectHygieneModel.parse(await get(`/v1/projects/${encodeURIComponent('/src/open-app')}/hygiene`))
  expect(hygiene.project).toBe('open-app')
})

test('the hygiene reads each probe, the newest pass and how each finding ended', async () => {
  const model = ProjectHygieneModel.parse(await get('/v1/projects/open-app/hygiene'))
  expect(model.skipCheck).toBe('needs a lab')
  const probe = (name: string) => model.probes.find((p) => p.name === name)
  expect(probe('check')).toMatchObject({ status: 'skipped', detail: 'needs a lab' })
  expect(probe('browser')).toMatchObject({ status: 'skipped', detail: 'no UI' })
  expect(probe('links')).toMatchObject({ status: 'found', findings: 1, detail: 'links, 2s' })
  expect(probe('deps')).toMatchObject({ status: 'clean', findings: 1 })
  expect(probe('retired')).toMatchObject({ status: 'never' })
  expect(probe('bundle')).toMatchObject({ declared: true, target: 'bundle-size', status: 'found', findings: 1 })
  expect(model.probes.length).toBe(BUILT_IN_PROBES.length + 1)
  expect(model.lastPass).toMatchObject({ id: 'hp_new', ref: 'abc123', findings: 4, filed: 2 })
  expect(model.documents).toEqual({ stale: 2, slop: 1 })
  const status = (key: string) => model.findings.find((f) => f.key === key)
  expect(status('links:docs/a.md')?.status).toBe('filed')
  expect(status('probe:bundle')?.status).toBe('left_out')
  expect(status('deps')).toMatchObject({ status: 'refused', reason: 'intake refused it' })
  expect(status('judgment:docs/b.md')).toMatchObject({ probe: 'document', status: 'filed', title: 'Stale doc b' })
  expect(model.passes.map((p) => p.id)).toEqual(['hp_new', 'hp_old'])
})

test('a project never swept lists its probes as never run', async () => {
  const model = ProjectHygieneModel.parse(await get('/v1/projects/work-app/hygiene'))
  expect(model.lastPass).toBeNull()
  expect(model.findings).toEqual([])
  expect(model.probes.every((p) => p.status === 'never')).toBe(true)
})
