import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ArtifactDetail,
  ArtifactReply,
  AskReply,
  DecisionList,
  DecisionReply,
  DecisionView,
  ErrandList,
  ErrandReply,
  NeedsModel,
  PageList,
  PassReply,
} from '@software-factory/contract'
import { admitted, fileIssue, tick } from '../flow.ts'
import { factory, type ServerProcess, type World } from '../harness.ts'
import { type Lab, startLab } from '../planning/lab.ts'

/**
 * Where the factory stops for a person, against the real server process and Postgres with the fake agw (the Judge) and a
 * fake ntfy: the lead's verbs and the owner's, as the generated CLI sends them. An Issue is brought to `working` the way the
 * factory does it: filed with `issue new`, settled and admitted through planning and capacity, its lead started by the leads' loop.
 */
let lab: Lab
let world: World
let server: ServerProcess
let dir: string
let issues = 0

const PROJECTS = ['spec', 'policy', 'owner', 'judge', 'default', 'refused', 'amend', 'errand', 'annotate'].map(
  (name) => `example-${name}`,
)

interface Published {
  title: string | null
  click: string | null
  tags: string | null
  authorization: string | null
  body: string
}
const published: Published[] = []
let ntfy: ReturnType<typeof Bun.serve>

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-checkpoints-')
  ntfy = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      published.push({
        title: request.headers.get('title'),
        click: request.headers.get('click'),
        tags: request.headers.get('tags'),
        authorization: request.headers.get('authorization'),
        body: await request.text(),
      })
      return new Response('ok')
    },
  })
  await writeFile(
    join(dir, 'policy.json'),
    JSON.stringify({
      'example-policy': [{ when: 'logging library', answer: 'winston', reason: 'the owner standardised on it' }],
    }),
  )
  await writeFile(
    join(dir, 'judge.json'),
    JSON.stringify([
      {
        match: 'access log',
        verdict: { verdict: 'answer', answer: 'pino', reason: 'the plan decided', source: 'plan: docs/decisions.md' },
      },
    ]),
  )
  lab = await startLab({
    leads: true,
    repos: Object.fromEntries(PROJECTS.map((name) => [name, { project: `apiVersion: factory/v2\nname: ${name}\n` }])),
    env: {
      FACTORY_LEADS_PER_ACCOUNT: '16',
      FACTORY_DATA_DIR: join(dir, 'data'),
      FACTORY_CHECKPOINT_POLICY_FILE: join(dir, 'policy.json'),
      FACTORY_FAKE_ASK_SCRIPT: join(dir, 'judge.json'),
      FACTORY_NTFY_URL: `http://127.0.0.1:${ntfy.port}`,
      FACTORY_NTFY_TOPIC: 'factory',
      NTFY_TOKEN: 'scenario-token',
      FACTORY_CONSOLE_URL: 'https://console.example.test',
    },
  })
  world = lab.world
  server = lab.server
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
  await ntfy.stop(true)
  await rm(dir, { recursive: true, force: true })
})

/** An Issue with its lead working (attempt 1). */
async function workingIssue(repo: string): Promise<string> {
  const issue = await fileIssue(lab, { repo, title: `scenario issue ${++issues}` })
  await admitted(lab, issue)
  await tick(lab)
  return issue
}

/** Runs `factory <args>` against the server; the JSON a success printed, or the exit code and the error. */
async function cli(...args: string[]) {
  const run = await factory(world, [...args, '--format', 'json'], { FACTORY_URL: server.url })
  return { ...run, json: run.out.trim() ? (JSON.parse(run.out) as unknown) : null }
}

const body = (value: unknown): string[] => ['--body', JSON.stringify(value)]

async function ok<T>(parse: (json: unknown) => T, ...args: string[]): Promise<T> {
  const run = await cli(...args)
  if (run.code !== 0) throw new Error(`factory ${args.join(' ')} exited ${run.code}: ${run.err}`)
  return parse(run.json)
}

/** Every `agw factory-ask` the fake saw, with the input the Judge was given. */
async function askCalls(): Promise<{ args: string[]; stdin: string }[]> {
  const lines = (await readFile(join(world.bin, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
  return lines
    .map((line) => JSON.parse(line) as { tool: string; args: string[]; stdin?: string })
    .filter((call) => call.args[0] === 'factory-ask')
    .map((call) => ({ args: call.args, stdin: call.stdin ?? '' }))
}

const pass = () => ok((json) => PassReply.parse(json), 'checkpoint', 'pass')
const pages = () => ok((json) => PageList.parse(json).pages, 'page', 'list')
const decisionPages = () => published.filter((p) => p.tags === 'decision')

const FORM = (question: string, patch: Record<string, unknown> = {}) => ({
  attempt: 1,
  question,
  recommendation: 'pino',
  checked: 'Read the package sizes and the Bun notes.',
  options: [
    { label: 'pino', reversible: true, cost: 'one dependency, fast' },
    { label: 'winston', reversible: true, cost: 'heavier, more transports' },
  ],
  noAnswer: { consequence: 'The lead logs with console until someone answers.' },
  ...patch,
})

test("a verdict on a submitted Spec arrives as the lead's next turn: one note_lead, once", async () => {
  const issueId = await workingIssue('example-spec')
  const submitted = await ok(
    (json) => ArtifactReply.parse(json),
    'artifact',
    'submit',
    issueId,
    ...body({
      attempt: 1,
      kind: 'spec',
      title: 'The queue spec',
      content: '# Queue\n\nWe keep the queue in Postgres.',
    }),
  )
  expect(submitted).toMatchObject({ result: 'applied', issue: { state: 'waiting', waitReason: 'review' } })
  const artifactId = submitted.artifact.id

  await ok(
    (json) => ArtifactReply.parse(json),
    'artifact',
    'annotate',
    artifactId,
    ...body({ quote: 'keep the queue in Postgres', path: 'Queue', comment: 'Name the lock.' }),
  )
  expect(await pass()).toMatchObject({ pages: { sent: [expect.stringContaining('page:review')] } })

  const verdict = await ok(
    (json) => ArtifactReply.parse(json),
    'artifact',
    'verdict',
    artifactId,
    ...body({ verdict: 'with_notes', note: 'Good, but name the lock.' }),
  )
  expect(verdict).toMatchObject({ result: 'applied', verdict: { verdict: 'with_notes' }, issue: { state: 'working' } })
  expect(verdict.issue?.effects.map((e) => e.kind)).toEqual(['note_lead'])

  // The verdict again, and another on the same revision: the first stands, and nothing reaches the lead twice.
  for (const again of [{ verdict: 'with_notes', note: 'Good, but name the lock.' }, { verdict: 'looks_good' }]) {
    const replay = await ok((json) => ArtifactReply.parse(json), 'artifact', 'verdict', artifactId, ...body(again))
    expect(replay).toMatchObject({ result: 'replayed', verdict: { verdict: 'with_notes' }, issue: { effects: [] } })
  }

  const shown = await ok((json) => ArtifactDetail.parse(json), 'artifact', 'show', artifactId)
  expect(shown.verdicts).toMatchObject([{ revision: 1, verdict: 'with_notes' }])
  expect(shown.annotations).toHaveLength(1)
  expect(shown.unanchored).toEqual([])
})

test('a Decision is settled by standing policy: no Judge call, no page', async () => {
  const issueId = await workingIssue('example-policy')
  const asked = await ok(
    (json) => AskReply.parse(json),
    'issue',
    'ask',
    issueId,
    ...body(FORM('Which logging library should the server use?')),
  )
  expect(asked).toMatchObject({ result: 'applied', issue: { state: 'waiting', waitReason: 'decision' } })

  const passed = await pass()
  expect(passed.decisions).toEqual([{ decision: asked.decision.id, status: 'answered', settledBy: 'policy' }])
  const shown = await ok((json) => DecisionView.parse(json), 'decision', 'show', asked.decision.id)
  expect(shown).toMatchObject({ answer: 'winston', source: 'the owner standardised on it' })
  expect(shown.path.map((s) => [s.step, s.outcome])).toEqual([['policy', 'answered']])
  expect(await askCalls()).toEqual([])
  expect(decisionPages()).toEqual([])
})

test('a Decision no one settles reaches the owner: paged once, with a deep link, however often the pass runs', async () => {
  const issueId = await workingIssue('example-owner')
  const asked = await ok(
    (json) => AskReply.parse(json),
    'issue',
    'ask',
    issueId,
    ...body(FORM('Which retention for the audit log rows?')),
  )
  const id = asked.decision.id

  const first = await pass()
  expect(first.decisions).toEqual([{ decision: id, status: 'open', settledBy: null }])
  expect(first.pages.sent).toEqual([`page:decision:${id}`])
  expect(decisionPages()).toHaveLength(1)
  expect(decisionPages()[0]).toMatchObject({
    title: 'Decision',
    click: `https://console.example.test/checkpoints/${id}`,
    authorization: 'Bearer scenario-token',
  })
  expect(decisionPages()[0]?.body).toBe(
    'Issue 3 (example-owner) asks: “Which retention for the audit log rows?” Recommended: “pino”',
  )
  for (let i = 0; i < 3; i++) await pass()
  expect(decisionPages()).toHaveLength(1)

  const answered = await ok((json) => DecisionReply.parse(json), 'decision', 'answer', id, 'winston')
  expect(answered).toMatchObject({
    decision: { status: 'answered', settledBy: 'owner', answer: 'winston' },
    issue: { state: 'working' },
  })
  expect(answered.issue?.effects.map((e) => e.kind)).toEqual(['note_lead'])
  const again = await cli('decision', 'answer', id, 'pino')
  expect(again.code).toBe(5)
  expect(again.err).toContain('already_answered')

  const flagged = await ok(
    (json) => DecisionReply.parse(json),
    'decision',
    'worth-asking',
    id,
    ...body({ worth: true }),
  )
  expect(flagged.decision.worthAsking).toBe(true)
  const ledger = await ok((json) => DecisionList.parse(json).decisions, 'decision', 'list', '--worth', 'yes')
  expect(ledger).toHaveLength(1)
  expect(ledger[0]?.path.map((s) => [s.step, s.outcome])).toEqual([
    ['policy', 'passed'],
    ['judge', 'passed'],
    ['owner', 'open'],
  ])
})

test("a Decision is settled by the Judge, who is given the owner's earlier answers as precedent; no page", async () => {
  const issueId = await workingIssue('example-judge')
  const asked = await ok(
    (json) => AskReply.parse(json),
    'issue',
    'ask',
    issueId,
    ...body(FORM('Which retention for the access log rows?')),
  )
  const passed = await pass()
  expect(passed.decisions).toEqual([{ decision: asked.decision.id, status: 'answered', settledBy: 'judge' }])
  const shown = await ok((json) => DecisionView.parse(json), 'decision', 'show', asked.decision.id)
  expect(shown).toMatchObject({ answer: 'pino', source: 'plan: docs/decisions.md' })

  const calls = await askCalls()
  const given = JSON.parse(calls.at(-1)?.stdin ?? '{}') as {
    precedents: { question: string; answer: string; settledBy: string; worthAsking: boolean | null }[]
  }
  // The owner's own answer comes first; the policy's, which shares the stemmed word "log", follows.
  expect(given.precedents[0]).toMatchObject({
    question: 'Which retention for the audit log rows?',
    answer: 'winston',
    settledBy: 'owner',
    worthAsking: true,
  })
  expect(decisionPages()).toHaveLength(1)
})

test('a Decision is settled by its default after the wait, when the option is reversible; no page', async () => {
  const issueId = await workingIssue('example-default')
  const asked = await ok(
    (json) => AskReply.parse(json),
    'issue',
    'ask',
    issueId,
    ...body(
      FORM('Which cache ttl for the sessions?', {
        recommendation: 'five minutes',
        options: [
          { label: 'five minutes', reversible: true, cost: 'more refreshes' },
          { label: 'one hour', reversible: true, cost: 'stale sessions' },
        ],
        noAnswer: { consequence: 'Sessions use five minutes.', default: 'five minutes', waitMinutes: 30 },
      }),
    ),
  )
  const id = asked.decision.id
  expect(asked.decision.defaultAt).not.toBeNull()
  expect((await pass()).decisions).toEqual([{ decision: id, status: 'open', settledBy: null }])

  // Time passes: the Decision was asked 31 minutes ago (the scenario moves the fact in its own table).
  await world.db.sql`UPDATE factory.decisions SET asked_at = asked_at - interval '31 minutes' WHERE id = ${id}`
  expect((await pass()).decisions).toEqual([{ decision: id, status: 'answered', settledBy: 'default' }])
  const shown = await ok((json) => DecisionView.parse(json), 'decision', 'show', id)
  expect(shown).toMatchObject({ answer: 'five minutes', settledBy: 'default' })
  expect(shown.path.map((s) => [s.step, s.outcome])).toEqual([
    ['policy', 'passed'],
    ['judge', 'passed'],
    ['default', 'answered'],
  ])
  expect(decisionPages()).toHaveLength(1)
})

test('a Decision missing a field is refused with the field named, and nothing is stored', async () => {
  const issueId = await workingIssue('example-refused')
  const before = (await ok((json) => DecisionList.parse(json).decisions, 'decision', 'list')).length
  const { recommendation: _gone, ...without } = FORM('Which formatter?')
  const refused = await cli('issue', 'ask', issueId, ...body(without))
  expect(refused.code).toBe(2)
  expect(refused.err).toContain('missing_field')
  expect(refused.err).toContain('recommendation')
  expect(refused.err).toContain('Nothing was raised: ask again with every field')
  const unreversible = await cli(
    'issue',
    'ask',
    issueId,
    ...body(
      FORM('Which formatter?', {
        options: [
          { label: 'pino', cost: 'x' },
          { label: 'winston', reversible: false, cost: 'y' },
        ],
      }),
    ),
  )
  expect(unreversible.err).toContain('options[0].reversible')
  expect((await ok((json) => DecisionList.parse(json).decisions, 'decision', 'list')).length).toBe(before)
})

test('an Errand raised by the lead and done by the owner: paged once, and the lead hears it as its next turn', async () => {
  const issueId = await workingIssue('example-errand')
  const raised = await ok(
    (json) => ErrandReply.parse(json),
    'errand',
    'raise',
    issueId,
    ...body({
      attempt: 1,
      summary: 'Approve the App Store build in the portal',
      detail: 'Release > Build 42 > Approve',
      tried: 'looked for an API route: none',
    }),
  )
  expect(raised).toMatchObject({ result: 'applied', issue: { state: 'waiting', waitReason: 'errand' } })
  const open = await ok((json) => ErrandList.parse(json).errands, 'errand', 'list', '--open', 'yes')
  expect(open.map((e) => e.id)).toEqual([raised.errand.id])

  // held by the screen until the pass lets it through, then paged in the same pass
  const passed = await pass()
  expect(passed.errands).toEqual([{ errand: raised.errand.id, outcome: 'reached_owner' }])
  expect(passed.pages.sent).toEqual([`page:errand:${raised.errand.id}`])
  expect(published.filter((p) => p.tags === 'errand')).toHaveLength(1)

  const done = await ok(
    (json) => ErrandReply.parse(json),
    'errand',
    'done',
    raised.errand.id,
    ...body({ note: 'approved' }),
  )
  expect(done).toMatchObject({ result: 'applied', errand: { doneNote: 'approved' }, issue: { state: 'working' } })
  expect(done.issue?.effects.map((e) => e.kind)).toEqual(['note_lead'])
  const again = await ok((json) => ErrandReply.parse(json), 'errand', 'done', raised.errand.id, ...body({}))
  expect(again).toMatchObject({ result: 'replayed', issue: { effects: [] } })
  expect(await ok((json) => ErrandList.parse(json).errands, 'errand', 'list', '--open', 'yes')).toEqual([])
})

test('an annotation whose quote is gone lands in Unanchored', async () => {
  const issueId = await workingIssue('example-annotate')
  const report = await ok(
    (json) => ArtifactReply.parse(json),
    'artifact',
    'submit',
    issueId,
    ...body({
      attempt: 1,
      kind: 'report',
      title: 'Notes',
      content: '# Notes\n\nWe keep the queue in Postgres. Retries are three.',
    }),
  )
  // A Report never waits.
  expect(report.issue).toBeNull()
  const id = report.artifact.id
  for (const [quote, comment] of [
    ['keep the queue in Postgres', 'why not Redis?'],
    ['Retries are three', 'make it five'],
  ] as const) {
    await ok(
      (json) => ArtifactReply.parse(json),
      'artifact',
      'annotate',
      id,
      ...body({ quote, comment, path: 'Notes' }),
    )
  }
  await ok(
    (json) => ArtifactReply.parse(json),
    'artifact',
    'revise',
    id,
    ...body({ content: '# Notes\n\nWe keep the queue in Postgres.', note: 'cut the retries' }),
  )
  const shown = await ok((json) => ArtifactDetail.parse(json), 'artifact', 'show', id)
  expect(shown.revision).toBe(2)
  expect(shown.annotations.map((a) => a.quote)).toEqual(['keep the queue in Postgres'])
  expect(shown.unanchored.map((a) => [a.quote, a.comment, a.revision])).toEqual([
    ['Retries are three', 'make it five', 1],
  ])
  const first = await ok((json) => ArtifactDetail.parse(json), 'artifact', 'show', id, '--revision', '1')
  expect(first.unanchored).toEqual([])
})

test('a replayed outbox pages once: the same asks and passes again send nothing', async () => {
  const sentBefore = published.length
  const listed = await pages()
  expect(listed.map((p) => p.status)).toEqual(Array(listed.length).fill('sent'))
  expect(listed.filter((p) => p.kind === 'decision')).toHaveLength(1)

  // The same ask again (the lead retried) is the same Decision and plans no second page.
  const owned = (await ok((json) => DecisionList.parse(json).decisions, 'decision', 'list')).find(
    (d) => d.question === 'Which retention for the audit log rows?',
  )
  const replay = await ok(
    (json) => AskReply.parse(json),
    'issue',
    'ask',
    owned?.issueId ?? '',
    ...body(FORM('Which retention for the audit log rows?')),
  )
  expect(replay).toMatchObject({ result: 'replayed', decision: { id: owned?.id } })
  for (let i = 0; i < 3; i++) expect((await pass()).pages).toEqual({ sent: [], failed: [] })
  expect(published).toHaveLength(sentBefore)
  expect((await pages()).length).toBe(listed.length)

  // One page per checkpoint that reached the owner: the Spec, one Decision, one Errand. Nothing the factory settled paged.
  expect(published.map((p) => p.tags).sort()).toEqual(['decision', 'errand', 'review'])
})

test('a Decision reaches Needs you only after the Judge saw it, and is amended by a second ask on the open question', async () => {
  const issueId = await workingIssue('example-amend')
  const needs = () => ok((json) => NeedsModel.parse(json), 'read', 'needs')
  const before = (await askCalls()).length
  const asked = await ok(
    (json) => AskReply.parse(json),
    'issue',
    'ask',
    issueId,
    ...body(FORM('Which backup window for the nightly dump?')),
  )
  const id = asked.decision.id
  expect(asked).toMatchObject({ result: 'applied', decision: { judge: null } })
  expect((await needs()).items.filter((item) => item.id === id)).toEqual([])
  expect(await askCalls()).toHaveLength(before)

  await pass()
  const calls = await askCalls()
  expect(calls).toHaveLength(before + 1)
  expect(JSON.parse(calls.at(-1)?.stdin ?? '{}')).toMatchObject({
    question: 'Which backup window for the nightly dump?',
  })
  const listed = (await needs()).items.find((item) => item.id === id)
  expect(listed).toMatchObject({ kind: 'decision', judge: 'nothing scripted: a taste question' })
  const shown = await ok((json) => DecisionView.parse(json), 'decision', 'show', id)
  expect(shown.judge).toMatchObject({ outcome: 'passed', detail: 'nothing scripted: a taste question' })

  const amended = await ok(
    (json) => AskReply.parse(json),
    'issue',
    'ask',
    issueId,
    ...body(FORM('Which backup window, 02:00 or 04:00, for the nightly dump?', { recommendation: 'winston' })),
  )
  expect(amended).toMatchObject({ result: 'amended', decision: { id, recommendation: 'winston', judge: null } })
  expect((await needs()).items.filter((item) => item.id === id)).toEqual([])
  const same = await ok(
    (json) => AskReply.parse(json),
    'issue',
    'ask',
    issueId,
    ...body(FORM('Which backup window, 02:00 or 04:00, for the nightly dump?', { recommendation: 'winston' })),
  )
  expect(same.result).toBe('replayed')
  await pass()
  expect((await askCalls()).length).toBe(before + 2)
  expect((await needs()).items.find((item) => item.id === id)).toMatchObject({ kind: 'decision' })
  await ok((json) => DecisionReply.parse(json), 'decision', 'answer', id, 'pino')
  const next = await ok(
    (json) => AskReply.parse(json),
    'issue',
    'ask',
    issueId,
    ...body(FORM('Which retention for the dump files?')),
  )
  expect(next.result).toBe('applied')
  expect(next.decision.id).not.toBe(id)
})

test('only the Spec screen, the Judge and the Errand screen called agw', async () => {
  const calls = (await world.calls()).filter((call) => call.tool === 'agw')
  expect(calls.map((call) => call.args[0])).toEqual([
    'factory-spec-screen',
    'factory-ask',
    'factory-ask',
    'factory-ask',
    'factory-errand',
    'factory-ask',
    'factory-ask',
  ])
})
