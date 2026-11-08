import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HygieneAnswer,
  HygieneRequest,
  JudgeInputWire,
  JudgeVerdictWire,
  QueueAnswer,
  QueueRequest,
  StewardAnswer,
  StewardStall,
  TriageAnswer,
  TriageRequest,
} from '@software-factory/contract'
import { agwAmend } from '../../src/adapters/agw/amend.ts'
import { agwHygiene } from '../../src/adapters/agw/hygiene.ts'
import { agwJudge } from '../../src/adapters/agw/judge.ts'
import { agwQueue } from '../../src/adapters/agw/queue.ts'
import { agwSettle, agwSteward } from '../../src/adapters/agw/steward.ts'
import type { Precedent } from '../../src/domains/checkpoints/decision.ts'
import { judgeInputOf } from '../../src/domains/checkpoints/decision.ts'
import type { OpenIssue } from '../../src/domains/intake/model.ts'
import type { AgwCall, AgwPort } from '../../src/kernel/agw.ts'
import type { IssueId } from '../../src/kernel/ids.ts'
import { key } from '../../src/kernel/keys.ts'
import { ok } from '../../src/kernel/result.ts'

/**
 * One fixture, two repos: `packages/contract/fixtures/loops.json` is parsed here with the factory's schemas, and the same
 * bytes are parsed in agent-workflows (`packages/host/test/fixtures/software-factory-loops.json`) with the workflows'. A
 * shape that drifts on one side fails a test there or here.
 */
const fixture = JSON.parse(
  await readFile(
    join(import.meta.dir, '..', '..', '..', '..', 'packages', 'contract', 'fixtures', 'loops.json'),
    'utf8',
  ),
)

test('the fixture’s examples parse with the factory’s schemas', () => {
  expect(JudgeInputWire.parse(fixture.judge.input)).toEqual(fixture.judge.input)
  expect(JudgeVerdictWire.parse(fixture.judge.output)).toEqual(fixture.judge.output)
  expect(StewardStall.parse(fixture.steward.input)).toEqual(fixture.steward.input)
  expect(StewardAnswer.parse(fixture.steward.output)).toEqual(fixture.steward.output)
  expect(StewardAnswer.parse(fixture.steward.decisionOutput)).toEqual(fixture.steward.decisionOutput)
  expect(TriageRequest.parse(fixture.triage.amendInput)).toEqual(fixture.triage.amendInput)
  expect(TriageRequest.parse(fixture.triage.settleInput)).toEqual(fixture.triage.settleInput)
  expect(TriageAnswer.parse(fixture.triage.amendOutput)).toEqual(fixture.triage.amendOutput)
  expect(TriageAnswer.parse(fixture.triage.settleOutput)).toEqual(fixture.triage.settleOutput)
  expect(QueueRequest.parse(fixture.queue.input)).toEqual(fixture.queue.input)
  expect(QueueAnswer.parse(fixture.queue.output)).toEqual(fixture.queue.output)
  expect(HygieneRequest.parse(fixture.hygiene.input)).toEqual(fixture.hygiene.input)
  expect(HygieneAnswer.parse(fixture.hygiene.output)).toEqual(fixture.hygiene.output)
})

test('the Judge’s input as the checkpoints build it is the shape the workflow takes', () => {
  const precedent: Precedent = {
    question: 'q',
    answer: 'a',
    settledBy: 'owner',
    worthAsking: false,
    repo: '/home/x/src/app',
  }
  const input = judgeInputOf({
    decision: 'decision_7' as never,
    repo: '/home/x/src/example-app',
    issue: 'Add request logging',
    form: {
      question: 'Which logging library?',
      recommendation: 'pino',
      checked: 'looked',
      options: [
        { label: 'pino', reversible: true, cost: 'one dependency' },
        { label: 'winston', reversible: true, cost: 'one dependency' },
      ],
      noAnswer: { consequence: 'waits', default: 'pino', waitMinutes: 30 },
    },
    precedents: [precedent],
  })
  expect(JudgeInputWire.parse(input)).toEqual(input)
  expect(input.repo).toBe('example-app')
})

/** An agw port that records its calls and answers from a script. */
function fakePort(answers: Record<string, unknown>): { port: AgwPort; calls: AgwCall<unknown>[] } {
  const calls: AgwCall<unknown>[] = []
  return {
    calls,
    port: {
      run: async <T>(call: AgwCall<T>) => {
        calls.push(call)
        return ok(call.output.parse(answers[call.workflow]))
      },
    },
  }
}

test('each adapter sends its workflow the input as given, under the key it was handed', async () => {
  const { port, calls } = fakePort({
    'factory-ask': fixture.judge.output,
    'factory-steward': fixture.steward.output,
    'factory-triage': fixture.triage.settleOutput,
    'factory-queue': fixture.queue.output,
    'factory-hygiene': fixture.hygiene.output,
  })
  const k = key('test', 1)
  expect(await agwJudge(port).judge(fixture.judge.input, k)).toEqual(ok(fixture.judge.output))
  expect(await agwSteward(port).ask(fixture.steward.input, k)).toEqual(ok(fixture.steward.output))
  expect(await agwSettle(port).settle(fixture.triage.settleInput, k)).toEqual(ok(fixture.triage.settleOutput))
  expect(await agwQueue(port).ask(fixture.queue.input, k)).toEqual(ok(fixture.queue.output))
  expect(await agwHygiene(port).ask(fixture.hygiene.input, k)).toEqual(ok(fixture.hygiene.output))
  expect(calls.map((c) => [c.workflow, c.key])).toEqual([
    ['factory-ask', k],
    ['factory-steward', k],
    ['factory-triage', k],
    ['factory-queue', k],
    ['factory-hygiene', k],
  ])
  expect(calls[1]?.input).toEqual(fixture.steward.input)
  expect(calls[3]?.input).toEqual(fixture.queue.input)
  expect(calls[4]?.input).toEqual(fixture.hygiene.input)
})

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
  const named = fakePort({ 'factory-triage': { ...fixture.triage.amendOutput, amend: 'issue_12' } })
  expect(await agwAmend(named.port).amendOrNew({ signal, candidates })).toEqual(ok({ amend: 'issue_12' as IssueId }))
  expect(named.calls[0]?.input).toMatchObject({
    mode: 'amend',
    repo: 'app',
    signal: { title: signal.title, text: 'token=[redacted] also happens with coupons', source: 'owner:hermes' },
  })
  expect(String(named.calls[0]?.key)).toStartWith('triage:amend:owner%3Ahermes:fp-1:')

  const unseen = fakePort({ 'factory-triage': { ...fixture.triage.amendOutput, amend: 'issue_99' } })
  expect(await agwAmend(unseen.port).amendOrNew({ signal, candidates })).toMatchObject({
    ok: false,
    error: { kind: 'refused', detail: expect.stringContaining('issue_99') },
  })

  const none = fakePort({ 'factory-triage': { ...fixture.triage.amendOutput, amend: null } })
  expect(await agwAmend(none.port).amendOrNew({ signal, candidates })).toEqual(ok({ amend: null }))

  const edges = fakePort({ 'factory-triage': { ...fixture.triage.settleOutput } })
  expect(await agwAmend(edges.port).amendOrNew({ signal, candidates })).toMatchObject({ ok: false })
})
