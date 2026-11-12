import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ProjectDigestsModel } from '@software-factory/contract'
import { fileIssue, must, settle } from '../flow.ts'
import { factory } from '../harness.ts'
import { type Lab, startLab } from '../planning/lab.ts'
import { callsOf, runLoop, script, working } from './support.ts'

/**
 * The digest loop against the real server and Postgres with the fake agw: `agw factory digest` is asked once for each project
 * with a `project.yaml` that has Issues open or closed in the last 7 days and whose Issues changed since its newest digest;
 * a failed call leaves the previous digest in place. Every pass is driven through `factory loop run digest` (the interval is off).
 */
let lab: Lab
let dir: string
let digestScript: string

const projectFile = (name: string, work = false) =>
  `apiVersion: factory/v2\nname: ${name}\nleads: 8\n${work ? 'work: true\n' : ''}`

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-digest-')
  digestScript = join(dir, 'digest.json')
  await script(digestScript, [])
  lab = await startLab({
    leads: true,
    repos: {
      app: { project: projectFile('app') },
      shop: { project: projectFile('shop') },
      quiet: { project: projectFile('quiet') },
      bank: { project: projectFile('bank', true) },
      loose: {},
    },
    env: { FACTORY_FAKE_DIGEST_SCRIPT: digestScript, FACTORY_LEADS_PER_ACCOUNT: '16' },
  })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
  await rm(dir, { recursive: true, force: true })
})

const digestCalls = async (project?: string) =>
  (await callsOf(lab, 'factory')).filter(
    (call) => call.args[1] === 'digest' && (project === undefined || call.input.project === project),
  )

const digests = async (as: 'owner' | 'read' = 'owner') => {
  const out = await factory(lab.world, ['read', 'project-digests'], { FACTORY_URL: lab.server.url }, { as })
  expect(out.code).toBe(0)
  return ProjectDigestsModel.parse(JSON.parse(out.out)).projects
}

let shipped = ''
let appQueued = ''
let shopQueued = ''
let bankQueued = ''

test('a pass asks once for each project with work, and for none without', async () => {
  shipped = await working(lab, 'app', 'Ship the checkout page')
  await must(lab, ['issue', 'close', shipped, '--attempt', '1', '--outcome', 'done', '--reason', 'shipped'], 'agent')
  appQueued = await fileIssue(lab, { repo: 'app', title: 'Add a wishlist' })
  await settle(lab, appQueued)
  shopQueued = await fileIssue(lab, { repo: 'shop', title: 'Fix the cart total' })
  await settle(lab, shopQueued)
  bankQueued = await fileIssue(lab, { repo: 'bank', title: 'Migrate the ledger export' })
  await settle(lab, bankQueued)
  await fileIssue(lab, { repo: 'loose', title: 'A repo with no project.yaml' })
  await script(digestScript, [
    {
      match: '"project":"app"',
      answer: {
        headline: 'Checkout shipped, wishlist next',
        shipped: [{ text: 'The checkout page is live', ids: [shipped] }],
        next: [{ text: 'A wishlist is queued', ids: [appQueued] }],
        risks: [],
        themes: ['checkout'],
      },
    },
  ])

  const ran = await runLoop(lab, 'digest')
  expect(ran.error).toBeNull()
  expect(ran.summary).toContain('3 digest(s) stored of 3 call(s)')
  expect((await digestCalls()).map((call) => call.input.project).sort()).toEqual(['app', 'bank', 'shop'])
  const [stored] = await lab.world.db
    .sql`SELECT count(*)::int AS n, count(DISTINCT project)::int AS projects, min(route) AS route FROM factory.project_digests`
  expect(stored).toEqual({ n: 3, projects: 3, route: 'factory.digest' })

  const app = (await digests()).find((p) => p.project === 'app')
  expect(app).toMatchObject({
    headline: 'Checkout shipped, wishlist next',
    shipped: [{ text: 'The checkout page is live', ids: [shipped] }],
    next: [{ ids: [appQueued] }],
    counts: { done7d: 1, working: 0, queued: 1, waiting: 0 },
  })
  expect((await digests()).map((p) => p.project)).toEqual(['app', 'bank', 'shop'])
})

test('a pass with nothing changed makes no call', async () => {
  const before = (await digestCalls()).length
  const ran = await runLoop(lab, 'digest')
  expect(ran.summary).toContain('no call: 3 project(s) unchanged')
  expect((await digestCalls()).length).toBe(before)
})

test('a changed project is asked again with its previous headline, the others are not', async () => {
  const before = (await digestCalls()).length
  const more = await fileIssue(lab, { repo: 'app', title: 'Add gift cards' })
  await settle(lab, more)
  await runLoop(lab, 'digest')
  const calls = await digestCalls()
  expect(calls.length).toBe(before + 1)
  const last = calls[calls.length - 1]
  expect(last?.input.project).toBe('app')
  expect(last?.input.previous).toMatchObject({ headline: 'Checkout shipped, wishlist next' })
})

test('a failed call leaves the previous digest in place and is asked again next pass', async () => {
  const [first] = await lab.world.db
    .sql`SELECT at FROM factory.project_digests WHERE project = 'shop' ORDER BY at DESC LIMIT 1`
  const more = await fileIssue(lab, { repo: 'shop', title: 'Add a returns page' })
  await settle(lab, more)
  await script(digestScript, [{ match: '"project":"shop"', answer: null, fail: true }])

  const failed = await runLoop(lab, 'digest')
  expect(failed.error).toBeNull()
  expect(failed.summary).toContain('1 failed')
  expect(failed.summary).toContain('shop')
  const [after] = await lab.world.db
    .sql`SELECT count(*)::int AS n, max(at) AS at FROM factory.project_digests WHERE project = 'shop'`
  expect(after?.n).toBe(1)
  expect(after?.at).toEqual(first?.at)
  expect((await digests()).find((p) => p.project === 'shop')?.at).toBe(new Date(first?.at as Date).toISOString())

  await script(digestScript, [])
  const retried = await runLoop(lab, 'digest')
  expect(retried.summary).toContain('1 digest(s) stored of 1 call(s)')
  const [now] = await lab.world.db.sql`SELECT count(*)::int AS n FROM factory.project_digests WHERE project = 'shop'`
  expect(now?.n).toBe(2)
})

test('the read token gets the counts of a work project and no words, and nothing of a repo without a project.yaml', async () => {
  const owner = await digests('owner')
  expect(owner.find((p) => p.project === 'bank')?.headline).toContain('bank')

  const read = await digests('read')
  expect(read.map((p) => p.project).sort()).toEqual(['app', 'private', 'shop'])
  const hidden = read.find((p) => p.project === 'private')
  expect(hidden).toMatchObject({
    shipped: [],
    next: [],
    risks: [],
    themes: [],
    counts: { done7d: 0, working: 0, queued: 1, waiting: 0 },
  })
  expect(JSON.stringify(hidden)).not.toContain('bank')
  expect(JSON.stringify(hidden)).not.toContain('ledger')
  expect(JSON.stringify(read.find((p) => p.project === 'app'))).toContain('Checkout shipped')
  expect((await digestCalls('loose')).length).toBe(0)
  expect((await digestCalls('quiet')).length).toBe(0)
})
