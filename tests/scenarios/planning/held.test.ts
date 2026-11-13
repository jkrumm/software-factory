import { afterAll, beforeAll, expect, test } from 'bun:test'
import { PlanningPassAnswer, ProjectView } from '@software-factory/contract'
import { must } from '../flow.ts'
import { type Lab, startLab } from './lab.ts'

let lab: Lab

const PLAN = `version: 1
rows:
  - key: first
    title: The first step
    facts: { why: it ships what the second builds on }
  - key: needs-it
    title: Builds on the first
    facts: { why: it needs what the first shipped }
    after: [first]
    after_needs: shipped
  - key: any-close
    title: Runs once the first is over
    facts: { why: it only follows the first }
    after: [first]
`

beforeAll(async () => {
  lab = await startLab({
    leads: true,
    repos: { app: { project: 'apiVersion: factory/v2\nname: app\nleads: 3\n', plan: PLAN } },
  })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
})

const pass = async () => {
  const result = await lab.cli(['planning', 'pass'])
  expect(result.code).toBe(0)
  return PlanningPassAnswer.parse(result.json)
}
const rows = async () => {
  const result = await lab.cli(['project', 'show', 'app'])
  expect(result.code).toBe(0)
  return ProjectView.parse(result.json).plan?.rows ?? []
}
const replans = async () =>
  (await lab.world.db.sql`SELECT issue_id, trigger FROM factory.replans WHERE project = 'app' ORDER BY created_at`) as {
    issue_id: string
    trigger: string
  }[]

test('a dropped row holds the row that needs it shipped, releases the plain one, and files one held Replan', async () => {
  expect((await pass()).filed.map((f) => f.row)).toEqual(['first'])
  await must(lab, ['issue', 'cancel', 'issue_1', '--reason', 'not needed'])

  const held = await pass()
  expect(held.errors).toEqual([])
  expect(held.filed.map((f) => f.row)).toEqual(['any-close'])
  const byKey = new Map((await rows()).map((r) => [r.key, r]))
  expect(byKey.get('needs-it')).toMatchObject({
    state: 'waiting',
    reason: expect.stringContaining('held: app:first (issue_1 closed cancelled)'),
  })
  expect(byKey.get('any-close')?.state).toBe('open')

  const [replan] = await replans()
  expect(replan?.trigger).toBe('held')
  const [note] = await lab.world.db.sql`
    SELECT payload->>'text' AS text FROM factory.issue_events WHERE issue_id = ${replan?.issue_id} AND kind = 'noted' ORDER BY version`
  expect(note?.text).toContain(
    'held row: app:needs-it (after_needs shipped), held by app:first (issue_1 closed cancelled)',
  )

  // a replayed pass files neither a row nor a second Replan
  expect((await pass()).filed).toEqual([])
  expect(await replans()).toHaveLength(1)
})
