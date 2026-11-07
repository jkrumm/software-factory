import { afterAll, beforeAll, expect, test } from 'bun:test'
import { AdmitAnswer, PlanningPassAnswer, ProjectList, ProjectView, QueueOrder } from '@software-factory/contract'
import { must, tick } from '../flow.ts'
import { type Lab, startLab } from './lab.ts'

let lab: Lab

const PLAN = `version: 1
rows:
  - key: first
    title: The first step
    facts: { why: it unblocks the rest, acceptance: it works }
  - key: second
    title: The second step
    facts: { why: it needs the first }
    after: [first]
  - key: elsewhere
    title: A step in another repo
    facts: { why: another repo }
    repo: lib
`

beforeAll(async () => {
  lab = await startLab({
    leads: true,
    env: { FACTORY_LEADS_PER_ACCOUNT: '16' },
    repos: {
      app: { project: 'apiVersion: factory/v2\nname: app\n', plan: PLAN },
      lib: { project: 'apiVersion: factory/v2\nname: lib\nleads: 3\nslots: { run: 45m }\n' },
    },
  })
})

afterAll(async () => {
  await lab.stop()
})

const pass = async () => {
  const result = await lab.cli(['planning', 'pass'])
  expect(result.code).toBe(0)
  return PlanningPassAnswer.parse(result.json)
}
const show = async (name: string) => {
  const result = await lab.cli(['project', 'show', name])
  expect(result.code).toBe(0)
  return ProjectView.parse(result.json)
}
const issueCount = async () => {
  const [row] = await lab.world.db.sql`SELECT count(*)::int AS n FROM factory.issues`
  return row?.n as number
}
const rowStates = (view: ProjectView) => view.plan?.rows.map((r) => [r.key, r.state, r.issue]) ?? []

test('projects are read from the default branch: leads, the slot limit and the signals', async () => {
  const synced = await lab.cli(['project', 'sync'])
  expect(synced.json).toMatchObject({ synced: 2, broken: [], errors: [] })
  const list = ProjectList.parse((await lab.cli(['project', 'list'])).json)
  expect(list.projects.map((p) => [p.name, p.source, p.leads, p.slotRun, p.branch])).toEqual([
    ['app', 'file', 1, null, 'origin/main'],
    ['lib', 'file', 3, '45m', 'origin/main'],
  ])
  expect((await lab.cli(['project', 'show', 'nothing'])).code).toBe(4)
})

test('a row is filed once when its after row closes: replayed passes file nothing twice', async () => {
  const first = await pass()
  expect(first.filed.map((f) => [f.project, f.row])).toEqual([
    ['app', 'first'],
    ['app', 'elsewhere'],
  ])
  const issues = await lab.world.db.sql`SELECT id, repo, state FROM factory.issues ORDER BY id`
  expect(
    issues.map((i: { id: string; repo: string; state: string }) => [i.id, i.repo.split('/').pop(), i.state]),
  ).toEqual([
    ['issue_1', 'app', 'queued'],
    ['issue_2', 'lib', 'queued'],
  ])
  const [facts] = await lab.world.db.sql`
    SELECT payload->>'text' AS text FROM factory.issue_events WHERE issue_id = 'issue_1' AND kind = 'noted'`
  expect(facts?.text).toBe('Plan row first.\nwhy: it unblocks the rest\nacceptance: it works')

  // a replayed pass does nothing
  expect((await pass()).filed).toEqual([])
  expect(await issueCount()).toBe(2)
  expect(rowStates(await show('app'))).toEqual([
    ['first', 'open', 'issue_1'],
    ['second', 'waiting', null],
    ['elsewhere', 'open', 'issue_2'],
  ])
  expect((await show('app')).plan?.rows.find((r) => r.key === 'second')?.reason).toBe('after app:first')

  // the first row's Issue closes (in any outcome): the second row is filed, once
  await must(lab, ['issue', 'cancel', 'issue_1', '--reason', 'not needed'])
  const second = await pass()
  expect(second.filed).toEqual([{ project: 'app', row: 'second', issue: 'issue_3' }])
  expect((await pass()).filed).toEqual([])
  expect(await issueCount()).toBe(3)
  expect(rowStates(await show('app'))).toEqual([
    ['first', 'done', 'issue_1'],
    ['second', 'open', 'issue_3'],
    ['elsewhere', 'open', 'issue_2'],
  ])
  const filedEvents = await lab.world.db.sql`SELECT key FROM factory.issue_events WHERE kind = 'filed' ORDER BY key`
  expect(filedEvents.map((e: { key: string }) => e.key)).toEqual([
    'plan:app:elsewhere',
    'plan:app:first',
    'plan:app:second',
  ])
})

test('a plan that closes a cycle is refused: the last valid plan stays and the error is shown', async () => {
  await lab.commit('app', {
    'docs/plan.yaml': `version: 1\nrows:\n  - { key: a, title: A, facts: {}, after: [b] }\n  - { key: b, title: B, facts: {}, after: [a] }\n`,
  })
  const pass1 = await pass()
  expect(pass1.sync?.broken).toMatchObject([
    { project: 'app', file: 'docs/plan.yaml', message: expect.stringContaining('cycle: a -> b -> a') },
  ])
  const view = await show('app')
  expect(view.planError).toContain('cycle')
  expect(view.plan?.rows.map((r) => r.key)).toEqual(['first', 'second', 'elsewhere'])
  expect(await issueCount()).toBe(3)
})

test('an edge that closes a cycle is refused (409, nothing stored); a closed blocker and an unknown Issue too', async () => {
  const a = await lab.file('lib', 'a')
  const b = await lab.file('lib', 'b')
  const c = await lab.file('lib', 'c')
  const settled = await lab.cli(['planning', 'settle', '--body', JSON.stringify({ issue: b, after: [a] })])
  expect(settled).toMatchObject({ code: 0, json: { result: 'settled', edges: 1, state: 'queued' } })

  const cycle = await lab.cli(['planning', 'after', '--body', JSON.stringify({ issue: a, after: [b] })])
  expect(cycle.code).toBe(5)
  // a failure is one JSON line on stderr, stdout stays empty, and the cycle's Issues are in details.path
  expect(cycle.out).toBe('')
  expect(cycle.failure).toMatchObject({
    kind: 'conflict',
    message: `that closes a cycle: Issue ${a.slice(6)} waits for Issue ${b.slice(6)} waits for Issue ${a.slice(6)}`,
    code: 'cycle',
    details: { status: 409, path: [a, b, a] },
  })

  const unknown = await lab.cli(['planning', 'after', '--body', JSON.stringify({ issue: a, after: ['issue_999'] })])
  expect(unknown.code).toBe(4)
  await must(lab, ['issue', 'cancel', c, '--reason', 'x'])
  const closed = await lab.cli(['planning', 'settle', '--body', JSON.stringify({ issue: a, after: [c] })])
  expect(closed.code).toBe(5)
  expect(closed.failure).toMatchObject({ code: 'issue_closed' })
  const edges = await lab.world.db.sql`SELECT issue_id, after_issue FROM factory.planning_edges`
  expect(edges.map((e: { issue_id: string; after_issue: string }) => [e.issue_id, e.after_issue])).toEqual([[b, a]])
})

test('an Issue behind a blocker stays queued, naming it, until the blocker closes', async () => {
  const [{ issue_id: dependent, after_issue: blocker }] = await lab.world.db
    .sql`SELECT issue_id, after_issue FROM factory.planning_edges`
  const waiting = QueueOrder.parse((await lab.cli(['queue', 'order'])).json).queue.find((e) => e.issue === dependent)
  expect(waiting?.reason).toMatchObject({ kind: 'chain', message: `waits for Issue ${blocker.slice(6)} to close` })

  expect((await lab.cli(['planning', 'settle', '--body', JSON.stringify({ issue: blocker, after: [] })])).code).toBe(0)
  await lab.accounts([{ id: 'me' }, { id: 'b' }, { id: 'c' }])
  await lab.cli(['capacity', 'refresh'])
  const first = AdmitAnswer.parse((await lab.cli(['capacity', 'admit'])).json)
  expect(first.admitted.map((a) => a.issue)).toContain(blocker)
  expect(first.admitted.map((a) => a.issue)).not.toContain(dependent)

  // Nothing above called hc or agw; now the blocker's lead starts and ends it as the agent.
  expect(await lab.world.calls()).toEqual([])
  await tick(lab)
  await must(
    lab,
    ['issue', 'close', blocker, '--attempt', '1', '--outcome', 'dropped', '--reason', 'not needed'],
    'agent',
  )
  await lab.cli(['capacity', 'refresh'])
  const second = AdmitAnswer.parse((await lab.cli(['capacity', 'admit'])).json)
  expect(second.admitted.map((a) => a.issue)).toContain(dependent)
})

test('a broken project.yaml keeps the last valid one and files one Issue for that content', async () => {
  await lab.commit('lib', { 'project.yaml': 'apiVersion: factory/v2\nname: lib\nleads: 99\n' })
  const before = await issueCount()
  const synced = await lab.cli(['project', 'sync'])
  expect(synced.json).toMatchObject({
    broken: [{ project: 'lib', file: 'project.yaml', issue: `issue_${before + 1}` }],
  })
  await lab.cli(['project', 'sync'])
  expect(await issueCount()).toBe(before + 1)
  const lib = await show('lib')
  expect(lib.leads).toBe(3)
  expect(lib.projectError?.message).toContain('leads')
})

test('planning never asked agw', async () => {
  expect((await lab.world.calls()).filter((call) => call.tool === 'agw')).toEqual([])
})
