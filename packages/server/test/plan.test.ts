import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_PLAN_BYTES, Project } from '@software-factory/contract'
import { healthKind, healthLines } from '../src/health.ts'
import { createIssue } from '../src/issues/create.ts'
import { foldReason } from '../src/notify/outbox.ts'
import { parsePlan } from '../src/projects/plan-file.ts'
import { projectPass } from '../src/projects/pass.ts'
import { ProjectSync } from '../src/projects/sync.ts'
import { startApp, type TestApp } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'
import { repoRoot } from './support/repos.ts'

const DAY = 86_400_000
let db: TestDb
let app: TestApp
let fixture = repoRoot()
let clock: FakeClock
let sync: ProjectSync
const roots: string[] = []

const manifest = (name: string) => `apiVersion: factory/v2\nname: ${name}\n`
const row = (key: string, extra = '') =>
  `  - key: ${key}\n    title: Row ${key}\n    facts: { why: because, what: ${key} }\n${extra}`
const planOf = (...rows: string[]) => `version: 1\nrows:\n${rows.join('')}`

beforeAll(async () => {
  db = await startTestDb()
  roots.push(fixture.root)
  app = startApp({
    sql: db.sql,
    clock: new FakeClock(),
    repoRoots: roots,
    projects: { syncNow: async () => ({ synced: 0, broken: [], errors: [] }) },
  })
})
afterAll(async () => {
  await app.stop()
  await db.stop()
  fixture.cleanup()
})
beforeEach(async () => {
  fixture.cleanup()
  fixture = repoRoot()
  roots[0] = fixture.root
  await db.reset()
  clock = new FakeClock()
  sync = new ProjectSync({ sql: db.sql, roots, now: () => clock.now() })
})

/** A repo with a manifest and this plan, synced. */
async function project(name: string, plan?: string): Promise<string> {
  const path = fixture.repo(name, { 'project.yaml': manifest(name), ...(plan ? { 'docs/plan.yaml': plan } : {}) })
  await sync.syncNow()
  return path
}
const pass = async () => {
  const result = await projectPass(db.sql, sync)
  return result.errors
}
const planIssues = async () =>
  (await db.sql`SELECT id, source_key, state, repo, facts FROM factory.issues WHERE source = 'plan' ORDER BY id`) as {
    id: number
    source_key: string
    state: string
    repo: string
    facts: Record<string, unknown>
  }[]
const keys = async () => (await planIssues()).map((i) => i.source_key)
const close = (id: number, at: Date = clock.now()) =>
  db.sql`UPDATE factory.issues SET state = 'closed', outcome = 'done', closed_at = ${at} WHERE id = ${id}`
const closeKey = async (key: string) => close((await planIssues()).find((i) => i.source_key === key)?.id ?? 0)
let seq = 0
const event = (issue: number, kind: string, at: Date, payload: object = {}) =>
  db.sql`INSERT INTO factory.issue_events (issue_id, key, kind, from_state, to_state, at, payload)
    VALUES (${issue}, ${`e${++seq}`}, ${kind}, NULL, NULL, ${at}, ${JSON.stringify(payload)}::text::jsonb)`
async function handIssue(repo: string): Promise<number> {
  const { issue } = await createIssue(
    db.sql,
    { source: 'request', sourceKey: `hand${++seq}`, repo, title: 'by hand', facts: {} },
    { repoRoots: roots, now: clock.now() },
  )
  return issue.id
}
const shown = async (name: string) => Project.parse(await (await app.get(`/projects/${name}`)).json())

describe('the plan file', () => {
  const ok = (text: string) => {
    const parsed = parsePlan(text)
    expect(parsed).toMatchObject({ ok: true })
    return parsed
  }
  const bad = (text: string): string => {
    const parsed = parsePlan(text)
    if (parsed.ok) throw new Error('parsed')
    return parsed.message
  }

  test('a valid plan, with every field', () => {
    const parsed = ok(
      planOf(
        row('a', '    repo: other\n    not_before: 2026-11-13\n    stable_days: 7\n'),
        row('b', '    after: [a]\n'),
        '  - key: c\n    issue: 150\n',
      ),
    )
    expect(parsed.ok && parsed.plan.rows.map((r) => r.key)).toEqual(['a', 'b', 'c'])
  })

  test('refuses a duplicate key, an unknown after, a cycle and a self wait', () => {
    expect(bad(planOf(row('a'), row('a')))).toContain('duplicate key a')
    expect(bad(planOf(row('a', '    after: [zzz]\n')))).toContain('unknown key zzz')
    expect(bad(planOf(row('a', '    after: [b]\n'), row('b', '    after: [a]\n')))).toContain('cycle: a -> b -> a')
    expect(bad(planOf(row('a', '    after: [a]\n')))).toContain('waits for itself')
  })

  test('an adopted row carries no condition; any other row needs a title and facts', () => {
    expect(bad(planOf('  - key: a\n    issue: 3\n    after: [b]\n', row('b')))).toContain('no after')
    expect(bad(planOf('  - key: a\n    issue: 3\n    stable_days: 7\n'))).toContain('no stable_days')
    expect(bad(planOf('  - key: a\n    facts: {}\n'))).toContain('title is required')
    expect(bad(planOf('  - key: a\n    title: t\n'))).toContain('facts is required')
  })

  test('refuses bad keys, dates, unknown fields, no rows, another version and a file that is too large', () => {
    expect(bad(planOf(row('Bad_Key')))).toContain('key')
    expect(bad(planOf(row('a', '    not_before: someday\n')))).toContain('ISO date')
    expect(bad(planOf(row('a', '    stable_days: 0\n')))).toContain('stable_days')
    expect(bad(planOf(row('a', '    typo: 1\n')))).toContain('typo')
    expect(bad('version: 1\nrows: []\n')).toContain('rows')
    expect(bad(planOf(row('a')).replace('version: 1', 'version: 2'))).toContain('version')
    expect(bad(`${planOf(row('a'))}# ${'x'.repeat(MAX_PLAN_BYTES)}\n`)).toContain('larger than')
    expect(bad('rows: [')).toContain('line')
  })

  test("this repo's docs/plan.yaml parses", async () => {
    const text = await Bun.file(join(import.meta.dir, '..', '..', '..', 'docs', 'plan.yaml')).text()
    const parsed = ok(text)
    expect(parsed.ok && parsed.plan.rows.map((r) => r.key)).toEqual([
      'intake',
      'surfaces',
      'apple-verify',
      'machine-budget',
      'repo-contract-audit',
      'docs-sweep',
      'parallel-leads',
    ])
  })
})

describe('the sync', () => {
  test('stores the plan beside the manifest; a broken edit keeps the last valid one; the file going makes it NULL', async () => {
    const path = await project('alpha', planOf(row('a')))
    const read = async () =>
      (await db.sql`SELECT plan, plan_sha, plan_error FROM factory.projects WHERE name = 'alpha'`)[0] as {
        plan: { rows: { key: string }[] } | null
        plan_sha: string | null
        plan_error: string | null
      }
    const first = await read()
    expect(first.plan?.rows.map((r) => r.key)).toEqual(['a'])
    expect(first.plan_error).toBeNull()

    fixture.commit(path, { 'docs/plan.yaml': 'version: 1\nrows: [' })
    await sync.syncNow()
    const broken = await read()
    expect(broken.plan?.rows.map((r) => r.key)).toEqual(['a'])
    expect(broken.plan_sha).toBe(first.plan_sha)
    expect(broken.plan_error).toContain('line')
    expect((await shown('alpha')).planError).toBe(broken.plan_error)

    fixture.commit(path, { 'docs/plan.yaml': planOf(row('a'), row('b')) })
    await sync.syncNow()
    expect(await read()).toMatchObject({ plan_error: null })
    expect((await read()).plan?.rows).toHaveLength(2)

    fixture.git(path, 'rm', '-q', 'docs/plan.yaml')
    fixture.git(path, 'commit', '-q', '-m', 'drop it')
    await sync.syncNow()
    expect(await read()).toEqual({ plan: null, plan_sha: null, plan_error: null })
  })

  test('a plan jsonb cannot store keeps the last valid plan, records the error, and the manifest edit in the same sync lands', async () => {
    const path = await project('alpha', planOf(row('a')))
    fixture.commit(path, {
      'docs/plan.yaml': planOf(row('a').replace('why: because', 'why: "a\\0b"')),
      'project.yaml': `${manifest('alpha')}leads: 3\n`,
    })
    await sync.syncNow()
    const view = await shown('alpha')
    expect(view.planError).toContain('cannot be stored')
    expect(view.plan?.rows.map((r) => r.key)).toEqual(['a'])
    expect(view.manifest.leads).toBe(3)
    const [stored] =
      await db.sql`SELECT plan->'rows'->0->'facts'->>'why' AS why FROM factory.projects WHERE name = 'alpha'`
    expect(stored.why).toBe('because')
  })

  test('refuses facts nested too deep', () => {
    const deep = `${'['.repeat(40)}${']'.repeat(40)}`
    expect(parsePlan(planOf(row('a').replace('what: a', `what: ${deep}`))).ok).toBe(false)
  })

  test('a plan that is not a regular file is an error, and a plan error files no upkeep Issue', async () => {
    const path = await project('alpha', planOf(row('a')))
    rmSync(join(path, 'docs', 'plan.yaml'))
    fixture.git(path, 'rm', '-q', '--cached', 'docs/plan.yaml')
    Bun.spawnSync(['ln', '-s', 'project.yaml', join(path, 'docs', 'plan.yaml')])
    fixture.git(path, 'add', '-A')
    fixture.git(path, 'commit', '-q', '-m', 'link')
    await sync.syncNow()
    expect((await shown('alpha')).planError).toContain('not a regular file')
    expect((await db.sql`SELECT count(*)::int AS n FROM factory.issues`)[0]).toEqual({ n: 0 })
  })
})

describe('the pass', () => {
  test('files only rows whose dependencies are closed, never twice, and the next one when a row closes', async () => {
    const path = await project('alpha', planOf(row('a'), row('b', '    after: [a]\n'), row('c', '    after: [b]\n')))
    expect(await pass()).toEqual([])
    expect(await keys()).toEqual(['alpha:a'])
    const [first] = await planIssues()
    expect(first?.repo).toBe(path)
    expect(first?.facts).toEqual({ why: 'because', what: 'a', plan: { project: 'alpha', key: 'a' } })

    await pass()
    await sync.syncNow()
    await pass()
    expect(await keys()).toEqual(['alpha:a'])
    expect((await db.sql`SELECT count(*)::int AS n FROM factory.issue_deps`)[0]).toEqual({ n: 0 })

    await closeKey('alpha:a')
    await pass()
    expect(await keys()).toEqual(['alpha:a', 'alpha:b'])
    await closeKey('alpha:b')
    await pass()
    await pass()
    expect(await keys()).toEqual(['alpha:a', 'alpha:b', 'alpha:c'])
  })

  test('a closed row is never filed again, whatever the outcome', async () => {
    await project('alpha', planOf(row('a')))
    await pass()
    const [issue] = await planIssues()
    await db.sql`UPDATE factory.issues SET state = 'closed', outcome = 'dropped', closed_at = ${clock.now()} WHERE id = ${issue?.id}`
    await pass()
    expect(await keys()).toEqual(['alpha:a'])
    const rows = (await shown('alpha')).plan?.rows
    expect(rows).toEqual([{ key: 'a', state: 'done', issue: issue?.id ?? 0, reason: null }])
  })

  test('an adopted row is done when its Issue closes, files nothing, and releases its dependents', async () => {
    const path = await project('alpha', planOf('  - key: hand\n    issue: 1\n', row('next', '    after: [hand]\n')))
    expect(await handIssue(path)).toBe(1)
    await pass()
    expect(await keys()).toEqual([])
    expect((await shown('alpha')).plan?.rows[0]).toMatchObject({ key: 'hand', state: 'open', issue: 1 })
    await close(1)
    await pass()
    expect(await keys()).toEqual(['alpha:next'])
  })

  test('not_before follows the clock', async () => {
    await project('alpha', planOf(row('a', '    not_before: 2026-11-13\n')))
    await pass()
    expect(await keys()).toEqual([])
    expect((await shown('alpha')).plan?.rows[0]).toMatchObject({ state: 'waiting', reason: 'not before 2026-11-13' })
    clock.advance(14 * DAY)
    await pass()
    expect(await keys()).toEqual(['alpha:a'])
  })

  test('stable_days: no closed Issue in the window is unmet; an owner touch resets it', async () => {
    const path = await project('alpha', planOf(row('a', '    stable_days: 7\n')))
    const done = await handIssue(path)
    await pass()
    expect(await keys()).toEqual([])
    expect((await shown('alpha')).plan?.rows[0]?.reason).toContain('no Issue closed')

    await close(done, new Date(clock.now().getTime() - DAY))
    const touchAt = new Date(clock.now().getTime() - 2 * DAY)
    await event(done, 'note', touchAt, { who: 'owner' })
    expect((await shown('alpha')).plan?.rows[0]?.reason).toBe(
      `stable for 7 days: owner touch on Issue ${done} ${touchAt.toISOString().slice(0, 16).replace('T', ' ')} UTC, first true ${new Date(touchAt.getTime() + 7 * DAY).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    )
    await pass()
    expect(await keys()).toEqual([])

    clock.advance(6 * DAY)
    await close(done)
    await pass()
    expect(await keys()).toEqual(['alpha:a'])
  })

  test('stable_days: prio, the steward and the default answer are not an owner touch; a stop, a retier and an owner answer are', async () => {
    const path = await project('alpha', planOf(row('a', '    stable_days: 7\n')))
    const done = await handIssue(path)
    await close(done)
    for (const [kind, payload] of [
      ['prio', { who: 'owner' }],
      ['note', { who: 'steward' }],
      ['answer', { who: 'default' }],
      ['answer', { who: 'closed' }],
      ['answer', { who: 'steward' }],
    ] as const) {
      await event(done, kind, clock.now(), payload)
    }
    expect((await shown('alpha')).plan?.rows[0]?.state).toBe('filable')
    for (const [kind, payload] of [
      ['stop', {}],
      ['retier', {}],
      ['answer', { who: 'owner' }],
      ['reopen', {}],
    ] as const) {
      await db.sql`DELETE FROM factory.issue_events WHERE issue_id = ${done} AND kind IN ('stop', 'retier', 'answer', 'reopen')`
      await event(done, kind, clock.now(), payload)
      expect((await shown('alpha')).plan?.rows[0]?.state).toBe('waiting')
    }
  })

  test('a row naming another project files there; an unknown project waits', async () => {
    const beta = await project('beta')
    await project('alpha', planOf(row('a', '    repo: beta\n'), row('b', '    repo: nowhere\n')))
    await pass()
    expect((await planIssues()).map((i) => [i.source_key, i.repo])).toEqual([['alpha:a', beta]])
    expect((await shown('alpha')).plan?.rows[1]).toMatchObject({ state: 'waiting', reason: 'unknown repo nowhere' })
  })

  test('a refused row is an error of the pass and the others are still filed', async () => {
    const beta = await project('beta')
    await project('alpha', planOf(row('a', '    repo: beta\n'), row('b')))
    rmSync(beta, { recursive: true, force: true })
    const errors = await pass()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('plan alpha:a')
    expect(await keys()).toEqual(['alpha:b'])
  })
})

describe('the health line', () => {
  const lines = async () => (await healthLines(db.sql, clock.now())).filter((l) => /^plan/.test(l))

  test('a plan that waits names the rows it waits for, three at most; a plan with an open Issue is silent', async () => {
    await project(
      'alpha',
      planOf(
        row('a', '    not_before: 2026-12-01\n'),
        row('b', '    not_before: 2026-12-02\n'),
        row('c', '    not_before: 2026-12-03\n'),
        row('d', '    not_before: 2026-12-04\n'),
        row('e', '    after: [a]\n'),
      ),
    )
    await pass()
    const [line] = await lines()
    expect(line).toBe(
      'plan of alpha: waits for a (not before 2026-12-01), b (not before 2026-12-02), c (not before 2026-12-03) and 1 more',
    )
    expect(healthKind(line ?? '')).toBe('machine')

    clock.advance(40 * DAY)
    await pass()
    expect(await lines()).toEqual([])
  })

  test('a plan that does not parse is a line while it is true', async () => {
    const path = await project('alpha', planOf(row('a')))
    await pass()
    fixture.commit(path, { 'docs/plan.yaml': 'version: 1\nrows: [' })
    await sync.syncNow()
    expect(await lines()).toEqual([expect.stringMatching(/^plan\.yaml of alpha does not parse: /)])
    fixture.commit(path, { 'docs/plan.yaml': planOf(row('a')) })
    await sync.syncNow()
    expect(await lines()).toEqual([])
  })
})

describe('the owner line', () => {
  const sent = async () => await db.sql`SELECT key, kind, issue_id, text FROM factory.notifications ORDER BY key`

  test('a finished plan in a project with nothing open tells the owner once per plan content', async () => {
    const path = await project('alpha', planOf(row('a')))
    await pass()
    expect(await sent()).toEqual([])
    await closeKey('alpha:a')
    await pass()
    await pass()
    const [message, ...rest] = await sent()
    expect(rest).toEqual([])
    expect(message).toMatchObject({ kind: 'plan', issue_id: null, text: 'The plan of alpha is finished: what next?' })
    expect(message?.key).toMatch(/^notify:plan:alpha:[0-9a-f]{64}$/)
    expect(foldReason(message?.key ?? '')).toBeNull()

    fixture.commit(path, { 'docs/plan.yaml': planOf(row('a'), row('b')) })
    await sync.syncNow()
    await pass()
    await closeKey('alpha:b')
    await pass()
    expect(await sent()).toHaveLength(2)
  })

  test('not while any Issue of the project is open', async () => {
    const path = await project('alpha', planOf(row('a')))
    await pass()
    await closeKey('alpha:a')
    const open = await handIssue(path)
    await pass()
    expect(await sent()).toEqual([])
    await close(open)
    await pass()
    expect(await sent()).toHaveLength(1)
  })
})
