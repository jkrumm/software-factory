/* oxlint-disable typescript/await-thenable -- bun types the `rejects` matchers as void; they return a promise */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Issue } from '@software-factory/contract'
import { CannotExecute, EXIT_TIMEOUT, type ProcessResult } from '../src/exec.ts'
import { issueAttention } from '../src/issues/attention.ts'
import { createIssue } from '../src/issues/create.ts'
import { enqueue } from '../src/issues/inbox.ts'
import {
  AgwAskJudge,
  AskJudgeFailed,
  AskJudgement,
  type AskInput,
  type AskJudge,
  guard,
  isDoNothing,
  VISIBLE_SOURCE,
} from '../src/issues/judge.ts'
import { factsOf, scrub } from '../src/issues/judge-input.ts'
import { noteText } from '../src/issues/lead.ts'
import { markEvent } from '../src/issues/shared.ts'
import { issuePass } from '../src/issues/worker.ts'
import { listNotifications } from '../src/notify/outbox.ts'
import { TEST_REPO, TEST_ROOT } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

let db: TestDb
let clock: FakeClock
let n = 0

beforeAll(async () => {
  db = await startTestDb()
})
afterAll(() => db.stop())
beforeEach(async () => {
  await db.reset()
  clock = new FakeClock(new Date('2026-11-02T10:00:00.000Z'))
  n = 0
})

const now = () => clock.now()

type Verdict = { verdict: 'answer' | 'owner'; answer: string; reason: string; source: string }

/** The port's fake: answers `verdict` (or what it returns) once `gate` opens, or fails with `failure`. */
class FakeJudge implements AskJudge {
  calls: { input: AskInput; key: string }[] = []
  verdict: Verdict | ((input: AskInput) => Verdict) = { verdict: 'owner', answer: '', reason: 'a test', source: '' }
  failure?: Error
  gate?: Promise<void>

  async judge(input: AskInput, key: string): Promise<unknown> {
    this.calls.push({ input, key })
    await this.gate
    if (this.failure) throw this.failure
    return typeof this.verdict === 'function' ? this.verdict(input) : this.verdict
  }
}

const answer = (text: string, source = 'plan: docs/decisions.md'): Verdict => ({
  verdict: 'answer',
  answer: text,
  reason: 'the plan settles it',
  source,
})

function judgement(judge: AskJudge | undefined, visible = false) {
  return new AskJudgement({
    sql: db.sql,
    now,
    judge,
    visible: async () => () => visible,
    plan: async () => '## AGENTS.md\nplan text',
  })
}

async function file(): Promise<Issue> {
  const made = await createIssue(
    db.sql,
    { source: 'request', sourceKey: `k${++n}`, repo: TEST_REPO, title: 'a title', facts: { a: 1 } },
    { repoRoots: [TEST_ROOT], now: clock.now() },
  )
  return made.issue
}

async function step(issueId: number, kind: string, payload?: Record<string, unknown>, judge?: AskJudgement) {
  await enqueue(db.sql, { issueId, key: `${issueId}:${kind}:${++n}`, kind, at: clock.now(), payload })
  // The ports are empty: a `note_lead` effect has no port in these tests, only the inbox is under test.
  await issuePass(db.sql, { now, ports: {}, judgement: judge ?? judgement(undefined) })
}

/** An Issue that asked a question; the pass that made it did not judge it (the judge is gated by the caller). */
async function asked(payload: Record<string, unknown> = { question: 'Which port?', options: ['80', '8080'] }) {
  const { id } = await file()
  await enqueue(db.sql, { issueId: id, key: `${id}:admitted:${++n}`, kind: 'admitted', at: clock.now() })
  await issuePass(db.sql, { now, ports: {}, judgement: neverRuns })
  await enqueue(db.sql, { issueId: id, key: `${id}:ask:${++n}`, kind: 'ask', at: clock.now(), payload })
  await issuePass(db.sql, { now, ports: {}, judgement: neverRuns })
  return id
}

/** A judgement that does nothing: the ask made in the pass stays unjudged. */
const neverRuns = { start: async () => undefined } as unknown as AskJudgement

const notifications = async () => (await listNotifications(db.sql)).map((r) => r.key).sort()
const inbox = (id: number) =>
  db.sql`SELECT key, kind, payload FROM factory.issue_inbox WHERE issue_id = ${id} AND (key LIKE 'judge:%' OR key LIKE 'steward-judge:%') ORDER BY id`
const marker = async (key: string) =>
  (await db.sql`SELECT payload FROM factory.issue_events WHERE key = ${key}`)[0]?.payload
const decision = async (id: number) =>
  (await db.sql`SELECT id, answer, answered_by, answered_at FROM factory.decisions WHERE issue_id = ${id}`)[0]
const attention = async () => (await issueAttention(db.sql, clock.now(), { alertLeads: true })).asks

describe('a verdict answer', () => {
  test('is filed as an answer from the steward, shown in the story, and the owner is not told', async () => {
    const id = await asked()
    const fake = new FakeJudge()
    fake.verdict = answer('8080')
    const pass = judgement(fake)
    await pass.start()
    await pass.settled()
    expect(fake.calls[0]?.key).toMatch(/^factory-ask-\d+$/)
    expect(fake.calls[0]?.input).toMatchObject({
      question: 'Which port?',
      options: ['80', '8080'],
      repo: 'repo',
      plan: '## AGENTS.md\nplan text',
    })
    expect((await inbox(id))[0]).toMatchObject({
      kind: 'answer',
      payload: { answer: '8080', who: 'steward', source: 'plan: docs/decisions.md' },
    })
    expect(await marker('ask_judged:1')).toMatchObject({ outcome: 'answered', source: 'plan: docs/decisions.md' })

    await issuePass(db.sql, { now, ports: {}, judgement: neverRuns })
    expect(await decision(id)).toMatchObject({ answer: '8080', answered_by: 'steward' })
    expect(await notifications()).toEqual([])
    expect(await attention()).toEqual([])
    const [effect] =
      await db.sql`SELECT payload FROM factory.issue_effects WHERE issue_id = ${id} AND kind = 'note_lead'`
    const text = noteText(id, effect.payload)
    expect(text).toContain('answered by the steward')
    expect(text).toContain('plan: docs/decisions.md')
    expect(text).toContain('overrule')
  })

  test('replayed passes file one answer and tell nobody', async () => {
    const id = await asked()
    const fake = new FakeJudge()
    fake.verdict = answer('80')
    const pass = judgement(fake)
    for (let i = 0; i < 3; i++) {
      await pass.start()
      await pass.settled()
    }
    expect(fake.calls).toHaveLength(1)
    expect(await inbox(id)).toHaveLength(1)
    expect(await notifications()).toEqual([])
  })

  test('an owner answer that came first wins: the steward’s is refused as answered already', async () => {
    const id = await asked()
    const fake = new FakeJudge()
    fake.verdict = answer('80')
    let open!: () => void
    fake.gate = new Promise<void>((resolve) => (open = resolve))
    const pass = judgement(fake)
    await pass.start()
    await step(id, 'answer', { answer: '8080', who: 'owner', decision: 1 })
    open()
    await pass.settled()
    await issuePass(db.sql, { now, ports: {}, judgement: neverRuns })
    expect(await decision(id)).toMatchObject({ answer: '8080', answered_by: 'owner' })
    const [refused] = await db.sql`SELECT error FROM factory.issue_inbox WHERE key = ${`judge:1`}`
    expect(refused).toBeDefined()
  })
})

describe('a verdict owner or a failure', () => {
  test('the owner is told once, the ask is on his list, and the marker says why', async () => {
    const id = await asked()
    const fake = new FakeJudge()
    fake.verdict = { verdict: 'owner', answer: '', reason: 'a product call', source: '' }
    const pass = judgement(fake)
    await pass.start()
    await pass.settled()
    await pass.start()
    await pass.settled()
    expect(await notifications()).toEqual(['notify:ask:1'])
    expect(await marker('ask_judged:1')).toMatchObject({ outcome: 'owner', reason: 'a product call' })
    expect(await attention()).toEqual([`Issue ${id} asks: Which port?`])
    expect(await inbox(id)).toEqual([])
  })

  for (const [name, setup] of [
    ['a non-zero exit', (f: FakeJudge) => (f.failure = new AskJudgeFailed('agw exited 1'))],
    ['a verdict that does not parse', (f: FakeJudge) => (f.verdict = { verdict: 'maybe' } as unknown as Verdict)],
    ['a missing binary', (f: FakeJudge) => (f.failure = new CannotExecute('agw', 'ENOENT'))],
  ] as const) {
    test(`${name} leaves the ask standing`, async () => {
      const id = await asked()
      const fake = new FakeJudge()
      setup(fake)
      const pass = judgement(fake)
      await pass.start()
      await pass.settled()
      expect(await notifications()).toEqual(['notify:ask:1'])
      expect(await marker('ask_judged:1')).toMatchObject({ outcome: 'failed' })
      expect(await attention()).toHaveLength(1)
      expect(await inbox(id)).toEqual([])
    })
  }

  test('with no judge wired the ask stands, in the same pass', async () => {
    const id = await asked()
    await issuePass(db.sql, { now, ports: {} })
    expect(await notifications()).toEqual(['notify:ask:1'])
    expect(await attention()).toEqual([`Issue ${id} asks: Which port?`])
  })
})

describe('FACTORY_ASK_JUDGE=off', () => {
  test('sends every ask to the owner, a visible repo’s do-nothing default included', async () => {
    const id = await asked({ question: 'Close it?', default: 'Leave it open' })
    const pass = judgement(undefined, true)
    await pass.start()
    expect(await inbox(id)).toEqual([])
    expect(await marker('ask_judged:1')).toMatchObject({ outcome: 'failed' })
    expect(await notifications()).toEqual(['notify:ask:1'])
  })
})

describe('a business Issue', () => {
  for (const visible of [true, false]) {
    test(`its do-nothing default is not taken and nothing is judged (visible repo: ${visible})`, async () => {
      const id = await asked({ question: 'Close it?', default: 'Leave it open' })
      await db.sql`UPDATE factory.issues SET class = 'business' WHERE id = ${id}`
      const fake = new FakeJudge()
      fake.verdict = answer('Leave it open')
      const pass = judgement(fake, visible)
      await pass.start()
      await pass.settled()
      expect(fake.calls).toEqual([])
      expect(await inbox(id)).toEqual([])
      expect(await marker('ask_judged:1')).toMatchObject({
        outcome: 'owner',
        reason: "a business Issue's question is the owner's",
      })
      expect(await notifications()).toEqual(['notify:ask:1'])
    })
  }
})

describe('the hidden window', () => {
  test('an ask is off the owner’s list until it is judged, and shows anyway after 45 minutes', async () => {
    await asked()
    const fake = new FakeJudge()
    let open!: () => void
    fake.gate = new Promise<void>((resolve) => (open = resolve))
    const pass = judgement(fake)
    await pass.start()
    expect(await attention()).toEqual([])
    clock.advance(44 * 60_000)
    expect(await attention()).toEqual([])
    clock.advance(2 * 60_000)
    expect(await attention()).toHaveLength(1)
    open()
    await pass.settled()
  })
})

describe('the guards', () => {
  const verdict = (text: string, source = 'plan: x'): Verdict => answer(text, source)

  test('with options the answer is exactly one of them', async () => {
    expect(guard({ options: ['a', 'b'], default: null }, verdict(' b '))).toEqual({
      ok: true,
      answer: 'b',
      source: 'plan: x',
    })
    expect(guard({ options: ['a', 'b'], default: null }, verdict('c'))).toMatchObject({ ok: false })
    expect(guard({ options: ['a', 'b'], default: null }, verdict('a and b'))).toMatchObject({ ok: false })
    expect(guard({ options: [], default: null }, verdict('free text'))).toMatchObject({ ok: true })
  })

  test('an empty answer or source goes to the owner', () => {
    expect(guard({ options: [], default: null }, verdict('', 'plan: x'))).toMatchObject({ ok: false })
    expect(guard({ options: [], default: null }, verdict('yes', '  '))).toMatchObject({ ok: false })
  })

  test('a default is taken only when it leaves things open', () => {
    const fact = 'Record and internal group created'
    expect(guard({ options: [], default: fact }, verdict(fact, 'default'))).toMatchObject({ ok: false })
    // an answer that merely repeats a declared fact stands only with a plan document behind it, not the lead's own facts
    expect(guard({ options: [], default: fact }, verdict(fact.toUpperCase(), 'facts: x'))).toMatchObject({ ok: false })
    expect(guard({ options: [], default: fact }, verdict(fact.toUpperCase(), 'plan: AGENTS.md "x"'))).toMatchObject({
      ok: true,
    })
    expect(guard({ options: ['Yes', 'No'], default: 'No' }, verdict('No', 'plan: AGENTS.md "never"'))).toMatchObject({
      ok: true,
    })
    expect(guard({ options: [], default: null }, verdict('x', 'default'))).toMatchObject({ ok: false })
    expect(guard({ options: [], default: 'Do nothing' }, verdict('do nothing', 'default'))).toMatchObject({ ok: true })
    expect(guard({ options: ['wait', 'ship'], default: 'wait' }, verdict('wait', 'default: the lead’s'))).toMatchObject(
      { ok: true },
    )
  })

  test('isDoNothing: leave-it-open choices pass, statements of fact do not', () => {
    for (const yes of [
      'Do nothing',
      'do nothing for now',
      'nothing',
      'None',
      'Leave it open',
      'keep as is',
      'Keep it open',
      'no change',
      'Skip',
      'defer',
      'wait for the owner',
      'hold',
      'not now',
      '"Leave it"',
    ])
      expect(isDoNothing(yes)).toBe(true)
    for (const no of [
      'Record and internal group created',
      'Nothing was deployed',
      'Holding company created',
      'None of the hosts are down',
      'ship it',
      'Keep the cache at 5 minutes',
      'waiting room is configured',
      '',
      null,
    ])
      expect(isDoNothing(no)).toBe(false)
  })

  test('an answer the guard rejects stands as an ask for the owner', async () => {
    const id = await asked()
    const fake = new FakeJudge()
    fake.verdict = answer('9090')
    const pass = judgement(fake)
    await pass.start()
    await pass.settled()
    expect(await marker('ask_judged:1')).toMatchObject({ outcome: 'rejected', verdict: 'answer' })
    expect(await notifications()).toEqual(['notify:ask:1'])
    expect(await inbox(id)).toEqual([])
  })
})

describe('a visible repo', () => {
  test('sends nothing to the judge; an ask with no default stays with the owner', async () => {
    await asked()
    const fake = new FakeJudge()
    fake.verdict = answer('80')
    const pass = judgement(fake, true)
    await pass.start()
    await pass.settled()
    expect(fake.calls).toEqual([])
    expect(await marker('ask_judged:1')).toMatchObject({ outcome: 'visible' })
    expect(await notifications()).toEqual(['notify:ask:1'])
  })

  test('a declared do-nothing default is taken, a statement of fact is not', async () => {
    const quiet = await asked({ question: 'Close it?', default: 'Leave it open' })
    const fact = await asked({ question: 'State?', default: 'Record and internal group created' })
    const fake = new FakeJudge()
    const pass = judgement(fake, true)
    await pass.start()
    await pass.settled()
    expect(fake.calls).toEqual([])
    expect((await inbox(quiet))[0]).toMatchObject({
      kind: 'answer',
      payload: { answer: 'Leave it open', who: 'steward', source: VISIBLE_SOURCE },
    })
    expect(await inbox(fact)).toEqual([])
    expect(await notifications()).toEqual(['notify:ask:2'])
  })
})

describe('a spent escalation', () => {
  async function spent(state: 'working' | 'waiting' = 'working') {
    const { id } = await file()
    await step(id, 'admitted')
    if (state === 'waiting') await step(id, 'block', { reason: 'stuck' })
    await markEvent(db.sql, id, `steward_exhausted:${id}:blocked`, 'steward_exhausted', clock.now(), {
      cause: 'blocked',
      tried: ['1. wake', '2. wake'],
    })
    return id
  }

  test('an answer is a note from the steward and no line for the owner', async () => {
    const id = await spent('waiting')
    const fake = new FakeJudge()
    fake.verdict = answer('re-run make verify once, then ship', 'facts: the red check was a flake')
    const pass = judgement(fake)
    await pass.start()
    await pass.settled()
    expect(fake.calls[0]?.key).toBe(`factory-ask-esc-${id}-blocked`)
    expect(fake.calls[0]?.input).toMatchObject({ options: [], default: null })
    expect(fake.calls[0]?.input.question).toContain('spent its retries')
    expect(await inbox(id)).toHaveLength(1)
    expect((await inbox(id))[0]).toMatchObject({
      key: `steward-judge:${id}:blocked`,
      kind: 'note',
      payload: { who: 'steward', wake: true },
    })
    expect(await notifications()).toEqual([])
    expect(await marker(`steward_judged:${id}:blocked`)).toMatchObject({ outcome: 'answered' })
    await pass.start()
    expect(fake.calls).toHaveLength(1)
  })

  test('an answer from a default, a verdict owner, a failure and a visible repo each record the owner’s line once', async () => {
    const id = await spent()
    for (const [setup, visible] of [
      [(f: FakeJudge) => (f.verdict = answer('x', 'default')), false],
      [(f: FakeJudge) => (f.verdict = { verdict: 'owner', answer: '', reason: 'no', source: '' }), false],
      [(f: FakeJudge) => (f.failure = new Error('down')), false],
      [() => undefined, true],
    ] as const) {
      await db.sql`DELETE FROM factory.notifications`
      await db.sql`DELETE FROM factory.issue_events WHERE kind = 'steward_judged'`
      const fake = new FakeJudge()
      setup(fake)
      const pass = judgement(fake, visible)
      await pass.start()
      await pass.settled()
      await pass.start()
      await pass.settled()
      expect(await notifications()).toEqual([`notify:steward:${id}:blocked`])
      expect(await inbox(id)).toEqual([])
      if (visible) expect(fake.calls).toEqual([])
    }
  })

  test('the steward only files the event; its line waits for the judge pass', async () => {
    const id = await spent()
    expect(await notifications()).toEqual([])
    await issuePass(db.sql, { now, ports: {} })
    expect(await notifications()).toEqual([`notify:steward:${id}:blocked`])
  })
})

describe('the adapter', () => {
  const input: AskInput = { question: 'q', options: ['a', ''], default: null, facts: 'f', plan: 'p', repo: 'r' }
  const output = { verdict: 'answer', answer: 'a', reason: 'r', source: 'plan: x' }

  function scripted(results: (ProcessResult | Error)[]) {
    const calls: { cmd: string[]; stdin?: string }[] = []
    const run = async (cmd: string[], _timeout: number, _env?: unknown, stdin?: string): Promise<ProcessResult> => {
      calls.push({ cmd, stdin })
      const next = results.shift()
      if (!next) throw new Error('no result left')
      if (next instanceof Error) throw next
      return next
    }
    return { calls, run }
  }

  test('runs factory-ask with the ask object itself on stdin, keyed by the ask', async () => {
    const { calls, run } = scripted([{ exitCode: 0, stdout: JSON.stringify({ status: 'done', output }) }])
    expect(await new AgwAskJudge({ bin: 'agw', run }).judge(input, 'factory-ask-7')).toEqual(output)
    expect(calls[0]?.cmd).toEqual(['agw', 'factory-ask', '--format', 'json', '--idempotency-key', 'factory-ask-7'])
    expect(JSON.parse(calls[0]?.stdin ?? '')).toEqual({
      question: 'q',
      options: ['a'],
      default: null,
      facts: 'f',
      plan: 'p',
      repo: 'r',
    })
  })

  test('a question and options past the workflow’s limits are cut', async () => {
    const { calls, run } = scripted([{ exitCode: 0, stdout: JSON.stringify({ status: 'done', output }) }])
    await new AgwAskJudge({ bin: 'agw', run }).judge(
      { ...input, question: 'x'.repeat(3000), options: Array.from({ length: 12 }, () => 'y'.repeat(2000)) },
      'k',
    )
    const sent = JSON.parse(calls[0]?.stdin ?? '')
    expect(sent.question).toHaveLength(2000)
    expect(sent.options).toHaveLength(10)
    expect(sent.options[0]).toHaveLength(1000)
  })

  test('exit 10 waits for the run; every other failure throws', async () => {
    const { calls, run } = scripted([
      { exitCode: 10, stdout: JSON.stringify({ runId: '01a1980b-d977' }) },
      { exitCode: 0, stdout: JSON.stringify({ status: 'done', output }) },
    ])
    expect(await new AgwAskJudge({ bin: 'agw', run }).judge(input, 'k')).toEqual(output)
    expect(calls.map((c) => c.cmd.slice(1, 4))).toEqual([
      ['factory-ask', '--format', 'json'],
      ['run', 'wait', '01a1980b-d977'],
    ])
    const fail = (results: (ProcessResult | Error)[]) =>
      new AgwAskJudge({ bin: 'agw', run: scripted(results).run }).judge(input, 'k')
    await expect(fail([{ exitCode: 1, stdout: '' }])).rejects.toBeInstanceOf(AskJudgeFailed)
    await expect(fail([{ exitCode: EXIT_TIMEOUT, stdout: '' }])).rejects.toThrow('did not answer in time')
    await expect(fail([{ exitCode: 0, stdout: 'nope' }])).rejects.toThrow('no JSON')
    await expect(fail([{ exitCode: 0, stdout: '{"status":"failed"}' }])).rejects.toThrow('failed')
    await expect(fail([new CannotExecute('agw', 'ENOENT')])).rejects.toThrow('cannot execute agw')
  })
})

describe('the facts that leave', () => {
  test('credential-looking strings are scrubbed and the text is cut to the workflow’s limit', () => {
    const dirty = [
      'sent Bearer abcdef123456789 to the host',
      'api_key=sk-live-abcdefghijklmnop',
      'token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789"',
      'postgres://user:hunter2@db/x',
      'x'.repeat(60),
    ].join('\n')
    const clean = scrub(dirty)
    for (const secret of ['abcdef123456789', 'sk-live', 'ghp_', 'hunter2', 'x'.repeat(60)])
      expect(clean).not.toContain(secret)
    expect(clean).toContain('Bearer [redacted]')
    expect(factsOf({ title: 't', facts: { blob: 'y y '.repeat(20_000) } })).toHaveLength(20_000)
    expect(factsOf({ title: 'T', facts: { a: 1 } })).toBe('title: T\nfacts: {"a":1}')
  })
})
