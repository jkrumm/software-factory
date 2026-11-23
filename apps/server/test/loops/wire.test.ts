import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { JudgeInputWire } from '@software-factory/contract'
import { agwAmend } from '../../src/adapters/agw/amend.ts'
import { loadLoopSettings } from '../../src/app/loops/settings.ts'
import type { Precedent } from '../../src/domains/checkpoints/decision.ts'
import { judgeInputOf } from '../../src/domains/checkpoints/decision.ts'
import type { OpenIssue } from '../../src/domains/intake/model.ts'
import type { AgwPort } from '../../src/kernel/agw.ts'
import type { IssueId } from '../../src/kernel/ids.ts'
import type { Key } from '../../src/kernel/keys.ts'
import { ok } from '../../src/kernel/result.ts'
import { WORKFLOWS, type WorkflowName } from '../../src/kernel/workflows.ts'

/**
 * One fixture, two repos: `packages/contract/fixtures/loops.json` is parsed here with the factory's schemas, and the copy in
 * agent-workflows (`packages/host/test/fixtures/software-factory-loops.json`) is parsed with the workflows'. The table's
 * entries each name their example below: an entry without one does not compile, and an example its schema refuses fails.
 */
const fixture = JSON.parse(
  await readFile(
    join(import.meta.dir, '..', '..', '..', '..', 'packages', 'contract', 'fixtures', 'loops.json'),
    'utf8',
  ),
)

/** The agw copy of the fixture: where it must match. Read when agent-workflows is checked out beside this repo. */
const AGW_FIXTURE = join(
  process.env.FACTORY_AGW_FIXTURE_ROOT ?? join(homedir(), 'SourceRoot', 'agent-workflows'),
  'packages',
  'host',
  'test',
  'fixtures',
  'software-factory-loops.json',
)

/** The example request and answer of every entry of `WORKFLOWS`, from the fixture. */
const EXAMPLES = {
  judge: { request: fixture.judge.input, answer: fixture.judge.output },
  errandScreen: { request: fixture.errand.input, answer: fixture.errand.output },
  errandNeeded: { request: fixture.errandNeeded.input, answer: fixture.errandNeeded.output },
  steward: { request: fixture.steward.input, answer: fixture.steward.output },
  settle: { request: fixture.triage.settleInput, answer: fixture.triage.settleOutput },
  amend: { request: fixture.triage.amendInput, answer: fixture.triage.amendOutput },
  queue: { request: fixture.queue.input, answer: fixture.queue.output },
  hygiene: { request: fixture.hygiene.input, answer: fixture.hygiene.output },
  screen: { request: fixture.screen.input, answer: fixture.screen.output },
} satisfies Record<WorkflowName, { request: unknown; answer: unknown }>

const names = Object.keys(WORKFLOWS) as WorkflowName[]

test('every entry’s example request and answer parse with its schemas, and parse back unchanged', () => {
  for (const name of names) {
    const { request, answer } = EXAMPLES[name]
    expect({ name, request: WORKFLOWS[name].request.parse(request) }).toEqual({ name, request })
    expect({ name, answer: WORKFLOWS[name].answer.parse(answer) }).toEqual({ name, answer })
  }
  expect(WORKFLOWS.steward.answer.parse(fixture.steward.decisionOutput)).toEqual(fixture.steward.decisionOutput)
})

test.skipIf(!existsSync(AGW_FIXTURE))(
  'the examples agent-workflows holds parse with the factory’s schemas (skipped where it is not checked out)',
  async () => {
    const theirs = JSON.parse(await readFile(AGW_FIXTURE, 'utf8'))
    const sections: [WorkflowName, { input: unknown; output: unknown }][] = [
      ['judge', theirs.judge],
      ['errandScreen', theirs.errand],
      ['steward', theirs.steward],
      ['queue', theirs.queue],
      ['hygiene', theirs.hygiene],
      ['screen', theirs.screen],
      ['settle', { input: theirs.triage?.settleInput, output: theirs.triage?.settleOutput }],
      ['amend', { input: theirs.triage?.amendInput, output: theirs.triage?.amendOutput }],
    ]
    for (const [name, section] of sections) {
      expect({ name, ok: WORKFLOWS[name].request.safeParse(section.input).success }).toEqual({ name, ok: true })
      expect({ name, ok: WORKFLOWS[name].answer.safeParse(section.output).success }).toEqual({ name, ok: true })
    }
  },
)

test('the Judge’s input as the checkpoints build it is the shape the workflow takes', () => {
  const precedent: Precedent = {
    question: 'q',
    answer: 'a',
    settledBy: 'owner',
    repo: '/home/x/src/app',
  }
  const input = judgeInputOf({
    decision: 'decision_7' as never,
    repo: '/home/x/src/example-app',
    issue: 'Add request logging',
    form: {
      class: 'direction',
      whyYours: 'What the server logs is what support reads.',
      question: 'Which logging library?',
      recommendation: 'pino',
      checked: 'looked',
      options: [
        { label: 'pino', leadsTo: 'JSON lines', reversible: true, cost: 'one dependency' },
        { label: 'winston', leadsTo: 'files', reversible: true, cost: 'one dependency' },
      ],
      exhibit: null,
      artifact: null,
      noAnswer: { consequence: 'waits', default: 'pino', waitMinutes: 30 },
    },
    spec: '## Build\n\nRequest logging.',
    precedents: [precedent],
  })
  expect(JudgeInputWire.parse(input)).toEqual(input)
  expect(input).toMatchObject({
    class: 'direction',
    spec: expect.stringContaining('Build'),
  })
  expect(input.repo).toBe('example-app')
})

test('the table sends agw the names it always has, and every key starts with its entry’s prefix', () => {
  expect(Object.fromEntries(names.map((name) => [name, WORKFLOWS[name].agw]))).toEqual({
    judge: 'factory-ask',
    errandScreen: 'factory-errand',
    errandNeeded: 'factory-errand-needed',
    steward: 'factory-steward',
    settle: 'factory-triage',
    amend: 'factory-triage',
    queue: 'factory-queue',
    hygiene: 'factory-hygiene',
    screen: 'factory-screen',
  })
  expect(WORKFLOWS.judge.key('decision_7', 1, 'abc')).toBe('factory-ask:decision_7:1:abc' as Key)
  expect(WORKFLOWS.settle.key('issue_3', 2)).toBe('triage:settle:issue_3:2' as Key)
  expect(WORKFLOWS.queue.key('app', 'shape', 1)).toBe('queue:app:shape:1' as Key)
})

test('the steward, triage and queue gaps are their own entries', () => {
  const own = loadLoopSettings({})
  expect([own.retryMs, own.triageRetryMs, own.queueRetryMs]).toEqual([
    WORKFLOWS.steward.retry.backoffMs,
    WORKFLOWS.settle.retry.backoffMs,
    WORKFLOWS.queue.retry.backoffMs,
  ])
  // Triage and queue share a backoff in the table, so a swap of their two settings would pass the check above.
  // Give each its own gap for this check only, and restore the table after.
  const { settle, queue } = WORKFLOWS
  const [savedSettle, savedQueue] = [settle.retry, queue.retry]
  try {
    settle.retry = { ...savedSettle, backoffMs: 11 * 60_000 }
    queue.retry = { ...savedQueue, backoffMs: 12 * 60_000 }
    const swapped = loadLoopSettings({})
    expect([swapped.retryMs, swapped.triageRetryMs, swapped.queueRetryMs]).toEqual([
      WORKFLOWS.steward.retry.backoffMs,
      11 * 60_000,
      12 * 60_000,
    ])
  } finally {
    settle.retry = savedSettle
    queue.retry = savedQueue
  }
})

/** An agw port that records its calls and answers from a script keyed by workflow name. */
function fakePort(answers: Partial<Record<WorkflowName, unknown>>): {
  port: AgwPort
  calls: { name: WorkflowName; request: unknown; key: Key }[]
} {
  const calls: { name: WorkflowName; request: unknown; key: Key }[] = []
  return {
    calls,
    port: {
      run: async (name, request, key) => {
        calls.push({ name, request, key })
        return ok(WORKFLOWS[name].answer.parse(answers[name])) as never
      },
    },
  }
}

const open = (n: number, title: string): OpenIssue => ({
  id: `issue_${n}` as IssueId,
  title,
  kind: 'bug',
  state: 'working',
})
const signal = {
  source: 'owner:hermes',
  kind: 'request',
  origin: 'you',
  trust: 'owner',
  repo: 'app',
  fingerprint: 'fp-1',
  title: 'Checkout total is still wrong for coupons',
  text: 'token=abcdef123456 also happens with coupons',
  link: null,
  madeBy: null,
  probe: false,
} as const

test('amend: the signal is sent scrubbed with the candidates, and the Issue it names must be one it was shown', async () => {
  const candidates = [open(12, 'Fix the checkout total'), open(15, 'Add a dark theme')]
  const named = fakePort({ amend: { ...fixture.triage.amendOutput, amend: 'issue_12' } })
  expect(await agwAmend(named.port).amendOrNew({ signal, candidates, settled: [] })).toEqual(
    ok({ amend: 'issue_12' as IssueId, settled: null, reason: fixture.triage.amendOutput.reason }),
  )
  expect(named.calls[0]?.request).toMatchObject({
    mode: 'amend',
    repo: 'app',
    signal: { title: signal.title, text: 'token=[redacted] also happens with coupons', source: 'owner:hermes' },
  })
  expect(String(named.calls[0]?.key)).toStartWith('triage:amend:owner%3Ahermes:fp-1:')

  const unseen = fakePort({ amend: { ...fixture.triage.amendOutput, amend: 'issue_99' } })
  expect(await agwAmend(unseen.port).amendOrNew({ signal, candidates, settled: [] })).toMatchObject({
    ok: false,
    error: { kind: 'refused', detail: expect.stringContaining('issue_99') },
  })

  const none = fakePort({ amend: { ...fixture.triage.amendOutput, amend: null } })
  expect(await agwAmend(none.port).amendOrNew({ signal, candidates, settled: [] })).toEqual(
    ok({ amend: null, settled: null, reason: fixture.triage.amendOutput.reason }),
  )

  const edges = fakePort({ amend: { ...fixture.triage.settleOutput } })
  expect(await agwAmend(edges.port).amendOrNew({ signal, candidates, settled: [] })).toMatchObject({ ok: false })
})

test('amend: a settled answer must name an Issue it was shown as settled, and is no amend', async () => {
  const settled = [
    {
      id: 'issue_7' as IssueId,
      title: 'Disk filling fast',
      outcome: 'healed',
      reason: 'token=abcdef123456 false alarm',
      closedAt: new Date(),
    },
  ]
  const candidates = [open(12, 'Fix the checkout total')]
  const named = fakePort({ amend: { ...fixture.triage.amendOutput, amend: null, settled: 'issue_7' } })
  expect(await agwAmend(named.port).amendOrNew({ signal, candidates, settled })).toEqual(
    ok({ amend: null, settled: 'issue_7' as IssueId, reason: fixture.triage.amendOutput.reason }),
  )
  expect(named.calls[0]?.request).toMatchObject({
    settled: [{ id: 'issue_7', title: 'Disk filling fast', outcome: 'healed', reason: 'token=[redacted] false alarm' }],
  })

  const unseen = fakePort({ amend: { ...fixture.triage.amendOutput, amend: null, settled: 'issue_8' } })
  expect(await agwAmend(unseen.port).amendOrNew({ signal, candidates, settled })).toMatchObject({
    ok: false,
    error: { kind: 'refused', detail: expect.stringContaining('issue_8') },
  })

  const both = fakePort({ amend: { ...fixture.triage.amendOutput, amend: 'issue_12', settled: 'issue_7' } })
  expect(await agwAmend(both.port).amendOrNew({ signal, candidates, settled })).toMatchObject({ ok: false })
})
