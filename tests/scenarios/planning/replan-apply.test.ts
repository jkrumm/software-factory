import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  ArtifactReply,
  AskReply,
  ChainModel,
  NeedsModel,
  PlanningPassAnswer,
  ReplanAnswer,
  ReplanApplyAnswer,
} from '@software-factory/contract'
import { admitted, fileIssue, must, run, settle, stateOf, tick } from '../flow.ts'
import { type Lab, startLab } from './lab.ts'

let lab: Lab

const project = (name: string) => `apiVersion: factory/v2\nname: ${name}\nleads: 3\n`

beforeAll(async () => {
  lab = await startLab({
    leads: true,
    env: { FACTORY_LEADS_PER_ACCOUNT: '16' },
    repos: { app: { project: project('app') }, lib: { project: project('lib') } },
  })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
})

const replanBody = (body: object) => ['--body', JSON.stringify(body)]
const chain = async () => ChainModel.parse((await must(lab, ['read', 'chain'])).json).blocking
const notes = async (issue: string): Promise<string[]> =>
  (
    await lab.world.db.sql`
      SELECT payload->>'text' AS text, actor FROM factory.issue_events
      WHERE issue_id = ${issue} AND kind = 'noted' AND result = 'applied' ORDER BY version`
  ).map((row: { text: string; actor: string }) => `${row.actor}: ${row.text}`)

test('an approved Replan Spec lets its lead change the chain and cancel, inside its own project only', async () => {
  const filed = ReplanAnswer.parse((await must(lab, ['planning', 'replan', 'app', '--ask', 'reshape the chain'])).json)
  const replan = filed.issue
  await admitted(lab, replan)
  await tick(lab)

  // The project's Issues, queued, and one blocker from the other project: an edge may cross projects, a target may not.
  const blocker = await fileIssue(lab, { repo: 'lib', title: 'A lib blocker' })
  await settle(lab, blocker, [])
  const foreign = await fileIssue(lab, { repo: 'lib', title: 'A lib Issue' })
  await settle(lab, foreign, [blocker])
  const [a, b, c, d] = [
    await fileIssue(lab, { repo: 'app', title: 'A' }),
    await fileIssue(lab, { repo: 'app', title: 'B' }),
    await fileIssue(lab, { repo: 'app', title: 'C' }),
    await fileIssue(lab, { repo: 'app', title: 'D' }),
  ]
  for (const issue of [a, b, c]) await settle(lab, issue, [blocker])
  await settle(lab, d, [blocker, a])

  const replanVerb = (body: object, as: 'owner' | 'agent' = 'agent') =>
    run(lab, ['issue', 'replan', replan, ...replanBody(body)], as)
  const apply = {
    attempt: 1,
    call: 'one',
    edges: { add: [{ issue: b, after: [c] }], remove: [{ issue: d, after: [a] }] },
    cancel: [{ issue: a, reason: 'dropped by the plan' }],
  }

  // No Spec yet: refused, nothing changed.
  const early = await replanVerb(apply)
  expect(early.code).toBe(5)
  expect(early.err).toContain('not_approved')

  // A Decision, answered, then the Spec: both reach Needs you.
  const asked = AskReply.parse(
    (
      await must(lab, [
        'issue',
        'ask',
        replan,
        ...replanBody({
          attempt: 1,
          question: 'Drop A or keep it?',
          recommendation: 'drop',
          checked: 'Read the plan and the open Issues.',
          options: [
            { label: 'drop', reversible: true, cost: 'A is gone' },
            { label: 'keep', reversible: true, cost: 'A stays queued' },
          ],
          noAnswer: { consequence: 'The Spec keeps A.' },
        }),
      ])
    ).json,
  )
  await must(lab, ['checkpoint', 'pass'])
  const needs = () => must(lab, ['read', 'needs']).then((r) => NeedsModel.parse(r.json))
  expect((await needs()).items.find((item) => item.id === asked.decision.id)).toMatchObject({ kind: 'decision' })
  await must(lab, ['decision', 'answer', asked.decision.id, 'drop'])
  const submitted = ArtifactReply.parse(
    (
      await must(lab, [
        'artifact',
        'submit',
        replan,
        ...replanBody({ attempt: 1, kind: 'spec', title: 'Replan: app', content: '# Replan\n\nCancel A, B after C.' }),
      ])
    ).json,
  )
  // a Spec reaches Needs you once the Spec screen passes it (the fake agw passes it)
  await must(lab, ['checkpoint', 'pass'])
  expect((await needs()).items.find((item) => item.id === submitted.artifact.id)).toMatchObject({ kind: 'review' })

  // Waiting for the verdict, the lead is not the one who applies: refused, nothing changed.
  const waiting = await replanVerb(apply)
  expect(waiting.code).toBe(5)
  expect(waiting.err).toContain('wrong_state')
  expect((await chain())[b]).toEqual([blocker])

  await must(lab, ['artifact', 'verdict', submitted.artifact.id, ...replanBody({ verdict: 'with_notes' })])
  expect((await stateOf(lab.world, replan)).state).toBe('working')

  // The policy lets the agent call the verb, and still not the owner's edge and cancel routes.
  expect((await run(lab, ['planning', 'after', ...replanBody({ issue: b, after: [c] })], 'agent')).code).toBe(3)
  expect((await run(lab, ['issue', 'cancel', a, '--reason', 'x'], 'agent')).code).toBe(3)

  // The wrong attempt, a target of the other project, another Replan-less Issue, an empty call: refused whole.
  expect((await replanVerb({ ...apply, attempt: 2 })).err).toContain('wrong_state')
  const outside = await replanVerb({ ...apply, cancel: [...apply.cancel, { issue: foreign, reason: 'not ours' }] })
  expect(outside.code).toBe(5)
  expect(outside.err).toContain('outside_project')
  expect((await stateOf(lab.world, a)).state).toBe('queued')
  expect((await chain())[b]).toEqual([blocker])
  const notReplan = await run(
    lab,
    ['issue', 'replan', a, ...replanBody({ attempt: 1, cancel: [{ issue: b, reason: 'x' }] })],
    'agent',
  )
  expect(notReplan.err).toContain('not_a_replan')
  expect((await replanVerb({ attempt: 1 })).code).not.toBe(0)

  // The approved call applies, as the orchestrator, and says what each op did.
  const applied = ReplanApplyAnswer.parse(
    (await must(lab, ['issue', 'replan', replan, ...replanBody(apply)], 'agent')).json,
  )
  expect(applied.results).toEqual([
    { op: 'add', issue: b, ok: true, detail: '1 edge(s) added' },
    { op: 'remove', issue: d, ok: true, detail: '1 edge(s) removed' },
    { op: 'cancel', issue: a, ok: true, detail: null },
  ])
  const blocking = await chain()
  expect([...(blocking[b] ?? [])].sort()).toEqual([blocker, c].sort())
  expect(blocking[d]).toEqual([blocker])
  expect((await stateOf(lab.world, a)).outcome).toBe('cancelled')
  expect((await notes(b)).some((n) => n.startsWith('factory: edges changed by Replan'))).toBe(true)
  expect((await notes(d)).some((n) => n.startsWith('orchestrator: orchestrator removed'))).toBe(true)

  // Not an owner touch: the avoidable-touch count reads the owner alone.
  const [touches] = await lab.world.db.sql`
    SELECT count(*)::int AS n FROM factory.issue_events
    WHERE actor = 'owner' AND kind = 'cancelled' AND issue_id = ${a}`
  expect(touches?.n).toBe(0)

  // The same call again changes nothing: the edge is there, the removal reports it, the cancel is one event.
  const before = await lab.world.db.sql`SELECT count(*)::int AS n FROM factory.issue_events`
  const again = ReplanApplyAnswer.parse(
    (await must(lab, ['issue', 'replan', replan, ...replanBody(apply)], 'agent')).json,
  )
  expect(again.results.map((r) => [r.op, r.ok])).toEqual([
    ['add', true],
    ['remove', false],
    ['cancel', true],
  ])
  expect(again.results[1]?.detail).toContain('unknown_edge')
  const after = await lab.world.db.sql`SELECT count(*)::int AS n FROM factory.issue_events`
  const cancelled = await lab.world.db
    .sql`SELECT count(*)::int AS n FROM factory.issue_events WHERE issue_id = ${a} AND kind = 'cancelled' AND result = 'applied'`
  expect(cancelled[0]?.n).toBe(1)
  expect(after[0]?.n).toBeLessThanOrEqual((before[0]?.n as number) + 2)

  // A new call cancelling the closed Issue: ok false with the machine's reason.
  const closed = ReplanApplyAnswer.parse(
    (
      await must(
        lab,
        [
          'issue',
          'replan',
          replan,
          ...replanBody({ attempt: 1, call: 'two', cancel: [{ issue: a, reason: 'again' }] }),
        ],
        'agent',
      )
    ).json,
  )
  expect(closed.results[0]).toMatchObject({ op: 'cancel', issue: a, ok: false })

  // The lead's plan.yaml edit merges; the server files the new row.
  await lab.commit('app', {
    'docs/plan.yaml': `version: 1\nrows:\n  - key: reshaped\n    title: The reshaped step\n    facts: { why: the Replan asked for it, acceptance: it works }\n`,
  })
  const pass = PlanningPassAnswer.parse((await must(lab, ['planning', 'pass', '--fetch', 'true'])).json)
  expect(pass.errors).toEqual([])
  expect(pass.filed).toMatchObject([{ project: 'app', row: 'reshaped' }])
})
