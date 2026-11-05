import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Project, ProjectList, ProjectSyncResult, type Project as ProjectView } from '@software-factory/contract'
import { claimDue } from '../src/tick.ts'
import { EXIT_TIMEOUT, runProcess } from '../src/exec.ts'
import { createIssue } from '../src/issues/create.ts'
import { releaseClaim } from '../src/projects/claims.ts'
import { makeTargetsOf, readMakefile } from '../src/projects/make.ts'
import { parseManifest } from '../src/projects/manifest.ts'
import { projectPass } from '../src/projects/pass.ts'
import { ProjectSync } from '../src/projects/sync.ts'
import { createSpawn, IssueClosed } from '../src/spawns.ts'
import { startApp, TEST_TOKEN, type TestApp } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'
import { FakeRunner } from './support/world.ts'
import { repoRoot } from './support/repos.ts'

const CLI = join(import.meta.dir, '..', '..', 'cli', 'bin', 'factory.ts')
/** The roots the app and the sync read: one fresh directory of repos per test. */
const roots: string[] = []
let fixture = repoRoot()

const MANIFEST = `apiVersion: factory/v2
name: alpha
deploy:
  mode: make
  targets:
    - { name: local, host: mini, verify: make verify }
  hold: 45m
  migrations: [db/migrations/]
  probes:
    - { name: health, http: "https://example.com/health", expect: 204 }
ship:
  - { paths: ["docs/**"], via: push }
  - { paths: ["**"], via: pr }
leads: 2
signals: { kuma: [alpha] }
heal: [{ when: kuma.down, grace: 5m, runbook: make restart, max: 2 }]
jobs: [deps]
ticktick: { list: Alpha }
`
const MAKEFILE = `.DEFAULT_GOAL := help
.PHONY: help check test fmt deploy verify
VERSION := 1
export FLAG = on

help:
\t@echo help
check test: ## both targets of one rule
\t@true
deploy:: ; @true
verify: FLAG=on
verify:
\t@true
%.o: %.c
\t@true
include make/*.mk
-include $(HOME)/never.mk
`

let db: TestDb
let app: TestApp
let sync: ProjectSync
const clock = new FakeClock()
const issues = new Map<string, number>()

const runSync = () => sync.syncNow()
const getProject = async (name: string): Promise<ProjectView> =>
  Project.parse(await (await app.get(`/projects/${name}`)).json())
const upkeep = async () =>
  (await db.sql`SELECT id, source_key, title, repo FROM factory.issues WHERE source = 'upkeep' ORDER BY id`) as {
    id: number
    source_key: string
    title: string
    repo: string
  }[]

beforeAll(async () => {
  db = await startTestDb()
  roots.push(fixture.root)
  // The app syncs through whichever instance the test has made.
  app = startApp({ sql: db.sql, clock, repoRoots: roots, projects: { syncNow: () => sync.syncNow() } })
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
  issues.clear()
  sync = new ProjectSync({ sql: db.sql, roots, now: () => clock.now() })
})

const closeIssue = (id: number) =>
  db.sql`UPDATE factory.issues SET state = 'closed', outcome = 'done', closed_at = ${clock.now()} WHERE id = ${id}`

async function fileIssue(repo: string, key: string, urgent = false): Promise<number> {
  const { issue } = await createIssue(
    db.sql,
    { source: 'request', sourceKey: key, repo, title: `request ${key}`, facts: {} },
    { repoRoots: roots, now: clock.now() },
  )
  if (urgent) await db.sql`UPDATE factory.issues SET class = 'urgent' WHERE id = ${issue.id}`
  issues.set(key, issue.id)
  return issue.id
}

describe('a valid manifest', () => {
  test('is read from the default branch, defaults filled in, the keys of F3 ignored', async () => {
    fixture.repo('alpha', { 'project.yaml': MANIFEST, Makefile: 'check:\n\t@true\n' })
    const result = await runSync()
    expect(ProjectSyncResult.parse(result)).toEqual({ synced: 1, broken: [], errors: [] })

    const project = await getProject('alpha')
    expect(project).toMatchObject({ name: 'alpha', source: 'manifest', manifestError: null, paused: false })
    expect(project.manifest).toEqual({
      apiVersion: 'factory/v2',
      name: 'alpha',
      deploy: {
        mode: 'make',
        targets: [{ name: 'local', host: 'mini', verify: 'make verify' }],
        hold: '45m',
        migrations: ['db/migrations/'],
        probes: [{ name: 'health', http: 'https://example.com/health', expect: 204 }],
      },
      ship: [
        { paths: ['docs/**'], via: 'push' },
        { paths: ['**'], via: 'pr' },
      ],
      leads: 2,
    })
    expect(project.claim).toEqual({ leads: 2, holders: [], queued: [] })
    expect(project.syncedAt).toBe(clock.now().toISOString())
  })

  test('is read from the default branch, not from a feature branch or an edit that is not committed', async () => {
    const path = fixture.repo('onbranch', {
      'project.yaml': MANIFEST.replace('alpha', 'onbranch').replace('leads: 2', 'leads: 3'),
    })
    fixture.git(path, 'checkout', '-q', '-b', 'feature')
    fixture.commit(path, { 'project.yaml': MANIFEST.replace('alpha', 'onbranch').replace('leads: 2', 'leads: 5') })
    await Bun.write(join(path, 'project.yaml'), 'not: [valid')
    await runSync()
    expect((await getProject('onbranch')).manifest.leads).toBe(3)
  })

  test('a manifest that is taken away puts the project back on the defaults', async () => {
    const path = fixture.repo('gone', { 'project.yaml': MANIFEST.replace('alpha', 'gone') })
    await runSync()
    expect((await getProject('gone')).source).toBe('manifest')
    fixture.git(path, 'rm', '-q', 'project.yaml')
    fixture.git(path, 'commit', '-q', '-m', 'drop it')
    await runSync()
    expect(await getProject('gone')).toMatchObject({ source: 'defaults', manifestSha: null })
  })
})

describe('which commit is read', () => {
  const syncProject = async (name: string) => {
    await runSync()
    return getProject(name)
  }

  test('main is the default branch when it exists, and a master beside it is not read', async () => {
    const path = fixture.repo('both', {})
    fixture.git(path, 'branch', '-m', 'main')
    fixture.commit(path, { 'README.md': 'x' })
    fixture.git(path, 'branch', 'master')
    fixture.git(path, 'checkout', '-q', 'master')
    fixture.commit(path, { 'project.yaml': MANIFEST.replace('alpha', 'both') })
    fixture.git(path, 'checkout', '-q', 'main')
    await fileIssue(path, 'b1')
    expect(await syncProject('both')).toMatchObject({ source: 'defaults' })
  })

  test('origin/HEAD names the branch; a clone with no local branch of it reads the remote-tracking one', async () => {
    const origin = fixture.repo('upstream', {
      'project.yaml': MANIFEST.replace('alpha', 'cloned').replace('leads: 2', 'leads: 3'),
    })
    const clone = join(fixture.root, 'cloned')
    fixture.git(fixture.root, 'clone', '-q', origin, clone)
    fixture.git(clone, 'checkout', '-q', '--detach')
    fixture.git(clone, 'branch', '-D', 'master')
    expect((await syncProject('cloned')).manifest.leads).toBe(3)
  })

  test('the remote’s default branch decides, not a checkout that is behind, and sync asks the remote first', async () => {
    const origin = fixture.repo('fetched-origin', {})
    const clone = join(fixture.root, 'fetched')
    fixture.git(fixture.root, 'clone', '-q', origin, clone)
    fixture.commit(origin, { 'project.yaml': MANIFEST.replace('alpha', 'fetched') })
    const fetching = new ProjectSync({ sql: db.sql, roots: [fixture.root], now: () => clock.now(), fetch: true })
    await fileIssue(clone, 'f2')
    await sync.syncNow()
    await fetching.syncNow()
    expect((await getProject('fetched')).source).toBe('manifest')
    expect(fixture.git(clone, 'log', '--oneline', 'master', '--', 'project.yaml')).toBe('')
  })

  test('the tick’s sync fetches behind its back and reads the result on a later pass', async () => {
    const origin = fixture.repo('behind-origin', {})
    const clone = join(fixture.root, 'behind')
    fixture.git(fixture.root, 'clone', '-q', origin, clone)
    await fileIssue(clone, 'b1')
    let fetches = 0
    const counting: typeof runProcess = (cmd, ...rest) => {
      if (cmd.includes('fetch')) fetches++
      return runProcess(cmd, ...rest)
    }
    const syncing = new ProjectSync({
      sql: db.sql,
      roots: [fixture.root],
      now: () => clock.now(),
      fetch: true,
      run: counting,
    })
    // The first pass makes the row, so there is something to fetch from now on; the pass after a fetch reads and starts no other.
    await syncing.syncIfDue()
    await syncing.settled()
    await syncing.syncIfDue()
    fetches = 0
    fixture.commit(origin, { 'project.yaml': MANIFEST.replace('alpha', 'behind') })
    clock.advance(11 * 60_000)
    await syncing.syncIfDue()
    await syncing.settled()
    expect(fetches).toBeGreaterThan(0)
    const before = fetches
    await syncing.syncIfDue()
    expect((await getProject('behind')).source).toBe('manifest')
    expect(fetches).toBe(before)
  })

  describe('the sync a person waits for is bounded', () => {
    /** Twelve projects with rows, and a git whose fetches hang until their own timeout. */
    async function hanging(fetchBudgetMs: number) {
      for (let i = 0; i < 12; i++) fixture.repo(`slow${i}`, {})
      for (let i = 0; i < 12; i++) await fileIssue(join(fixture.root, `slow${i}`), `s${i}`)
      await runSync()
      const timeouts: number[] = []
      const run: typeof runProcess = async (cmd, timeoutMs, ...rest) => {
        if (!cmd.includes('fetch')) return runProcess(cmd, timeoutMs, ...rest)
        timeouts.push(timeoutMs ?? 0)
        await Bun.sleep(Math.min(timeoutMs ?? 0, 5_000))
        return { exitCode: EXIT_TIMEOUT, stdout: '' }
      }
      const syncing = new ProjectSync({
        sql: db.sql,
        roots: [fixture.root],
        now: () => clock.now(),
        fetch: true,
        fetchBudgetMs,
        run,
      })
      return { syncing, timeouts }
    }

    test('hung remotes cost the budget, not their timeouts one batch after the other; the pass still reads every repo', async () => {
      const { syncing, timeouts } = await hanging(300)
      const started = Date.now()
      const result = await syncing.syncNow()
      expect(Date.now() - started).toBeLessThan(3_000)
      expect(result).toMatchObject({ synced: 12, errors: [] })
      // Every fetch was cut to what was left of the budget, and the repos behind the first places were never started.
      expect(timeouts.length).toBeGreaterThan(0)
      expect(timeouts.length).toBeLessThan(12)
      expect(Math.max(...timeouts)).toBeLessThanOrEqual(300)
    })

    test('a fetch of the tick that never ends is joined for the budget, not waited for', async () => {
      const { syncing } = await hanging(200)
      const hung = Promise.withResolvers<void>()
      ;(syncing as unknown as { fetching: Promise<void> }).fetching = hung.promise
      const started = Date.now()
      const result = await syncing.syncNow()
      expect(Date.now() - started).toBeLessThan(3_000)
      expect(result.synced).toBe(12)
      hung.resolve()
    })
  })

  test('a repo whose default branch cannot be found keeps what its row has', async () => {
    const path = fixture.repo('renamed', { 'project.yaml': MANIFEST.replace('alpha', 'renamed') })
    await runSync()
    fixture.git(path, 'branch', '-m', 'develop')
    const result = await runSync()
    expect(result.errors).toEqual([])
    expect(await getProject('renamed')).toMatchObject({ source: 'manifest', manifestError: null })
  })

  test('a git that fails leaves the row as it was, and so does a file that is not a regular one', async () => {
    const path = fixture.repo('failing', { 'project.yaml': MANIFEST.replace('alpha', 'failing') })
    await runSync()
    const failing = new ProjectSync({
      sql: db.sql,
      roots,
      now: () => clock.now(),
      run: async (cmd) => ({
        exitCode: cmd.includes('ls-tree') ? 128 : 0,
        stdout: cmd.includes('rev-parse') ? 'ok' : '',
      }),
    })
    const result = await failing.syncNow()
    expect(result.errors.join()).toContain('git ls-tree failed')
    expect((await getProject('failing')).source).toBe('manifest')

    fixture.git(path, 'rm', '-q', 'project.yaml')
    fixture.commit(path, { 'real.yaml': MANIFEST.replace('alpha', 'failing') })
    fixture.git(
      path,
      'update-index',
      '--add',
      '--cacheinfo',
      `120000,${fixture.git(path, 'hash-object', '-w', '--stdin', '--path', 'x')},project.yaml`,
    )
    fixture.git(path, 'commit', '-q', '-m', 'link')
    await runSync()
    expect((await getProject('failing')).manifestError?.message).toContain('not a regular file')
  })

  test('a manifest larger than the limit is a broken one, and is not read into memory', async () => {
    const path = fixture.repo('huge', {})
    fixture.commit(path, { 'project.yaml': `apiVersion: factory/v2\nname: huge\n# ${'x'.repeat(70_000)}\n` })
    await runSync()
    expect(await getProject('huge')).toMatchObject({
      source: 'defaults',
      manifestError: { message: expect.stringContaining('larger than') },
    })
    expect(await upkeep()).toHaveLength(1)
  })
})

describe('a directory that cannot be a project’s name', () => {
  const insertBad = (name: string) => {
    const repo = join(fixture.root, name)
    return db.sql`
      INSERT INTO factory.projects (name, repo, manifest, make_targets, synced_at, created_at)
      VALUES (${name}, ${repo}, NULL, NULL, ${clock.now()}, ${clock.now()})`
  }

  test('an Issue naming such a repo makes no project: the sync says so, and every other project is listed', async () => {
    fixture.repo('good', { 'README.md': 'hi' })
    const hidden = fixture.repo('.hidden', { 'README.md': 'hi' })
    const spaced = fixture.repo('has space', { 'README.md': 'hi' })
    await fileIssue(join(fixture.root, 'good'), 'g1')
    await fileIssue(hidden, 'h1')
    await fileIssue(spaced, 's1')

    const result = await runSync()
    expect(result.synced).toBe(1)
    expect(result.errors.sort()).toEqual([
      '.hidden: the directory name is not a valid project name (letters, digits, dot, dash, underscore; no leading dot)',
      'has space: the directory name is not a valid project name (letters, digits, dot, dash, underscore; no leading dot)',
    ])
    expect(await db.sql`SELECT name FROM factory.projects ORDER BY name`).toEqual([{ name: 'good' }])
    const list = await app.get('/projects')
    expect(list.status).toBe(200)
    expect(ProjectList.parse(await list.json()).projects.map((p) => p.name)).toEqual(['good'])
  })

  test('a git directory with an odd name and no manifest, row or Issue is no project and no error', async () => {
    fixture.repo('good', { 'README.md': 'hi' })
    fixture.repo('has space', { 'README.md': 'hi' })
    await fileIssue(join(fixture.root, 'good'), 'g1')

    const result = await runSync()
    expect(result.errors).toEqual([])
    expect(await db.sql`SELECT name FROM factory.projects ORDER BY name`).toEqual([{ name: 'good' }])
  })

  test('a row stored before that rule does not fail the list or the show, and later syncs leave it alone and silent', async () => {
    fixture.repo('good', { 'README.md': 'hi' })
    await fileIssue(join(fixture.root, 'good'), 'g1')
    await insertBad('.agw-verify')
    await runSync()

    const list = await app.get('/projects')
    expect(list.status).toBe(200)
    expect(ProjectList.parse(await list.json()).projects.map((p) => p.name)).toEqual(['good'])
    expect((await app.get('/projects/.agw-verify')).status).toBe(400)
    expect((await app.get('/projects/good')).status).toBe(200)
    const again = await runSync()
    expect(again.errors).toEqual([])
    expect(await db.sql`SELECT name FROM factory.projects WHERE name = '.agw-verify'`).toHaveLength(1)
  })
})

describe('no manifest', () => {
  test('a repo that nothing names is no project; a repo an Issue names gets the defaults', async () => {
    const quiet = fixture.repo('quiet', { 'README.md': 'hi' })
    const named = fixture.repo('named', { 'README.md': 'hi' })
    await fileIssue(named, 'n1')
    await runSync()

    expect((await app.get('/projects/quiet')).status).toBe(404)
    const project = await getProject('named')
    expect(project).toMatchObject({ source: 'defaults', manifestSha: null, manifestError: null, repo: named })
    expect(project.manifest).toEqual({
      apiVersion: 'factory/v2',
      name: 'named',
      deploy: { mode: 'none', targets: [], hold: '0m', migrations: [], probes: [] },
      ship: [{ paths: ['**'], via: 'push' }],
      leads: 1,
    })
    expect(quiet).toBeTruthy()
    expect(ProjectList.parse(await (await app.get('/projects')).json()).projects.map((p) => p.name)).toEqual(['named'])
  })

  test('a repo a worktree of which a spawn names is the repo itself', async () => {
    const repo = fixture.repo('trunk', {})
    const worktree = join(repo, '.claude', 'worktrees', 'w1')
    mkdirSync(worktree, { recursive: true })
    await fileIssue(worktree, 'w1')
    await runSync()
    expect((await getProject('trunk')).repo).toBe(repo)
    expect((await app.get('/projects/w1')).status).toBe(404)
  })
})

describe('a broken manifest', () => {
  test('keeps the last valid version, opens one upkeep Issue per content, and none for a repeat', async () => {
    const path = fixture.repo('delta', { 'project.yaml': MANIFEST.replace('alpha', 'delta') })
    await runSync()
    const valid = await getProject('delta')
    expect(valid.manifest.leads).toBe(2)

    fixture.commit(path, { 'project.yaml': MANIFEST.replace('alpha', 'delta').replace('leads: 2', 'leads: many') })
    const first = await runSync()
    const broken = await getProject('delta')
    expect(broken.manifest).toEqual(valid.manifest)
    expect(broken.manifestSha).toBe(valid.manifestSha)
    expect(broken.manifestError?.message).toContain('leads')
    expect(first.broken).toEqual([{ project: 'delta', issue: broken.manifestError?.issue ?? null }])
    const [one, ...rest] = await upkeep()
    expect(rest).toEqual([])
    expect(one).toMatchObject({ title: 'project.yaml of delta does not parse', repo: path })
    expect(one?.source_key).toBe(`manifest:delta:${broken.manifestError?.sha}`)
    expect(broken.manifestError?.issue).toBe(one?.id ?? -1)

    await runSync()
    await runSync()
    expect(await upkeep()).toHaveLength(1)

    fixture.commit(path, { 'project.yaml': 'apiVersion: factory/v2\nname: delta\nleads: [' })
    await runSync()
    const issues = await upkeep()
    expect(issues).toHaveLength(2)
    expect(new Set(issues.map((i) => i.source_key)).size).toBe(2)
    expect((await getProject('delta')).manifest).toEqual(valid.manifest)

    // Fixed: the error goes, and the Issues stay what they are.
    fixture.commit(path, { 'project.yaml': MANIFEST.replace('alpha', 'delta').replace('leads: 2', 'leads: 4') })
    await runSync()
    expect(await getProject('delta')).toMatchObject({ manifestError: null, manifest: { leads: 4 } })
    expect(await upkeep()).toHaveLength(2)
  })

  test('an empty project.yaml is a broken manifest like any other', async () => {
    fixture.repo('blank', { 'project.yaml': '' })
    await runSync()
    expect(await getProject('blank')).toMatchObject({
      source: 'defaults',
      manifestError: { issue: expect.any(Number) },
    })
  })

  test('a manifest that was never valid leaves the defaults and still opens its Issue', async () => {
    fixture.repo('never', { 'project.yaml': 'apiVersion: factory/v1\nname: never\n' })
    await runSync()
    expect(await getProject('never')).toMatchObject({
      source: 'defaults',
      manifestError: { issue: expect.any(Number) },
    })
    expect(await upkeep()).toHaveLength(1)
  })

  test('a name that is not the directory is a broken manifest', async () => {
    fixture.repo('right', { 'project.yaml': MANIFEST.replace('alpha', 'wrong') })
    await runSync()
    expect((await getProject('right')).manifestError?.message).toContain("not the directory's name")
  })

  test('what the schema and the parser refuse', () => {
    const refused = (text: string) => {
      const parsed = parseManifest(text)
      return parsed.ok ? undefined : parsed.message
    }
    const base = 'apiVersion: factory/v2\nname: x\n'
    expect(parseManifest(base)).toMatchObject({ ok: true })
    expect(refused('')).toBeDefined()
    expect(refused(`${base}leads: 1\nleads: 2\n`)).toContain('DUPLICATE_KEY')
    expect(refused(`${base}typo: 1\n`)).toContain('typo')
    expect(refused(`${base}deploy: { mode: sometimes }\n`)).toContain('mode')
    expect(refused(`${base}deploy: { hold: forever }\n`)).toContain('duration')
    expect(refused(`${base}deploy: { hold: 8d }\n`)).toContain('7d')
    expect(refused(`${base}deploy: { targets: [{ name: p, host: h, verify: "rm -rf /" }] }\n`)).toContain('verify')
    expect(refused(`${base}ship: []\n`)).toBeDefined()
    expect(refused(`${base}---\n${base}`)).toContain('MULTIPLE_DOCS')
    expect(refused(`${base}a: &a [1]\nb: *a\n`)).toBeDefined()
    expect(refused(`${base}x: ${'y'.repeat(70_000)}\n`)).toContain('larger')
    // YAML 1.2: `yes` is a string, and a merge key is a key like any other.
    expect(refused(`${base}leads: yes\n`)).toContain('leads')
    expect(refused('a: &x {b: 1}\nc:\n  <<: *x\n')).toBeDefined()
  })
})

describe('the manifests that are committed', () => {
  test('this repo’s own project.yaml is valid and names this directory', async () => {
    const text = await Bun.file(join(import.meta.dir, '..', '..', '..', 'project.yaml')).text()
    const parsed = parseManifest(text)
    expect(parsed).toMatchObject({
      ok: true,
      manifest: { name: 'software-factory', deploy: { mode: 'make' }, leads: 1 },
    })
    expect(text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/)
  })
})

describe('keys', () => {
  test('a second directory of a name is told apart by its path, and the first keeps the name', async () => {
    const other = repoRoot('factory-projects-b-')
    try {
      const both = new ProjectSync({ sql: db.sql, roots: [fixture.root, other.root], now: () => clock.now() })
      const first = fixture.repo('twin', { 'project.yaml': MANIFEST.replace('alpha', 'twin') })
      const second = other.repo('twin', {
        'project.yaml': MANIFEST.replace('alpha', 'twin').replace('leads: 2', 'leads: 3'),
      })
      await both.syncNow()
      const rows = (await db.sql`SELECT name, repo FROM factory.projects ORDER BY created_at, name`) as {
        name: string
        repo: string
      }[]
      expect(rows).toHaveLength(2)
      expect(rows.find((r) => r.repo === first)?.name).toBe('twin')
      expect(rows.find((r) => r.repo === second)?.name).toMatch(/^twin~[0-9a-f]{8}$/)
      // Syncing again moves nothing, whichever is read first.
      await new ProjectSync({ sql: db.sql, roots: [other.root, fixture.root], now: () => clock.now() }).syncNow()
      const again = (await db.sql`SELECT name, repo FROM factory.projects`) as { name: string; repo: string }[]
      expect(new Set(again.map((r) => `${r.name}@${r.repo}`))).toEqual(new Set(rows.map((r) => `${r.name}@${r.repo}`)))
    } finally {
      other.cleanup()
    }
  })

  test('a second directory of a name with no manifest still shows, on the defaults of its directory', async () => {
    const other = repoRoot('factory-projects-b-')
    try {
      const first = fixture.repo('twin', { 'project.yaml': MANIFEST.replace('alpha', 'twin') })
      const second = other.repo('twin', {})
      const both = new ProjectSync({ sql: db.sql, roots: [fixture.root, other.root], now: () => clock.now() })
      await createIssue(
        db.sql,
        { source: 'request', sourceKey: 'twin', repo: second, title: 't', facts: {} },
        { repoRoots: [fixture.root, other.root], now: clock.now() },
      )
      await both.syncNow()
      const names =
        ((await db.sql`SELECT name FROM factory.projects WHERE repo = ${second}`) as { name: string }[])[0]?.name ?? ''
      expect(names).toMatch(/^twin~/)
      const list = ProjectList.parse(await (await app.get('/projects')).json())
      expect(list.projects.find((p) => p.name === names)?.manifest.name).toBe('twin')
      expect(first).toBeTruthy()
    } finally {
      other.cleanup()
    }
  })
})

describe('when it syncs', () => {
  test('a full pass every ten minutes, and between them only a repo that is named and has no row', async () => {
    let gits = 0
    const counting = new ProjectSync({
      sql: db.sql,
      roots: [fixture.root],
      now: () => clock.now(),
      run: (cmd, timeout, env, input) => {
        gits++
        return runProcess(cmd, timeout, env, input)
      },
    })
    fixture.repo('cadence', { 'project.yaml': MANIFEST.replace('alpha', 'cadence') })
    await counting.syncIfDue()
    expect((await getProject('cadence')).source).toBe('manifest')
    const afterFirst = gits
    expect(afterFirst).toBeGreaterThan(0)

    await counting.syncIfDue()
    expect(gits).toBe(afterFirst)

    const late = fixture.repo('latecomer', {})
    await fileIssue(late, 'late')
    await counting.syncIfDue()
    expect(gits).toBeGreaterThan(afterFirst)
    expect((await getProject('latecomer')).source).toBe('defaults')

    const before = gits
    clock.advance(11 * 60_000)
    await counting.syncIfDue()
    expect(gits).toBeGreaterThan(before + 1)
  })

  test('a git that does not answer leaves the row as it was', async () => {
    const path = fixture.repo('hung', { 'project.yaml': MANIFEST.replace('alpha', 'hung') })
    await runSync()
    const hung = new ProjectSync({
      sql: db.sql,
      roots: [fixture.root],
      now: () => clock.now(),
      run: async () => ({ exitCode: -1, stdout: '' }),
    })
    const result = await hung.syncNow()
    expect(result.errors.join()).toContain('git did not answer')
    expect((await getProject('hung')).source).toBe('manifest')
    expect(path).toBeTruthy()
  })
})

describe('the make contract', () => {
  test('a rule is a target; an assignment, a recipe and a pattern are not', () => {
    const { targets, includes } = readMakefile(MAKEFILE)
    expect([...targets].sort()).toEqual(['check', 'deploy', 'help', 'test', 'verify'].sort())
    expect(includes).toEqual(['make/*.mk'])
  })

  test('is read from a Makefile and what it includes, and stored on the project', async () => {
    const path = fixture.repo('maked', {
      'project.yaml': MANIFEST.replace('alpha', 'maked'),
      Makefile: MAKEFILE,
      'make/more.mk': 'restart logs:\n\t@true\n',
      'make/ignored.txt': 'quality:\n\t@true\n',
    })
    expect(await makeTargetsOf(path)).toEqual({
      makefile: true,
      check: true,
      test: true,
      deploy: true,
      verify: true,
      version: false,
      restart: true,
      quality: false,
      logs: true,
      status: false,
    })
    await runSync()
    expect((await getProject('maked')).makeTargets).toMatchObject({
      makefile: true,
      check: true,
      quality: false,
      restart: true,
    })
  })

  test('a repo with no Makefile has none of the targets; an include cannot leave the repo', async () => {
    const bare = fixture.repo('bare', {})
    expect(await makeTargetsOf(bare)).toMatchObject({ makefile: false, check: false, verify: false })
    const sly = fixture.repo('sly', { Makefile: 'include ../bare/Makefile\ninclude /etc/hosts\ncheck:\n\t@true\n' })
    await Bun.write(join(bare, 'Makefile'), 'deploy:\n\t@true\n')
    expect(await makeTargetsOf(sly)).toMatchObject({ makefile: true, check: true, deploy: false })
  })
})

describe('the make contract and links', () => {
  test('a named pipe called Makefile is not waited for', async () => {
    const path = fixture.repo('piped', {})
    expect(Bun.spawnSync(['mkfifo', join(path, 'Makefile')]).exitCode).toBe(0)
    expect(await makeTargetsOf(path)).toMatchObject({ makefile: true, check: false })
  })

  test('a Makefile or an include that is a link out of the repo is not read', async () => {
    const outside = fixture.repo('outside', { 'secret.mk': 'deploy:\n\t@true\n', Makefile: 'logs:\n\t@true\n' })
    const path = fixture.repo('linked', { 'inc.txt': 'x' })
    await Bun.write(join(path, 'Makefile'), 'check:\n\t@true\ninclude linked.mk\n')
    symlinkSync(join(outside, 'secret.mk'), join(path, 'linked.mk'))
    expect(await makeTargetsOf(path)).toMatchObject({ makefile: true, check: true, deploy: false })
    const bare = fixture.repo('bare2', {})
    symlinkSync(join(outside, 'Makefile'), join(bare, 'Makefile'))
    expect(await makeTargetsOf(bare)).toMatchObject({ makefile: true, logs: false })
  })
})

describe('claims', () => {
  const account = (name: string) =>
    app.send('PUT', `/quota/accounts/${name}`, {
      weeklyUsed: 10,
      fiveHourUsed: 10,
      fiveHourResetsAt: new Date(clock.now().getTime() + 2 * 3_600_000).toISOString(),
      weeklyResetsAt: new Date(clock.now().getTime() + 2 * 3_600_000).toISOString(),
    })
  const lead = (key: string, repo: string, issueId?: number) =>
    createSpawn(
      db.sql,
      { key, repo, prompt: 'work', role: 'lead', tier: 'sonnet', effort: 'high', issueId },
      clock.now(),
    ).then((r) => r.spawn)
  const holdersOf = async (name: string) => (await getProject(name)).claim

  beforeEach(async () => {
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) await account(name)
  })

  test('hold a second lead and admit the urgent one', async () => {
    const solo = fixture.repo('solo', {})
    await runSync().catch(() => undefined)
    const [i1, i2, i3, i4] = [
      await fileIssue(solo, 'one'),
      await fileIssue(solo, 'two'),
      await fileIssue(solo, 'three', true),
      await fileIssue(solo, 'four', true),
    ] as [number, number, number, number]
    await runSync()

    expect(await lead('s1', solo, i1)).toMatchObject({ status: 'queued', hold: null, account: expect.any(String) })
    expect(await lead('s2', solo, i2)).toMatchObject({ status: 'queued', hold: 'claim', account: null })
    // The urgent Issue takes the place beyond the leads; a second urgent one waits like anyone.
    expect(await lead('s3', solo, i3)).toMatchObject({ hold: null, account: expect.any(String) })
    expect(await lead('s4', solo, i4)).toMatchObject({ hold: 'claim', account: null })
    expect(await holdersOf('solo')).toEqual({ leads: 1, holders: [i1, i3], queued: [i4, i2] })
  })

  test('a project of two leads admits two, and a manifest raises the number for the next', async () => {
    const duo = fixture.repo('duo', { 'project.yaml': MANIFEST.replace('alpha', 'duo') })
    const ids = [await fileIssue(duo, 'd1'), await fileIssue(duo, 'd2'), await fileIssue(duo, 'd3')] as [
      number,
      number,
      number,
    ]
    await runSync()
    expect((await lead('d1', duo, ids[0])).hold).toBeNull()
    expect((await lead('d2', duo, ids[1])).hold).toBeNull()
    expect((await lead('d3', duo, ids[2])).hold).toBe('claim')
    expect((await holdersOf('duo')).holders).toEqual([ids[0], ids[1]])
  })

  test('a fleet spawn takes no claim and is not held by one', async () => {
    const solo = fixture.repo('solo', {})
    const i1 = await fileIssue(solo, 'one')
    await runSync()
    await lead('s1', solo, i1)
    const fleet = await app.send('POST', '/spawns', { key: 'wave-1', repo: solo, prompt: 'go' })
    expect(await fleet.json()).toMatchObject({ status: 'queued', hold: null, account: expect.any(String) })
    const fan = await lead('fan-1', solo)
    expect(fan.hold).toBeNull()
    expect(await db.sql`SELECT 1 FROM factory.claims`).toHaveLength(1)
  })

  test('the oldest queued Issue goes first when the claim is given back', async () => {
    const solo = fixture.repo('solo', {})
    const i1 = await fileIssue(solo, 'one')
    const i2 = await fileIssue(solo, 'two')
    const i3 = await fileIssue(solo, 'three')
    await runSync()
    await lead('s1', solo, i1)
    await lead('s2', solo, i2)
    await lead('s3', solo, i3)
    expect((await holdersOf('solo')).queued).toEqual([i2, i3])

    const close = async (id: number) => {
      await closeIssue(id)
      await releaseClaim(db.sql, id)
    }
    const pass = async () => {
      clock.advance(31_000)
      await projectPass(db.sql, sync)
      return (await claimDue({ sql: db.sql, clock, runner: new FakeRunner() })).claims.map((c) => c.key)
    }

    // Held spawns look again after the recheck; nothing changed, so nothing moves.
    await db.sql`UPDATE factory.spawns SET status = 'started' WHERE key = 's1'`
    expect(await pass()).toEqual([])
    await close(i1)
    expect(await pass()).toEqual(['s2'])
    expect(await holdersOf('solo')).toEqual({ leads: 1, holders: [i2], queued: [i3] })
    await close(i2)
    expect(await pass()).toEqual(['s3'])
    await close(i3)
    await projectPass(db.sql, sync)
    expect(await holdersOf('solo')).toEqual({ leads: 1, holders: [], queued: [] })
  })

  test('an Issue with a failed spawn does not hold up the ones behind it', async () => {
    const solo = fixture.repo('solo', {})
    const [i1, i2, i3] = [
      await fileIssue(solo, 'one'),
      await fileIssue(solo, 'two'),
      await fileIssue(solo, 'three'),
    ] as [number, number, number]
    await runSync()
    await lead('s1', solo, i1)
    await lead('s2', solo, i2)
    await lead('s3', solo, i3)
    await db.sql`UPDATE factory.spawns SET status = 'failed' WHERE key = 's2'`
    await db.sql`UPDATE factory.spawns SET status = 'started' WHERE key = 's1'`
    await closeIssue(i1)
    await releaseClaim(db.sql, i1)
    clock.advance(31_000)
    await projectPass(db.sql, sync)
    const { claims } = await claimDue({ sql: db.sql, clock, runner: new FakeRunner() })
    expect(claims.map((c) => c.key)).toEqual(['s3'])
  })

  test('a worktree’s Issue claims its repo’s project', async () => {
    const repo = fixture.repo('trunk', {})
    const worktree = join(repo, '.claude', 'worktrees', 'w1')
    mkdirSync(worktree, { recursive: true })
    const i1 = await fileIssue(repo, 'main')
    const i2 = await fileIssue(worktree, 'tree')
    await runSync()
    await lead('t1', repo, i1)
    expect((await lead('t2', worktree, i2)).hold).toBe('claim')
  })

  test('an Issue whose repo has no project row yet waits for it, and takes its claim once the tick has synced', async () => {
    const early = fixture.repo('early', {})
    const i1 = await fileIssue(early, 'one')
    expect((await lead('e1', early, i1)).hold).toBe('claim')
    expect(await db.sql`SELECT 1 FROM factory.claims`).toHaveLength(0)
    clock.advance(31_000)
    await projectPass(db.sql, sync)
    expect((await getProject('early')).source).toBe('defaults')
    const { claims } = await claimDue({ sql: db.sql, clock, runner: new FakeRunner() })
    expect(claims.map((c) => c.key)).toEqual(['e1'])
    expect((await holdersOf('early')).holders).toEqual([i1])
  })

  test('an urgent holder does not use up an ordinary place', async () => {
    const solo = fixture.repo('solo', {})
    const i1 = await fileIssue(solo, 'one')
    const i2 = await fileIssue(solo, 'two', true)
    const i3 = await fileIssue(solo, 'three')
    await runSync()
    await lead('s1', solo, i1)
    await lead('s2', solo, i2)
    expect((await lead('s3', solo, i3)).hold).toBe('claim')
    await db.sql`UPDATE factory.spawns SET status = 'started' WHERE key IN ('s1', 's2')`
    await closeIssue(i1)
    await releaseClaim(db.sql, i1)
    clock.advance(31_000)
    await projectPass(db.sql, sync)
    const { claims } = await claimDue({ sql: db.sql, clock, runner: new FakeRunner() })
    expect(claims.map((c) => c.key)).toEqual(['s3'])
    expect((await holdersOf('solo')).holders).toEqual([i2, i3])
  })

  test('a spawn of a closed Issue is refused, and one that waits when its Issue closes fails', async () => {
    const solo = fixture.repo('solo', {})
    const [i1, i2, i3] = [
      await fileIssue(solo, 'one'),
      await fileIssue(solo, 'two'),
      await fileIssue(solo, 'three'),
    ] as [number, number, number]
    await runSync()
    await lead('s1', solo, i1)
    await lead('s2', solo, i2)
    await db.sql`UPDATE factory.issues SET state = 'closed', outcome = 'dropped', closed_at = ${clock.now()} WHERE id IN (${i2}, ${i3})`
    expect(await lead('s3', solo, i3).catch((error: unknown) => error)).toBeInstanceOf(IssueClosed)
    expect(await db.sql`SELECT 1 FROM factory.spawns WHERE key = 's3'`).toHaveLength(0)

    // A waiting spawn with no time to look again is found by the sweep, not by the claim.
    await db.sql`UPDATE factory.spawns SET status = 'waiting', resume_at = NULL WHERE key = 's2'`
    clock.advance(31_000)
    expect((await projectPass(db.sql, sync)).failed).toEqual(['s2'])
    const { claims, failed } = await claimDue({ sql: db.sql, clock, runner: new FakeRunner() })
    expect(failed).toEqual([])
    expect(claims.map((c) => c.key)).toEqual(['s1'])
    const [row] = await db.sql`SELECT status, error FROM factory.spawns WHERE key = 's2'`
    expect(row).toMatchObject({ status: 'failed', error: expect.stringContaining('closed') })
  })

  test('the claim of an Issue whose every spawn failed is given back, and asked for again on a requeue', async () => {
    const solo = fixture.repo('solo', {})
    const [i1, i2] = [await fileIssue(solo, 'one'), await fileIssue(solo, 'two')] as [number, number]
    await runSync()
    await lead('s1', solo, i1)
    await lead('s2', solo, i2)
    await db.sql`UPDATE factory.spawns SET status = 'failed', error = 'gave up' WHERE key = 's1'`
    clock.advance(31_000)
    await projectPass(db.sql, sync)
    expect((await holdersOf('solo')).holders).toEqual([])
    const { claims } = await claimDue({ sql: db.sql, clock, runner: new FakeRunner() })
    expect(claims.map((c) => c.key)).toEqual(['s2'])

    // The failed one starts over behind it.
    const requeued = await app.send('POST', '/spawns/s1/requeue', {})
    expect(requeued.status).toBe(200)
    clock.advance(31_000)
    expect((await claimDue({ sql: db.sql, clock, runner: new FakeRunner() })).claims).toEqual([])
    expect((await holdersOf('solo')).queued).toEqual([i1])
  })

  test('factory status shows why a spawn is held', async () => {
    const solo = fixture.repo('solo', {})
    const [i1, i2] = [await fileIssue(solo, 'one'), await fileIssue(solo, 'two')] as [number, number]
    await runSync()
    await lead('s1', solo, i1)
    await lead('s2', solo, i2)
    const status = (await (await app.get('/status')).json()) as {
      queue: { spawns: { key: string; hold: string | null }[] }
    }
    expect(status.queue.spawns.find((s) => s.key === 's2')?.hold).toBe('claim')
  })
})

describe('factory project', () => {
  async function factory(...args: string[]) {
    const proc = Bun.spawn(['bun', CLI, ...args], {
      env: { ...process.env, FACTORY_URL: app.url.href, FACTORY_TOKEN: TEST_TOKEN, FACTORY_SOCKET: '/nonexistent' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
    return { stdout, stderr, code }
  }

  test('sync, list and show', async () => {
    fixture.repo('clip', {
      'project.yaml': MANIFEST.replace('alpha', 'clip'),
      Makefile: 'check:\n\t@true\nverify:\n\t@true\n',
    })
    fixture.repo('clop', { 'project.yaml': 'not: [valid' })

    const synced = await factory('project', 'sync', '--format', 'plain')
    expect(synced.code).toBe(0)
    expect(synced.stdout).toMatch(/^synced 2\nbroken clop #\d+\n$/)

    const list = await factory('project', 'list', '--format', 'plain')
    expect(list.stdout.split('\n').filter(Boolean)).toEqual([
      expect.stringMatching(/^clip\tmanifest\tmake\tleads 2\theld -\tqueued -$/),
      expect.stringMatching(/^clop\tdefaults\tnone\tleads 1\theld -\tqueued -\tbroken #\d+$/),
    ])

    const show = await factory('project', 'show', 'clip', '--format', 'plain')
    expect(show.code).toBe(0)
    expect(show.stdout).toContain('hold\t45m')
    expect(show.stdout).toContain('ship\tdocs/** via push; ** via pr')
    expect(show.stdout).toContain(
      'make\tcheck yes, test no, deploy no, verify yes, version no, restart no, quality no, logs no, status no',
    )

    const json = JSON.parse((await factory('project', 'show', 'clop')).stdout)
    expect(Project.parse(json).manifestError?.message).toContain('BAD_INDENT')

    expect((await factory('project', 'show', 'nope')).code).toBe(4)
    expect((await factory('project', 'show')).code).toBe(2)
  })
})
