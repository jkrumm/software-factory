/* oxlint-disable typescript/await-thenable -- bun types the `rejects` matchers as void; they return a promise */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { parseRoleTable } from '@software-factory/contract'
import { CannotExecute, EXIT_TIMEOUT, type ProcessResult } from '../src/exec.ts'
import { AgwClassifier, Classification, clampLead, ClassifyFailed, classifyIssue } from '../src/issues/classify.ts'
import { createIssue } from '../src/issues/intake.ts'
import { TEST_REPO, TEST_ROLES, TEST_ROOT } from './support/app.ts'
import { FakeClassifier } from './support/classifier.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

let db: TestDb
let n = 0
const now = () => new Date('2026-11-02T10:00:00Z')

beforeAll(async () => {
  db = await startTestDb()
})
afterAll(() => db.stop())
beforeEach(async () => {
  await db.reset()
  n = 0
})

const file = async (source = 'request') =>
  (
    await createIssue(
      db.sql,
      { source, sourceKey: `k${++n}`, repo: TEST_REPO, title: 'the title', facts: { a: 1 } },
      { repoRoots: [TEST_ROOT], now: now() },
    )
  ).issue

/** The classify runs on its own: wait until it has got as far as the test needs. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(10)
}

const stored = async (id: number) => {
  const [row] = await db.sql`
    SELECT state, kind, class, size, lead_tier, lead_effort, classify, classified_at FROM factory.issues WHERE id = ${id}`
  return row
}
const events = async (id: number) =>
  db.sql`SELECT kind, payload FROM factory.issue_events WHERE issue_id = ${id} AND key LIKE 'classif%'`

describe('classify', () => {
  test('an answer is stored on the Issue and recorded in its events; the Issue stays queued', async () => {
    const issue = await file()
    const classifier = new FakeClassifier()
    classifier.answer = {
      project: 'repo',
      kind: 'feature',
      class: 'risky',
      size: 'm',
      tier: 'sonnet',
      effort: 'medium',
    }
    const outcome = await classifyIssue(
      { sql: db.sql, classifier, roles: TEST_ROLES, now },
      { ...issue, source: 'request' },
    )
    expect(outcome).toBe('answered')
    expect(await stored(issue.id)).toMatchObject({
      state: 'queued',
      kind: 'feature',
      class: 'risky',
      size: 'm',
      lead_tier: 'sonnet',
      lead_effort: 'medium',
    })
    expect((await stored(issue.id)).classified_at).toBeInstanceOf(Date)
    expect(await events(issue.id)).toEqual([
      {
        kind: 'classified',
        payload: { kind: 'feature', class: 'risky', size: 'm', tier: 'sonnet', effort: 'medium', clamped: false },
      },
    ])
    // The classifier was given the Issue's words and the known projects, the facts as a value.
    expect(classifier.calls[0]).toMatchObject({
      id: issue.id,
      title: 'the title',
      facts: { a: 1 },
      repo: TEST_REPO,
      source: 'request',
    })
  })

  test('tier and effort above the lead role are cut to it, and never above opus/high', async () => {
    const issue = await file()
    const classifier = new FakeClassifier()
    classifier.answer = { project: null, kind: 'bug', class: 'routine', size: 'l', tier: 'opus', effort: 'max' }
    await classifyIssue({ sql: db.sql, classifier, roles: TEST_ROLES, now }, issue)
    expect(await stored(issue.id)).toMatchObject({ lead_tier: 'opus', lead_effort: 'high' })
    expect((await events(issue.id))[0]?.payload).toMatchObject({ tier: 'opus', effort: 'high', clamped: true })
    expect((await stored(issue.id)).classify).toMatchObject({ asked: { tier: 'opus', effort: 'max' } })

    // A role table that sets the lead lower is the ceiling, and one that sets it higher is cut to opus/high.
    const lower = parseRoleTable(JSON.stringify({ roles: { lead: { tier: 'sonnet', effort: 'medium' } } }))
    const higher = parseRoleTable(JSON.stringify({ roles: { lead: { tier: 'opus', effort: 'max' } } }))
    const ask = { tier: 'opus', effort: 'high' } as const
    expect(clampLead(ask, { tier: 'sonnet', effort: 'medium' })).toEqual({
      tier: 'sonnet',
      effort: 'medium',
      clamped: true,
    })
    const second = await file()
    await classifyIssue({ sql: db.sql, classifier, roles: lower, now }, second)
    expect(await stored(second.id)).toMatchObject({ lead_tier: 'sonnet', lead_effort: 'medium' })
    const third = await file()
    await classifyIssue({ sql: db.sql, classifier, roles: higher, now }, third)
    expect(await stored(third.id)).toMatchObject({ lead_tier: 'opus', lead_effort: 'high' })
  })

  test('a classifier that fails leaves defaults, a line in the events, and an Issue that can be admitted', async () => {
    const issue = await file()
    const classifier = new FakeClassifier()
    classifier.failure = new Error('agw is down')
    expect(await classifyIssue({ sql: db.sql, classifier, roles: TEST_ROLES, now }, issue)).toBe('defaulted')
    expect(await stored(issue.id)).toMatchObject({
      state: 'queued',
      kind: null,
      class: null,
      lead_tier: 'opus',
      lead_effort: 'high',
      classify: { failure: 'agw is down' },
    })
    expect((await stored(issue.id)).classified_at).toBeInstanceOf(Date)
    expect(await events(issue.id)).toEqual([
      { kind: 'classify_failed', payload: { detail: 'agw is down', tier: 'opus', effort: 'high' } },
    ])
  })

  test('an answer that does not parse is a failure too', async () => {
    const issue = await file()
    const classifier = new FakeClassifier()
    classifier.answer = { kind: 'wishful', tier: 'gpt-9' }
    expect(await classifyIssue({ sql: db.sql, classifier, roles: TEST_ROLES, now }, issue)).toBe('defaulted')
    expect((await events(issue.id))[0]?.kind).toBe('classify_failed')
  })

  test('only the first outcome counts', async () => {
    const issue = await file()
    const classifier = new FakeClassifier()
    await classifyIssue({ sql: db.sql, classifier, roles: TEST_ROLES, now }, issue)
    classifier.failure = new Error('late')
    await classifyIssue({ sql: db.sql, classifier, roles: TEST_ROLES, now }, issue)
    expect(await events(issue.id)).toHaveLength(1)
    expect((await stored(issue.id)).classify).not.toHaveProperty('failure')
  })

  test('the pump starts what is queued and unclassified, off the caller, and never twice at once', async () => {
    const [a, b, c] = [await file(), await file(), await file()] as const
    const classifier = new FakeClassifier()
    let open!: () => void
    classifier.gate = new Promise<void>((resolve) => (open = resolve))
    const pump = new Classification({ sql: db.sql, classifier, roles: TEST_ROLES, now, concurrency: 2 })
    await pump.start()
    await pump.start()
    await until(() => classifier.calls.length >= 2)
    // Two at a time, and the same two are not started again while they run.
    expect(classifier.calls.map((call) => call.id).sort()).toEqual([a.id, b.id])
    open()
    await pump.settled()
    expect((await stored(a.id)).classified_at).not.toBeNull()
    expect((await stored(c.id)).classified_at).toBeNull()
    await pump.start()
    await until(() => classifier.calls.length >= 3)
    await pump.settled()
    expect(classifier.calls.map((call) => call.id).sort()).toEqual([a.id, b.id, c.id])
    await pump.start()
    expect(classifier.calls).toHaveLength(3)
  })
})

describe('AgwClassifier', () => {
  const input = { id: 1, title: 't', facts: { x: 1 }, repo: '/r', source: 'request', projects: ['r'] }
  const answer = { project: 'r', kind: 'bug', class: 'routine', size: 's', tier: 'haiku', effort: 'low' }

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

  test('runs factory-classify with the Issue on stdin and reads the run’s output', async () => {
    const { calls, run } = scripted([{ exitCode: 0, stdout: JSON.stringify({ status: 'done', output: answer }) }])
    expect(await new AgwClassifier({ bin: 'agw', run }).classify(input)).toEqual(answer)
    expect(calls[0]?.cmd).toEqual([
      'agw',
      'factory-classify',
      '--format',
      'json',
      '--idempotency-key',
      'factory-classify-1',
    ])
    // Facts go as a string, the repo as its directory's name.
    expect(JSON.parse(calls[0]?.stdin ?? '')).toEqual({
      title: 't',
      facts: '{"x":1}',
      repo: 'r',
      source: 'request',
      projects: ['r'],
    })
  })

  test('a title and facts past the workflow’s limits are cut, not refused', async () => {
    const { calls, run } = scripted([{ exitCode: 0, stdout: JSON.stringify({ status: 'done', output: answer }) }])
    await new AgwClassifier({ bin: 'agw', run }).classify({
      ...input,
      title: 'x'.repeat(500),
      facts: { blob: 'y'.repeat(30_000) },
    })
    const sent = JSON.parse(calls[0]?.stdin ?? '')
    expect(sent.title).toHaveLength(300)
    expect(typeof sent.facts).toBe('string')
    expect(sent.facts).toHaveLength(20_000)
  })

  test('exit 10 means agw run wait <runId>, until the exit is not 10', async () => {
    const { calls, run } = scripted([
      { exitCode: 10, stdout: JSON.stringify({ runId: '01a1980b-d977' }) },
      { exitCode: 10, stdout: JSON.stringify({ runId: '01a1980b-d977' }) },
      { exitCode: 0, stdout: JSON.stringify({ status: 'done', output: answer }) },
    ])
    expect(await new AgwClassifier({ bin: 'agw', run }).classify(input)).toEqual(answer)
    expect(calls.map((c) => c.cmd.slice(1, 4))).toEqual([
      ['factory-classify', '--format', 'json'],
      ['run', 'wait', '01a1980b-d977'],
      ['run', 'wait', '01a1980b-d977'],
    ])
  })

  test('a pending run with no id, a run past the deadline, a failed run, a timeout and a missing command all fail', async () => {
    const fail = (results: (ProcessResult | Error)[], options: { deadlineMs?: number; now?: () => number } = {}) =>
      new AgwClassifier({ bin: 'agw', run: scripted(results).run, ...options }).classify(input)
    await expect(fail([{ exitCode: 10, stdout: '{}' }])).rejects.toThrow('names no run id')
    let clock = 0
    await expect(
      fail([{ exitCode: 10, stdout: '{"runId":"abcdef-1"}' }], { deadlineMs: 5, now: () => (clock += 10) }),
    ).rejects.toThrow('did not finish in time')
    await expect(fail([{ exitCode: 1, stdout: '' }])).rejects.toBeInstanceOf(ClassifyFailed)
    await expect(fail([{ exitCode: EXIT_TIMEOUT, stdout: '' }])).rejects.toThrow('did not answer in time')
    await expect(fail([{ exitCode: 0, stdout: 'not json' }])).rejects.toThrow('no JSON')
    await expect(fail([{ exitCode: 0, stdout: '{"status":"failed"}' }])).rejects.toThrow('failed')
    await expect(fail([new CannotExecute('agw', 'ENOENT')])).rejects.toThrow('cannot execute agw')
  })

  test('a classifier whose command is missing leaves the Issue defaulted, not stuck', async () => {
    const issue = await file()
    const classifier = new AgwClassifier({ bin: '/nonexistent/agw' })
    expect(await classifyIssue({ sql: db.sql, classifier, roles: TEST_ROLES, now }, issue)).toBe('defaulted')
    expect((await events(issue.id))[0]?.payload).toMatchObject({ detail: expect.stringContaining('cannot execute') })
  })
})
