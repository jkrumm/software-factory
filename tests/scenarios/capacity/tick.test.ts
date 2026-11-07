import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Health } from '@software-factory/contract'
import { type Lab, startLab } from '../planning/lab.ts'

/**
 * The planning and admission passes run on the leads' tick (`FACTORY_TICK_MS`, one setting): nothing here calls
 * `planning pass` or `capacity admit`.
 */
let lab: Lab

const PLAN = `version: 1
rows:
  - key: ticked
    title: Filed by the tick
    facts: { why: nobody asked }
`

beforeAll(async () => {
  lab = await startLab({
    repos: { app: { project: 'apiVersion: factory/v2\nname: app\n', plan: PLAN } },
    env: { FACTORY_TICK_MS: '200' },
  })
})

afterAll(async () => {
  await lab.stop()
})

const until = async <T>(read: () => Promise<T | undefined>, what: string): Promise<T> => {
  for (let i = 0; i < 100; i++) {
    const value = await read()
    if (value !== undefined) return value
    await Bun.sleep(100)
  }
  throw new Error(`the tick did not ${what} within 10 s:\n${lab.server.output()}`)
}

test('the tick reads the project, files the plan row, settles it and admits it, with no verb called', async () => {
  const state = await until(async () => {
    const [row] = await lab.world.db.sql`SELECT state FROM factory.issues WHERE id = 'issue_1'`
    return row?.state === 'working' ? (row.state as string) : undefined
  }, 'file and admit the plan row')
  expect(state).toBe('working')
  const kinds = await lab.world.db
    .sql`SELECT kind FROM factory.issue_events WHERE issue_id = 'issue_1' AND result = 'applied' ORDER BY version`
  expect(kinds.map((k: { kind: string }) => k.kind)).toEqual(['filed', 'noted', 'settled', 'admitted'])
  const [assignment] = await lab.world.db
    .sql`SELECT account FROM factory.capacity_assignments WHERE issue_id = 'issue_1'`
  expect(assignment?.account).toBe('me')
})

test('/health says when the queue last moved', async () => {
  const health = Health.parse(await (await fetch(`${lab.server.url}/health`)).json())
  expect(health.heartbeat.queueMovedAt).not.toBeNull()
  expect(Date.now() - Date.parse(health.heartbeat.queueMovedAt ?? '')).toBeLessThan(60_000)
})

test("intake knows the projects from their project.yaml: an owner's signal for a project files an Issue that names it by its directory", async () => {
  const filed = await lab.cli([
    'signal',
    'file',
    '--body',
    JSON.stringify({ from: 'owner', title: 'Fix the footer', text: 'It overlaps.', repo: 'app' }),
  ])
  expect(filed).toMatchObject({ code: 0, json: { outcome: 'filed' } })
  const issue = (filed.json as { issue: string }).issue
  const [row] = await lab.world.db.sql`SELECT repo FROM factory.issues WHERE id = ${issue}`
  expect(row?.repo).toBe('app')
  // the tick settles nothing for it (intake's triage does that, package 7), but planning resolves its repo to the project
  const order = await lab.cli(['queue', 'order'])
  expect(JSON.stringify(order.json)).not.toContain('unknown_project')
})

test('a signal for a repo that is no project is dropped', async () => {
  const dropped = await lab.cli([
    'signal',
    'file',
    '--body',
    JSON.stringify({ from: 'owner', title: 'Fix a ghost', repo: 'ghost' }),
  ])
  expect(JSON.stringify(dropped.json)).toContain('dropped')
})
