import { afterAll, beforeAll, expect, test } from 'bun:test'
import { ProjectDigestsModel } from '@software-factory/contract'
import { fileIssue, must, settle } from '../flow.ts'
import { factory } from '../harness.ts'
import { type Lab, startLab } from '../planning/lab.ts'
import { runLoop, working } from './support.ts'

/**
 * The digest loop against the real server and Postgres: a digest is built in code (no agw call) for each project with a
 * `project.yaml` that has Issues open or closed in the last 7 days and whose digest changed since its newest one.
 * Every pass is driven through `factory loop run digest` (the interval is off).
 */
let lab: Lab

const projectFile = (name: string, work = false) =>
  `apiVersion: factory/v2\nname: ${name}\nleads: 8\n${work ? 'work: true\n' : ''}`

beforeAll(async () => {
  lab = await startLab({
    leads: true,
    repos: {
      app: { project: projectFile('app') },
      shop: { project: projectFile('shop') },
      quiet: { project: projectFile('quiet') },
      bank: { project: projectFile('bank', true) },
      loose: {},
    },
    env: { FACTORY_LEADS_PER_ACCOUNT: '16' },
  })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
})

const digests = async (as: 'owner' | 'read' = 'owner') => {
  const out = await factory(lab.world, ['read', 'project-digests'], { FACTORY_URL: lab.server.url }, { as })
  expect(out.code).toBe(0)
  return ProjectDigestsModel.parse(JSON.parse(out.out)).projects
}

let shipped = ''
let appQueued = ''
let shopQueued = ''
let bankQueued = ''

test('a pass stores a digest for each project with work, and for none without', async () => {
  shipped = await working(lab, 'app', 'Ship the checkout page')
  await must(lab, ['issue', 'close', shipped, '--attempt', '1', '--outcome', 'done', '--reason', 'shipped'], 'agent')
  appQueued = await fileIssue(lab, { repo: 'app', title: 'Add a wishlist' })
  await settle(lab, appQueued)
  shopQueued = await fileIssue(lab, { repo: 'shop', title: 'Fix the cart total' })
  await settle(lab, shopQueued)
  bankQueued = await fileIssue(lab, { repo: 'bank', title: 'Migrate the ledger export' })
  await settle(lab, bankQueued)
  await fileIssue(lab, { repo: 'loose', title: 'A repo with no project.yaml' })

  const ran = await runLoop(lab, 'digest')
  expect(ran.error).toBeNull()
  expect(ran.summary).toContain('3 digest(s) stored; 0 unchanged, 1 idle')
  const [stored] = await lab.world.db
    .sql`SELECT count(*)::int AS n, count(DISTINCT project)::int AS projects, min(route) AS route FROM factory.project_digests`
  expect(stored).toEqual({ n: 3, projects: 3, route: 'code' })

  const app = (await digests()).find((p) => p.project === 'app')
  expect(app).toMatchObject({
    headline: '1 shipped, the newest: Ship the checkout page; 1 open',
    shipped: [{ text: 'Ship the checkout page', ids: [shipped] }],
    next: [{ text: 'Add a wishlist', ids: [appQueued] }],
    risks: [],
    counts: { done7d: 1, work: expect.objectContaining({ running: 0, ready: 1, paused: 0 }) },
  })
  expect((await digests()).map((p) => p.project)).toEqual(['app', 'bank', 'shop'])
})

test('a pass with nothing changed stores nothing', async () => {
  const ran = await runLoop(lab, 'digest')
  expect(ran.summary).toContain('0 digest(s) stored; 3 unchanged')
})

test('a changed project gets a new digest, the others do not', async () => {
  const more = await fileIssue(lab, { repo: 'app', title: 'Add gift cards' })
  await settle(lab, more)
  const ran = await runLoop(lab, 'digest')
  expect(ran.summary).toContain('1 digest(s) stored; 2 unchanged')
  const rows = await lab.world.db
    .sql`SELECT project, count(*)::int AS n FROM factory.project_digests GROUP BY project ORDER BY project`
  expect(rows.map((r: { project: string; n: number }) => [r.project, r.n])).toEqual([
    ['app', 2],
    ['bank', 1],
    ['shop', 1],
  ])
  const app = (await digests()).find((p) => p.project === 'app')
  expect(app?.headline).toBe('1 shipped, the newest: Ship the checkout page; 2 open')
  expect(app?.next.map((b) => b.text)).toEqual(['Add a wishlist', 'Add gift cards'])
})

test('the read token gets the counts of a work project and no words, and nothing of a repo without a project.yaml', async () => {
  const owner = await digests('owner')
  expect(owner.find((p) => p.project === 'bank')?.next[0]?.text).toBe('Migrate the ledger export')

  const read = await digests('read')
  expect(read.map((p) => p.project).sort()).toEqual(['app', 'private', 'shop'])
  const hidden = read.find((p) => p.project === 'private')
  expect(hidden).toMatchObject({
    shipped: [],
    next: [],
    risks: [],
    themes: [],
    counts: { done7d: 0, work: expect.objectContaining({ running: 0, ready: 1, paused: 0 }) },
  })
  expect(JSON.stringify(hidden)).not.toContain('bank')
  expect(JSON.stringify(hidden)).not.toContain('ledger')
  expect(JSON.stringify(read.find((p) => p.project === 'app'))).toContain('Ship the checkout page')
  expect(owner.map((p) => p.project)).not.toContain('loose')
  expect(owner.map((p) => p.project)).not.toContain('quiet')
})
