import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  ArtifactReply,
  AskReply,
  DecisionReply,
  NeedsModel,
  PlanningPassAnswer,
  ReplanAnswer,
} from '@software-factory/contract'
import { admitted, fileIssue, must, settle, tick } from '../flow.ts'
import { type Lab, startLab } from './lab.ts'

let lab: Lab

const project = (name: string) => `apiVersion: factory/v2\nname: ${name}\nleads: 3\n`

beforeAll(async () => {
  lab = await startLab({
    leads: true,
    env: { FACTORY_LEADS_PER_ACCOUNT: '16' },
    repos: { app: { project: project('app') }, chain: { project: project('chain') }, bare: {} },
  })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
})

const replanIssues = async (title: string) => {
  const rows = await lab.world.db.sql`
    SELECT r.issue_id, r.trigger, r.ask, i.state FROM factory.replans r JOIN factory.issues i ON i.id = r.issue_id
    WHERE r.project = ${title} ORDER BY r.created_at, r.issue_id`
  return rows as { issue_id: string; trigger: string; ask: string | null; state: string }[]
}
const notes = async (issue: string) => {
  const rows = await lab.world.db.sql`
    SELECT payload->>'text' AS text FROM factory.issue_events WHERE issue_id = ${issue} AND kind = 'noted' ORDER BY version`
  return rows.map((r: { text: string }) => r.text)
}
const replan = async (...args: string[]) => {
  const result = await lab.cli(['planning', 'replan', ...args])
  expect(result.code).toBe(0)
  return ReplanAnswer.parse(result.json)
}

test('the owner files one Replan per project: the second call adds its ask as a note and files nothing', async () => {
  const first = await replan('app', '--ask', 'drop the export work')
  expect(first).toMatchObject({ filed: true, existing: false })
  const [issue] = await replanIssues('app')
  expect(issue).toMatchObject({ issue_id: first.issue, trigger: 'owner', ask: 'drop the export work', state: 'queued' })
  const [title] = await lab.world.db.sql`
    SELECT payload->>'title' AS title, payload->>'kind' AS kind, payload->>'origin' AS origin
    FROM factory.issue_events WHERE issue_id = ${first.issue} AND kind = 'filed'`
  expect(title).toMatchObject({ title: 'Replan: app', kind: 'chore', origin: 'you' })
  const [lead] = await notes(first.issue)
  expect(lead).toContain('ask: drop the export work')
  expect(lead).toContain('Playbook:')

  const second = await replan('app', '--ask', 'and split the importer')
  expect(second).toEqual({ issue: first.issue, filed: false, existing: true })
  expect(await replanIssues('app')).toHaveLength(1)
  expect((await notes(first.issue)).at(-1)).toBe('ask: and split the importer')

  const unknown = await lab.cli(['planning', 'replan', 'nothing'])
  expect(unknown.code).toBe(4)
  const work = await lab.cli(['planning', 'replan', 'bare'])
  expect(work.code).toBe(4)
})

test("the Replan's lead raises a Decision and submits a Spec: both reach Needs you", async () => {
  const [open] = await replanIssues('app')
  const id = open?.issue_id ?? ''
  await admitted(lab, id)
  await tick(lab)
  const asked = AskReply.parse(
    (
      await must(lab, [
        'issue',
        'ask',
        id,
        '--body',
        JSON.stringify({
          attempt: 1,
          question: 'Drop the export row or keep it?',
          recommendation: 'drop',
          checked: 'Read the plan and the open Issues.',
          options: [
            { label: 'drop', reversible: true, cost: 'the row is gone' },
            { label: 'keep', reversible: true, cost: 'it stays queued' },
          ],
          noAnswer: { consequence: 'The Spec keeps the row.' },
        }),
      ])
    ).json,
  )
  await must(lab, ['checkpoint', 'pass'])
  const needs = () => must(lab, ['read', 'needs']).then((r) => NeedsModel.parse(r.json))
  expect((await needs()).items.find((item) => item.id === asked.decision.id)).toMatchObject({ kind: 'decision' })
  DecisionReply.parse((await must(lab, ['decision', 'answer', asked.decision.id, 'drop'])).json)

  const submitted = ArtifactReply.parse(
    (
      await must(lab, [
        'artifact',
        'submit',
        id,
        '--body',
        JSON.stringify({ attempt: 1, kind: 'spec', title: 'Replan: app', content: '# Replan\n\nDrop row export.' }),
      ])
    ).json,
  )
  expect(submitted.issue).toMatchObject({ state: 'waiting', waitReason: 'review' })
  // a Spec reaches Needs you once the Spec screen passes it (the fake agw passes it)
  await must(lab, ['checkpoint', 'pass'])
  expect((await needs()).items.find((item) => item.id === submitted.artifact.id)).toMatchObject({ kind: 'review' })
})

test('a long wait with an Issue behind it files one Replan for its project; a replayed wait files no second', async () => {
  const head = await fileIssue(lab, { repo: 'chain', title: 'The head' })
  await admitted(lab, head)
  await tick(lab)
  const behind = await fileIssue(lab, { repo: 'chain', title: 'Behind it' })
  await settle(lab, behind)
  await must(lab, ['planning', 'after', '--body', JSON.stringify({ issue: behind, after: [head] })])
  await must(lab, ['issue', 'defer', head, '--attempt', '1', '--until', '2099-01-01T00:00:00Z'])

  const pass = async () => PlanningPassAnswer.parse((await must(lab, ['planning', 'pass'])).json)
  expect((await pass()).errors).toEqual([])
  const [replan] = await replanIssues('chain')
  expect(replan).toMatchObject({ trigger: 'stalled', ask: null })
  const [lead] = await notes(replan?.issue_id ?? '')
  expect(lead).toContain('trigger: stalled')
  expect(lead).toContain(`stalled head: ${head}`)
  expect(lead).toContain('waiting behind it: 1')

  // while it is open, passes file nothing
  await pass()
  expect(await replanIssues('chain')).toHaveLength(1)

  // The key is the head and the start of its wait: once that Replan closes, the same wait files no second. A new wait
  // (a new deferral) is a new key and would.
  await must(lab, ['issue', 'cancel', replan?.issue_id ?? '', '--reason', 'no change needed'])
  await pass()
  expect(await replanIssues('chain')).toHaveLength(1)
})
