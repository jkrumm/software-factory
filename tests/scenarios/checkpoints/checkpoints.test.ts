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
import { JUDGE_MAX_TRIES } from '../../../apps/server/src/kernel/judge-tries.ts'
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

const PROJECTS = ['spec', 'long', 'owner', 'judge', 'default', 'refused', 'amend', 'errand', 'annotate', 'down'].map(
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
    join(dir, 'judge.json'),
    JSON.stringify([
      {
        match: 'access log',
        verdict: { verdict: 'answer', answer: 'pino', reason: 'the plan decided', source: 'plan: docs/decisions.md' },
      },
      { match: 'build cache', fail: true },
      {
        match: 'artifact mirror',
        // what agw answers when its model failed: a valid verdict that hands the ask to the owner
        verdict: { verdict: 'owner', answer: '', reason: 'judge unavailable: timeout', source: '' },
      },
    ]),
  )
  lab = await startLab({
    leads: true,
    repos: Object.fromEntries(PROJECTS.map((name) => [name, { project: `apiVersion: factory/v2\nname: ${name}\n` }])),
    env: {
      FACTORY_LEADS_PER_ACCOUNT: '16',
      FACTORY_DATA_DIR: join(dir, 'data'),
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
  class: 'direction',
  whyYours: 'What the server logs is what its users can ask support about.',
  question,
  recommendation: 'pino',
  checked: 'Read the package sizes and the Bun notes.',
  options: [
    { label: 'pino', leadsTo: 'JSON lines on stdout', reversible: true, cost: 'one dependency, fast' },
    { label: 'winston', leadsTo: 'transports to files', reversible: true, cost: 'heavier, more transports' },
  ],
  noAnswer: { consequence: 'The lead logs with console until someone answers.' },
  ...patch,
})

test("a lead's Spec is its plan: no wait, no page; the owner's comment and verdict reach the lead as notes, once", async () => {
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
      content: '# Queue\n\n## Build\n\nWe keep the queue in Postgres.\n\n## Decided\n\nPostgres: it is there.',
    }),
  )
  expect(submitted).toMatchObject({ result: 'applied', issue: null })
  expect(submitted.next).toContain('Recorded as your plan')
  const artifactId = submitted.artifact.id
  const notes = async () =>
    (
      await world.db.sql`SELECT payload->>'text' AS text FROM factory.issue_events
        WHERE issue_id = ${issueId} AND kind = 'noted' AND result = 'applied' ORDER BY version`
    ).map((row: { text: string }) => row.text)

  await ok(
    (json) => ArtifactReply.parse(json),
    'artifact',
    'annotate',
    artifactId,
    ...body({ quote: 'keep the queue in Postgres', path: 'Queue', comment: 'Name the lock.' }),
  )
  expect(await notes()).toEqual([expect.stringContaining('Name the lock.')])
  const passed = await pass()
  expect(passed.specs).toEqual([])
  expect(passed.pages.sent.filter((page) => page.includes('page:review'))).toEqual([])
  const needs = await ok((json) => NeedsModel.parse(json), 'read', 'needs')
  expect(needs.items.filter((item) => item.id === artifactId)).toEqual([])

  const verdict = await ok(
    (json) => ArtifactReply.parse(json),
    'artifact',
    'verdict',
    artifactId,
    ...body({ verdict: 'with_notes', note: 'Good, but name the lock.' }),
  )
  // the plan has no wait to end: the verdict reaches the lead as a note, the Issue works on
  expect(verdict).toMatchObject({ result: 'applied', verdict: { verdict: 'looks_good' }, issue: null })
  // With notes is retired: it was stored as Looks good, and the lead is told to apply the note and the open comment.
  const noted = await notes()
  expect(noted).toHaveLength(2)
  expect(noted[1]).toContain('Looks good. Read it with: factory artifact show')
  expect(noted[1]).toContain('Good, but name the lock.')
  expect(noted[1]).toContain('Apply his open comment')
  expect(noted[1]).toContain('Name the lock.')

  // The verdict again, and another on the same revision: the first stands, and nothing reaches the lead twice.
  for (const again of [{ verdict: 'with_notes', note: 'Good, but name the lock.' }, { verdict: 'looks_good' }]) {
    const replay = await ok((json) => ArtifactReply.parse(json), 'artifact', 'verdict', artifactId, ...body(again))
    expect(replay).toMatchObject({ result: 'replayed', verdict: { verdict: 'looks_good' }, issue: { effects: [] } })
  }

  const shown = await ok((json) => ArtifactDetail.parse(json), 'artifact', 'show', artifactId)
  expect(shown.verdicts).toMatchObject([{ revision: 1, verdict: 'looks_good' }])
  expect(shown.annotations).toHaveLength(1)
  expect(shown.unanchored).toEqual([])
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
  expect(decisionPages()[0]?.body).toBe('Issue 2 (example-owner) asks: “Which retention for the audit log rows?”')
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
    ['judge', 'passed'],
    ['owner', 'open'],
  ])
})

test("a Decision is answered by the Judge, who is given the owner's earlier answers as precedent; no page", async () => {
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
    precedents: { question: string; answer: string; settledBy: string }[]
  }
  // Only the owner's own answers are precedent.
  expect(given.precedents[0]).toMatchObject({
    question: 'Which retention for the audit log rows?',
    answer: 'winston',
    settledBy: 'owner',
  })
  // agw's `factory-ask` dropped the owner's worth-asking mark from its precedents: none is sent.
  expect(given.precedents[0]).not.toHaveProperty('worthAsking')
  expect(given.precedents.every((p) => p.settledBy === 'owner')).toBe(true)
  expect(decisionPages()).toHaveLength(1)
})

test('a Decision is answered by its default after the wait, when the option is reversible; no page', async () => {
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
      need: 'hands',
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

test('two Issues of a repo raise the same need: one Errand, one page, and his one answer ends both waits', async () => {
  const first = await workingIssue('example-errand')
  const second = await workingIssue('example-errand')
  const raise = (issue: string, extra: Record<string, unknown>) =>
    ok(
      (json) => ErrandReply.parse(json),
      'errand',
      'raise',
      issue,
      ...body({ attempt: 1, need: 'hands', tried: 'looked for an API route: none', ...extra }),
    )
  const raised = await raise(first, { summary: 'Set the census contact in the portal', needKey: 'census-contact' })
  expect(raised.result).toBe('applied')
  // another wording, the lead's own name for the need
  const joined = await raise(second, {
    summary: 'The census poller needs a contact address',
    needKey: 'census-contact',
  })
  expect(joined).toMatchObject({
    result: 'joined',
    errand: { id: raised.errand.id },
    issue: { state: 'waiting', waitReason: 'errand' },
  })
  expect(await ok((json) => ErrandList.parse(json).errands, 'errand', 'list', '--open', 'yes')).toHaveLength(1)

  const passed = await pass()
  expect(passed.pages.sent).toEqual([`page:errand:${raised.errand.id}`])
  const needs = await ok((json) => NeedsModel.parse(json), 'read', 'needs')
  expect(needs.items.filter((item) => item.kind === 'errand')).toMatchObject([
    { id: raised.errand.id, joined: 1, joinedIssues: [second] },
  ])

  const done = await ok((json) => ErrandReply.parse(json), 'errand', 'done', raised.errand.id, ...body({ note: 'set' }))
  expect(done).toMatchObject({ result: 'applied', issue: { state: 'working' } })
  const shown = await Promise.all(
    [first, second].map(async (id) => (await cli('issue', 'show', id)).json as { state: string }),
  )
  expect(shown.map((issue) => issue.state)).toEqual(['working', 'working'])
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

  // One page per checkpoint that reached the owner: one Decision, two Errands (the second was joined by another Issue, which
  // paged nothing). Nothing the factory settled paged, and the lead's Spec, its plan, reached no one.
  expect(published.map((p) => p.tags).sort()).toEqual(['decision', 'errand', 'errand'])
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

test('only the Judge and the Errand screen called agw: no workflow reads a Spec', async () => {
  const calls = (await world.calls()).filter((call) => call.tool === 'agw')
  expect(calls.map((call) => call.args[0])).toEqual([
    'factory-ask',
    'factory-ask',
    'factory-ask',
    'factory-errand',
    'factory-errand',
    'factory-ask',
    'factory-ask',
  ])
})

/** A Decision whose Judge run failed, or answered that it is unavailable, is a failed try: the owner is paged after the last one only. */
for (const [how, question] of [
  ['the run fails', 'Which build cache layout for the runners?'],
  ['the answer says unavailable', 'Which artifact mirror for the runners?'],
] as const) {
  test(`a Decision whose Judge call fails (${how}) is tried ${JUDGE_MAX_TRIES} times before the owner is paged`, async () => {
    const issueId = await workingIssue('example-down')
    await pass()
    const before = (await askCalls()).length
    const asked = await ok((json) => AskReply.parse(json), 'issue', 'ask', issueId, ...body(FORM(question)))
    const id = asked.decision.id
    const pagesOf = (decision: string) => decisionPages().filter((p) => p.click?.endsWith(decision))
    const needs = async () =>
      (await ok((json) => NeedsModel.parse(json), 'read', 'needs')).items.filter((i) => i.id === id)
    const judgeStep = () =>
      world.db.sql`SELECT outcome, tries FROM factory.decision_steps WHERE decision_id = ${id} AND step = 'judge'`
    const ownerSteps = () =>
      world.db.sql`SELECT 1 FROM factory.decision_steps WHERE decision_id = ${id} AND step = 'owner'`

    for (let tries = 1; tries < JUDGE_MAX_TRIES; tries++) {
      await pass()
      expect(await judgeStep()).toEqual([{ outcome: 'failed', tries }])
      expect(pagesOf(id)).toHaveLength(0)
      expect(await ownerSteps()).toHaveLength(0)
      expect(await needs()).toEqual([])
      // inside the backoff the Judge is not called again
      await pass()
      expect(await askCalls()).toHaveLength(before + tries)
      await world.db.sql`UPDATE factory.decision_steps SET at = at - interval '10 minutes' WHERE decision_id = ${id}`
    }
    await pass()
    expect(await askCalls()).toHaveLength(before + JUDGE_MAX_TRIES)
    expect(await judgeStep()).toEqual([{ outcome: 'failed', tries: JUDGE_MAX_TRIES }])
    expect(pagesOf(id)).toHaveLength(1)
    expect(await ownerSteps()).toHaveLength(1)
    expect(await needs()).toHaveLength(1)
  }, 60_000)
}

test('a long note and many open comments still reach the lead as one line: the pointer, a clipped note, six clipped comments', async () => {
  const issueId = await workingIssue('example-long')
  const submitted = await ok(
    (json) => ArtifactReply.parse(json),
    'artifact',
    'submit',
    issueId,
    ...body({
      attempt: 1,
      kind: 'spec',
      title: 'The long spec',
      content: '# Long\n\n## Build\n\nWe keep the queue in Postgres.\n\n## Decided\n\nPostgres: it is there.',
    }),
  )
  for (let n = 0; n < 8; n++) {
    await ok(
      (json) => ArtifactReply.parse(json),
      'artifact',
      'annotate',
      submitted.artifact.id,
      ...body({ quote: 'keep the queue in Postgres', path: 'Long', comment: `Comment ${n}: ${'x'.repeat(600)}` }),
    )
  }
  await ok(
    (json) => ArtifactReply.parse(json),
    'artifact',
    'verdict',
    submitted.artifact.id,
    ...body({ verdict: 'looks_good', note: `Start: ${'n'.repeat(3900)}` }),
  )
  const noted: { text: string }[] = await world.db.sql`
    SELECT payload->>'text' AS text FROM factory.issue_events WHERE issue_id = ${issueId} AND kind = 'noted' ORDER BY at DESC LIMIT 1`
  const text = noted[0]?.text ?? ''
  expect(text).toContain(`factory artifact show ${submitted.artifact.id}`)
  expect(text).toContain('Apply his 8 open comments')
  expect(text).toContain('Comment 5:')
  expect(text).not.toContain('Comment 6:')
  expect(text.length).toBeLessThan(3900)
})
