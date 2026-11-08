import { afterAll, beforeAll, expect, test } from 'bun:test'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { createApp } from '../../src/api/app.ts'
import { deriveSession } from '../../src/domains/leads/session.ts'
import { fixedClock } from '../../src/kernel/clock.ts'
import { healthOf } from '../../src/read/health.ts'
import { createReader } from '../../src/read/reader.ts'
import { loadBriefs } from '../../src/read/sessions.ts'
import { isWorkRepo, loadOpenProjects } from '../../src/read/work.ts'

/**
 * "Is this a work repo" is one rule with three spellings: `isWorkRepo` in TypeScript, and the WHERE clauses of the cards
 * (`issues.ts`) and of the briefs behind sessions and asks (`sessions.ts`). They must agree on every repo, the odd ones
 * included: an underscore in a project path is a character, not a wildcard.
 */
const OWNER = 'owner-token-0123456789'
const NOW = '2026-11-07T12:00:00.000Z'

const REPOS = [
  'argo', // a project with its own project.yaml, by name
  '/src/argo', // the same, by path
  '/src/argo/packages/x', // below its path
  '/src/argo2', // beside it: not below
  '/src/my_app/sub', // below a path with an underscore
  '/src/myXapp/sub', // what an underscore wildcard would wrongly match
  '/src/100%', // a percent sign in a project path
  '/src/100x/sub', // what a percent wildcard would wrongly match
  'chat', // a project with defaults only
  '/src/unlisted', // no project at all
]

let db: TestCluster
let app: ReturnType<typeof createApp>

beforeAll(async () => {
  db = await startTestCluster()
  await migrate(db.sql, await loadMigrations())
  const { sql } = db
  for (const [name, repo, source] of [
    ['argo', '/src/argo', 'file'],
    ['my_app', '/src/my_app', 'file'],
    ['100', '/src/100%', 'file'],
    ['chat', '/src/chat', 'defaults'],
  ] as const) {
    await sql`INSERT INTO factory.planning_projects (name, repo, source, project) VALUES (${name}, ${repo}, ${source}, '{}')`
  }
  for (const [index, repo] of REPOS.entries()) {
    const n = index + 1
    await sql`INSERT INTO factory.issues (id, repo, state, version) VALUES (${`issue_${n}`}, ${repo}, 'queued', 1)`
    await sql`
      INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, to_state)
      VALUES (${`event_${n}`}, ${`issue_${n}`}, ${`k${n}`}, 'filed',
        ${{ repo, title: `title ${n}`, kind: 'bug', origin: 'you' }}, 'factory', ${NOW}, 'applied', 1, 'settling')`
  }
  app = createApp({
    tokens: { owner: OWNER },
    health: { read: async () => healthOf({ version: 't', databaseFailure: null, tickAt: null, queueMovedAt: null }) },
    read: createReader({
      sql,
      clock: fixedClock(NOW),
      deriveSession,
      doorLines: async () => [],
      loops: () => [],
      blockedStreak: 3,
      mainCheckouts: () => [],
      streamPollMs: 20,
    }),
  })
})
afterAll(() => db.stop())

test('the cards and the briefs say what isWorkRepo says, for every repo', async () => {
  const open = await loadOpenProjects(db.sql)
  const expected = new Map(REPOS.map((repo, index) => [`issue_${index + 1}`, isWorkRepo(repo, open)]))

  const briefs = await loadBriefs(db.sql, [...expected.keys()])
  expect(new Map([...briefs].map(([id, brief]) => [id, brief.visible]))).toEqual(expected)

  const response = await app.handle(
    new Request('http://localhost/v1/issues?state=open&limit=100', { headers: { authorization: `Bearer ${OWNER}` } }),
  )
  const cards = ((await response.json()) as { issues: { ref: string; visible: boolean }[] }).issues
  expect(new Map(cards.map((card) => [card.ref, card.visible]))).toEqual(expected)

  // the odd ones, spelled out so a change of the rule shows up here and not only as two equal wrong answers
  const byRepo = new Map(REPOS.map((repo, index) => [repo, expected.get(`issue_${index + 1}`)]))
  expect(byRepo.get('/src/argo/packages/x')).toBe(false)
  expect(byRepo.get('/src/my_app/sub')).toBe(false)
  expect(byRepo.get('/src/myXapp/sub')).toBe(true)
  expect(byRepo.get('/src/100x/sub')).toBe(true)
  expect(byRepo.get('/src/unlisted')).toBe(true)
  expect(byRepo.get('chat')).toBe(true)
})
