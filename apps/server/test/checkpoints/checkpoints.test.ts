import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { fileBlobStore } from '../../src/adapters/blobs/filesystem.ts'
import { postgresCheckpointStore } from '../../src/adapters/postgres/checkpoint-store.ts'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { postgresUnitOfWork } from '../../src/adapters/postgres/unit-of-work.ts'
import { postgresWorkStore } from '../../src/adapters/postgres/work-store.ts'
import {
  annotateArtifact,
  deleteAnnotation,
  editAnnotation,
  answerDecision,
  askDecision,
  finishErrand,
  giveVerdict,
  listPages,
  markWorthAsking,
  raiseErrand,
  reviseArtifact,
  showArtifact,
  showDecision,
  submitArtifact,
} from '../../src/app/checkpoints.ts'
import { type PageDeps, sendDuePages } from '../../src/app/checkpoints-pages.ts'
import { screenErrands } from '../../src/app/checkpoints-errands.ts'
import { type SettleDeps, settleDecision, settleOpen } from '../../src/app/checkpoints-settle.ts'
import { fileIssue, recordIssueEvent } from '../../src/app/issues.ts'
import { readNeeds } from '../../src/read/needs.ts'
import type { ArtifactId } from '../../src/domains/checkpoints/artifact.ts'
import {
  JUDGE_BACKOFF_MS,
  type DecisionId,
  type JudgeVerdict,
  type PolicyRule,
} from '../../src/domains/checkpoints/decision.ts'
import { ERRAND_SCREEN_BACKOFF_MS, type ErrandId } from '../../src/domains/checkpoints/errand.ts'
import type { ErrandScreenAnswer } from '@software-factory/contract'
import type { ErrandScreenPort, Notifier, JudgePort, StandingPolicies } from '../../src/domains/checkpoints/ports.ts'
import type { AnyIssueEvent } from '../../src/domains/work/events.ts'
import { type FixedClock, fixedClock } from '../../src/kernel/clock.ts'
import { type IssueId, sequentialIds } from '../../src/kernel/ids.ts'
import { key } from '../../src/kernel/keys.ts'
import { err, ok, portError, type Result } from '../../src/kernel/result.ts'

let db: TestCluster
let blobDir: string

beforeAll(async () => {
  db = await startTestCluster()
  blobDir = await mkdtemp('/tmp/factory-blobs-')
})

afterAll(async () => {
  await db.stop()
  await rm(blobDir, { recursive: true, force: true })
})

const clock: FixedClock = fixedClock('2026-03-01T12:00:00Z')
let deps: SettleDeps & PageDeps
let rules: PolicyRule[]
let judgeCalls: { question: string; precedents: number; key: string }[]
let judgeAnswer: () => Result<JudgeVerdict>
let screenCalls: { errand: string; key: string }[]
let screenAnswer: () => Result<ErrandScreenAnswer>
let sent: string[]
let sendResult: () => Result<void>
/** what happens while a Judge call is out: the world moves on under it */
let duringJudge: (() => Promise<unknown>) | null

const policies: StandingPolicies = { rulesFor: () => Promise.resolve(ok(rules)) }
const judge: JudgePort = {
  judge: async (input, key) => {
    judgeCalls.push({ question: input.question, precedents: input.precedents.length, key })
    await duringJudge?.()
    return judgeAnswer()
  },
}
const errandScreen: ErrandScreenPort = {
  screen: (request, key) => {
    // The port is never called inside a transaction.
    expect(deps.uow.inTransaction()).toBe(false)
    screenCalls.push({ errand: request.errand.id, key })
    return Promise.resolve(screenAnswer())
  },
}
const notifier: Notifier = {
  send: (page) => {
    // The port is never called inside a transaction.
    expect(deps.uow.inTransaction()).toBe(false)
    const result = sendResult()
    if (result.ok) sent.push(page.key)
    return Promise.resolve(result)
  },
}

beforeEach(async () => {
  await db.sql`DROP SCHEMA IF EXISTS factory CASCADE`
  await migrate(db.sql, await loadMigrations())
  clock.set(new Date('2026-03-01T12:00:00Z'))
  rules = []
  judgeCalls = []
  judgeAnswer = () => ok({ verdict: 'owner', answer: '', reason: 'a taste question', source: '' })
  screenCalls = []
  screenAnswer = () => ok({ verdict: 'pass', reason: 'a person must approve it' })
  sent = []
  sendResult = () => ok(undefined)
  duringJudge = null
  const uow = postgresUnitOfWork(db.sql, (tx) => ({
    work: postgresWorkStore(tx),
    checkpoints: postgresCheckpointStore(tx),
  }))
  deps = {
    uow,
    clock,
    ids: sequentialIds(),
    blobs: fileBlobStore(blobDir),
    consoleUrl: 'https://console.example.test',
    policies,
    judge,
    errandScreen,
    recheckAfterMs: 0,
    notifier,
  }
})

const value = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.value
}
const errorOf = <T, E>(result: Result<T, E>): E => {
  if (result.ok) throw new Error(`expected an error, got ${JSON.stringify(result.value)}`)
  return result.error
}

const record = async (issueId: IssueId, name: string, event: AnyIssueEvent) =>
  value(await recordIssueEvent(deps, { issueId, key: key('test', issueId, name), event }))

/** An Issue with a lead working: attempt 1. */
async function workingIssue(repo = 'example'): Promise<IssueId> {
  const filed = value(
    await fileIssue(deps, {
      key: key('filed', deps.ids.next('signal')),
      event: {
        kind: 'filed',
        payload: { repo, title: 'the probe fails', kind: 'bug', origin: 'you' },
        actor: 'factory',
      },
    }),
  )
  const id = filed.issue.id
  await record(id, 'settled', { kind: 'settled', payload: {}, actor: 'factory' })
  await record(id, 'admitted', { kind: 'admitted', payload: {}, actor: 'factory' })
  await record(id, 'lead_started', { kind: 'lead_started', payload: { attempt: 1, terminal: 't1' }, actor: 'factory' })
  return id
}

const FORM = {
  question: 'Which logging library should the server use?',
  recommendation: 'pino',
  checked: 'Read the package sizes.',
  options: [
    { label: 'pino', reversible: true, cost: 'one dependency' },
    { label: 'winston', reversible: true, cost: 'heavier' },
    { label: 'wipe the table', reversible: false, cost: 'the rows are gone' },
  ],
  noAnswer: { consequence: 'The lead logs with console.' },
}

const ask = async (issueId: IssueId, patch: Record<string, unknown> = {}) =>
  value(await askDecision(deps, { issueId, attempt: 1, form: { ...FORM, ...patch } }))

const rows = async (table: string): Promise<number> => {
  const [row] = await db.sql.unsafe(`SELECT count(*)::int AS n FROM factory.${table}`)
  return Number((row as { n: number }).n)
}

const showAnnotations = async (artifactId: ArtifactId) =>
  value(await showArtifact(deps, { artifactId, revision: null })).annotations.map((a) => a.annotation)

const eventsOf = async (issueId: IssueId): Promise<string[]> =>
  (
    await db.sql`SELECT kind FROM factory.issue_events WHERE issue_id = ${issueId} AND result = 'applied' ORDER BY version`
  ).map((r: { kind: string }) => r.kind)

const effectsOf = async (issueId: IssueId, kind: string): Promise<number> => {
  const [row] =
    await db.sql`SELECT count(*)::int AS n FROM factory.issue_effects WHERE issue_id = ${issueId} AND kind = ${kind}`
  return Number((row as { n: number }).n)
}

describe('asking', () => {
  test('a Decision makes the Issue wait for it, and is an artifact with its form as revision 1', async () => {
    const issueId = await workingIssue()
    const asked = await ask(issueId)
    expect(asked).toMatchObject({
      result: 'applied',
      issue: { state: 'waiting', waitReason: 'decision' },
      decision: { form: { recommendation: 'pino' }, answer: null, steps: [] },
    })
    const artifact = value(
      await showArtifact(deps, { artifactId: asked.decision.id as unknown as ArtifactId, revision: null }),
    )
    expect(artifact.artifact.kind).toBe('decision')
    expect(artifact.content).toContain('**wipe the table** (not reversible)')
  })

  test('a form missing a field is refused with the field named, and nothing is stored', async () => {
    const issueId = await workingIssue()
    const { recommendation: _gone, ...without } = FORM
    const error = errorOf(await askDecision(deps, { issueId, attempt: 1, form: without }))
    expect(error).toMatchObject({ kind: 'missing_field', fields: ['recommendation'] })
    expect(error.kind === 'missing_field' && error.detail).toContain('Nothing was raised: ask again with every field')
    expect(await rows('decisions')).toBe(0)
    expect(await eventsOf(issueId)).toEqual(['filed', 'settled', 'admitted', 'lead_started'])
  })

  test('the same ask again is the same Decision: one row, one asked event', async () => {
    const issueId = await workingIssue()
    const first = await ask(issueId)
    const again = await ask(issueId)
    expect(again).toMatchObject({ result: 'replayed', decision: { id: first.decision.id } })
    expect(await rows('decisions')).toBe(1)
    expect((await eventsOf(issueId)).filter((kind) => kind === 'asked')).toHaveLength(1)
  })

  test('an Issue that is not working refuses the ask, and nothing is stored', async () => {
    const issueId = await workingIssue()
    await ask(issueId)
    const error = errorOf(
      await askDecision(deps, { issueId, attempt: 1, form: { ...FORM, question: 'Another one?' }, by: 'steward' }),
    )
    expect(error.kind).toBe('machine_refused')
    expect(await rows('decisions')).toBe(1)
  })

  test('an Issue that does not exist is unknown', async () => {
    expect(errorOf(await askDecision(deps, { issueId: 'issue_99' as IssueId, attempt: 1, form: FORM }))).toMatchObject({
      kind: 'unknown_issue',
    })
  })
})

describe('amending', () => {
  const AMENDED = { question: 'Which logger, pino or winston, should the server use?', recommendation: 'winston' }

  test('a second Decision on an open question amends it: one Decision, the form replaced, revision 2, judged afresh', async () => {
    const issueId = await workingIssue()
    const first = await ask(issueId)
    value(await settleDecision(deps, first.decision.id))
    expect(judgeCalls).toHaveLength(1)
    expect(await rows('checkpoint_pages')).toBe(1)

    const amended = await ask(issueId, AMENDED)
    expect(amended).toMatchObject({
      result: 'amended',
      decision: {
        id: first.decision.id,
        askedAt: first.decision.askedAt,
        form: { recommendation: 'winston' },
        steps: [],
      },
    })
    expect(await rows('decisions')).toBe(1)
    expect((await eventsOf(issueId)).filter((kind) => kind === 'asked')).toHaveLength(1)
    const artifact = value(
      await showArtifact(deps, { artifactId: first.decision.id as unknown as ArtifactId, revision: null }),
    )
    expect(artifact.revisions.map((r) => [r.n, r.note])).toEqual([
      [1, null],
      [2, 'amended'],
    ])
    expect(artifact.content).toContain('winston')
    const [page] = await db.sql`SELECT cancelled_at FROM factory.checkpoint_pages`
    expect(page?.cancelled_at).not.toBeNull()
    expect((await readNeeds(db.sql, clock.now())).items).toEqual([])

    value(await settleDecision(deps, first.decision.id))
    expect(judgeCalls.map((call) => call.question)).toEqual([FORM.question, AMENDED.question])
    // The amended form is a new agw run, not the verdict computed for the old form.
    expect(judgeCalls[0]?.key).not.toBe(judgeCalls[1]?.key)
    const [revived] = await db.sql`SELECT cancelled_at, body FROM factory.checkpoint_pages`
    expect(revived?.cancelled_at).toBeNull()
    expect(revived?.body).toContain('winston')

    expect(await ask(issueId, AMENDED)).toMatchObject({ result: 'replayed', decision: { id: first.decision.id } })
    expect(await ask(issueId)).toMatchObject({ result: 'amended', decision: { form: { recommendation: 'pino' } } })
    expect(await rows('decisions')).toBe(1)
  })

  test('once the first is answered a new ask is a new Decision', async () => {
    const issueId = await workingIssue()
    const first = await ask(issueId)
    value(await answerDecision(deps, { decisionId: first.decision.id, answer: 'pino' }))
    const second = await ask(issueId, AMENDED)
    expect(second.result).toBe('applied')
    expect(second.decision.id).not.toBe(first.decision.id)
    expect(await rows('decisions')).toBe(2)
  })

  test('a Judge result that arrives after an amend is dropped: it answers nothing', async () => {
    const issueId = await workingIssue()
    const first = await ask(issueId)
    judgeAnswer = () => ok({ verdict: 'answer', answer: 'pino', reason: 'r', source: 'plan: docs/x.md' })
    duringJudge = async () => {
      duringJudge = null
      await ask(issueId, AMENDED)
    }
    expect(value(await settleDecision(deps, first.decision.id))).toMatchObject({ status: 'open', settledBy: null })
    const shown = value(await showDecision(deps, first.decision.id))
    expect(shown.answer).toBeNull()
    expect(shown.form.recommendation).toBe('winston')
    expect(shown.steps.find((s) => s.step === 'judge')).toBeUndefined()
    expect(await rows('checkpoint_pages')).toBe(0)

    // The amended form is judged afresh.
    judgeAnswer = () => ok({ verdict: 'answer', answer: 'winston', reason: 'r', source: 'plan: docs/x.md' })
    expect(value(await settleDecision(deps, first.decision.id))).toMatchObject({
      status: 'answered',
      settledBy: 'judge',
    })
  })
})

describe('settling, in turn', () => {
  test('standing policy settles it first; the Judge is never called', async () => {
    const issueId = await workingIssue()
    rules = [{ when: 'logging library', answer: 'winston', reason: 'the owner standardised on it' }]
    const { decision } = await ask(issueId)
    const settled = value(await settleDecision(deps, decision.id))
    expect(settled).toMatchObject({ status: 'answered', settledBy: 'policy' })
    expect(judgeCalls).toEqual([])
    const shown = value(await showDecision(deps, decision.id))
    expect(shown).toMatchObject({ answer: 'winston', source: 'the owner standardised on it' })
    expect(shown.steps.map((s) => [s.step, s.outcome])).toEqual([['policy', 'answered']])
    // The lead hears it as one note and the answer, ending the wait.
    expect(await eventsOf(issueId)).toEqual([
      'filed',
      'settled',
      'admitted',
      'lead_started',
      'asked',
      'noted',
      'answered',
    ])
    expect(await effectsOf(issueId, 'note_lead')).toBe(1)
    expect(await rows('checkpoint_pages')).toBe(0)
  })

  test("the Judge settles what policy does not, with the owner's earlier answers as precedent", async () => {
    const first = await workingIssue()
    const earlier = await ask(first, {
      question: 'Which retention for the audit log rows?',
      noAnswer: { consequence: 'Waits.' },
    })
    value(await answerDecision(deps, { decisionId: earlier.decision.id, answer: 'pino' }))

    const issueId = await workingIssue()
    judgeAnswer = () =>
      ok({ verdict: 'answer', answer: 'pino', reason: 'the plan decided', source: 'plan: docs/decisions.md' })
    const { decision } = await ask(issueId, { question: 'Which retention for the access log rows?' })
    const settled = value(await settleDecision(deps, decision.id))
    expect(settled).toMatchObject({ status: 'answered', settledBy: 'judge' })
    expect(judgeCalls).toMatchObject([{ question: 'Which retention for the access log rows?', precedents: 1 }])
    const shown = value(await showDecision(deps, decision.id))
    expect(shown.source).toBe('plan: docs/decisions.md')
    expect(shown.steps.map((s) => [s.step, s.outcome])).toEqual([
      ['policy', 'passed'],
      ['judge', 'answered'],
    ])
    expect(await rows('checkpoint_pages')).toBe(0)
  })

  test('a Judge answer the guards reject, an irreversible option included, goes on to the owner', async () => {
    const issueId = await workingIssue()
    judgeAnswer = () => ok({ verdict: 'answer', answer: 'wipe the table', reason: 'tidy', source: 'plan: docs/x.md' })
    const { decision } = await ask(issueId)
    expect(value(await settleDecision(deps, decision.id))).toMatchObject({ status: 'open', settledBy: null })
    const shown = value(await showDecision(deps, decision.id))
    expect(shown.steps.map((s) => [s.step, s.outcome])).toEqual([
      ['policy', 'passed'],
      ['judge', 'rejected'],
      ['owner', 'open'],
    ])
    expect(shown.steps[1]?.detail).toContain('cannot be taken back')
  })

  test('a Judge that fails is tried again after the backoff; the owner is reached only after the third failure, with the failure recorded', async () => {
    const issueId = await workingIssue()
    judgeAnswer = () => err(portError('timeout', 'agw did not answer'))
    const { decision } = await ask(issueId)
    const stepsOf = async () =>
      value(await showDecision(deps, decision.id)).steps.map((s) => [s.step, s.outcome, s.tries])

    value(await settleDecision(deps, decision.id))
    expect(await stepsOf()).toEqual([
      ['policy', 'passed', 1],
      ['judge', 'failed', 1],
    ])
    expect(await rows('checkpoint_pages')).toBe(0)
    expect((await readNeeds(db.sql, clock.now())).items).toEqual([])

    // The backoff has not run out: no new call, still not the owner's.
    clock.advance(JUDGE_BACKOFF_MS - 1000)
    value(await settleDecision(deps, decision.id))
    expect(judgeCalls).toHaveLength(1)
    expect(await rows('checkpoint_pages')).toBe(0)

    clock.advance(1000)
    value(await settleDecision(deps, decision.id))
    expect(judgeCalls).toHaveLength(2)
    expect(await rows('checkpoint_pages')).toBe(0)

    clock.advance(JUDGE_BACKOFF_MS)
    value(await settleDecision(deps, decision.id))
    expect(judgeCalls).toHaveLength(3)
    // Each try is its own agw run: the same key would hand back the first failed one.
    expect(new Set(judgeCalls.map((call) => call.key)).size).toBe(3)
    const shown = value(await showDecision(deps, decision.id))
    expect(shown.steps.map((s) => [s.step, s.outcome, s.tries])).toEqual([
      ['policy', 'passed', 1],
      ['judge', 'failed', 3],
      ['owner', 'open', 1],
    ])
    expect(shown.steps[1]?.detail).toBe('the Judge could not be reached after 3 tries: timeout: agw did not answer')
    expect(await rows('checkpoint_pages')).toBe(1)
    const needs = await readNeeds(db.sql, clock.now())
    expect(needs.items).toHaveLength(1)
    expect(needs.items[0]?.judge).toContain('could not be reached after 3 tries')

    clock.advance(JUDGE_BACKOFF_MS)
    value(await settleDecision(deps, decision.id))
    expect(judgeCalls).toHaveLength(3)
  })

  test('a Judge retry that succeeds with an answer settles it by the Judge', async () => {
    const issueId = await workingIssue()
    judgeAnswer = () => err(portError('timeout', 'agw did not answer'))
    const { decision } = await ask(issueId)
    value(await settleDecision(deps, decision.id))
    judgeAnswer = () => ok({ verdict: 'answer', answer: 'pino', reason: 'the plan', source: 'plan: docs/x.md' })
    clock.advance(JUDGE_BACKOFF_MS)
    expect(value(await settleDecision(deps, decision.id))).toMatchObject({ status: 'answered', settledBy: 'judge' })
    expect(await rows('checkpoint_pages')).toBe(0)
  })

  test('a Decision is not in Needs you until the Judge has seen it and passed it on', async () => {
    const issueId = await workingIssue()
    const { decision } = await ask(issueId)
    expect((await readNeeds(db.sql, clock.now())).items).toEqual([])
    expect(judgeCalls).toEqual([])
    value(await settleDecision(deps, decision.id))
    expect(judgeCalls).toHaveLength(1)
    const needs = await readNeeds(db.sql, clock.now())
    expect(needs.items.map((item) => [item.kind, item.id, item.judge])).toEqual([
      ['decision', decision.id, 'a taste question'],
    ])
    const shown = value(await showDecision(deps, decision.id))
    expect(shown.steps.find((s) => s.step === 'judge')).toMatchObject({ outcome: 'passed', detail: 'a taste question' })
  })

  test('the default is taken after its wait when the option is reversible, and pages no one', async () => {
    const issueId = await workingIssue()
    const { decision } = await ask(issueId, {
      noAnswer: { consequence: 'Console logging.', default: 'pino', waitMinutes: 30 },
    })
    expect(value(await settleDecision(deps, decision.id))).toMatchObject({ status: 'open' })
    expect(await rows('checkpoint_pages')).toBe(0)

    clock.advance(29 * 60_000)
    expect(value(await settleDecision(deps, decision.id))).toMatchObject({ status: 'open' })
    clock.advance(60_000)
    expect(value(await settleDecision(deps, decision.id))).toMatchObject({ status: 'answered', settledBy: 'default' })
    const shown = value(await showDecision(deps, decision.id))
    expect(shown.steps.map((s) => [s.step, s.outcome])).toEqual([
      ['policy', 'passed'],
      ['judge', 'passed'],
      ['default', 'answered'],
    ])
    expect(await rows('checkpoint_pages')).toBe(0)
    expect(await effectsOf(issueId, 'note_lead')).toBe(1)
  })

  test('the owner is reached when nothing else settles it: paged once, however often the pass runs', async () => {
    const issueId = await workingIssue()
    const { decision } = await ask(issueId)
    for (let i = 0; i < 3; i++) value(await settleDecision(deps, decision.id))
    expect(judgeCalls).toHaveLength(1)
    expect(await rows('checkpoint_pages')).toBe(1)
    expect(value(await sendDuePages(deps)).sent).toHaveLength(1)
    expect(value(await sendDuePages(deps)).sent).toHaveLength(0)
    expect(sent).toHaveLength(1)

    const answered = value(await answerDecision(deps, { decisionId: decision.id, answer: 'winston' }))
    expect(answered).toMatchObject({ decision: { settledBy: 'owner', answer: 'winston' }, issue: { state: 'working' } })
    expect(await eventsOf(issueId)).toEqual(['filed', 'settled', 'admitted', 'lead_started', 'asked', 'answered'])
    expect(await effectsOf(issueId, 'note_lead')).toBe(1)
  })

  test('two settlers at once: one answer, and the other sees it', async () => {
    const issueId = await workingIssue()
    judgeAnswer = () => ok({ verdict: 'answer', answer: 'pino', reason: 'r', source: 'plan: docs/x.md' })
    const { decision } = await ask(issueId)
    const [a, b] = await Promise.all([
      settleDecision(deps, decision.id),
      answerDecision(deps, { decisionId: decision.id, answer: 'winston' }),
    ])
    expect([a.ok, b.ok].filter(Boolean).length).toBeGreaterThanOrEqual(1)
    expect(await eventsOf(issueId)).toContain('answered')
    expect((await eventsOf(issueId)).filter((kind) => kind === 'answered')).toHaveLength(1)
    expect(await effectsOf(issueId, 'note_lead')).toBe(1)
    const again = await answerDecision(deps, { decisionId: decision.id, answer: 'pino' })
    expect(errorOf(again)).toMatchObject({ kind: 'already_answered' })
  })

  test('a Decision whose Issue was cancelled is withdrawn without calling anyone', async () => {
    const issueId = await workingIssue()
    const { decision } = await ask(issueId)
    await record(issueId, 'cancel', { kind: 'cancelled', payload: { reason: 'dropped by the owner' }, actor: 'owner' })
    expect(value(await settleDecision(deps, decision.id))).toMatchObject({ status: 'withdrawn' })
    expect(judgeCalls).toEqual([])
    expect(await rows('checkpoint_pages')).toBe(0)
    expect(value(await answerDecision(deps, { decisionId: decision.id, answer: 'pino' }))).toMatchObject({
      decision: { answer: null, withdrawnReason: expect.stringContaining('no longer waits') },
      issue: null,
    })
    expect(value(await showDecision(deps, decision.id)).withdrawnReason).toContain('no longer waits')
  })

  test("the owner answering while the Judge is out: the Judge's pass-on pages no one", async () => {
    const issueId = await workingIssue()
    const { decision } = await ask(issueId)
    duringJudge = () => answerDecision(deps, { decisionId: decision.id, answer: 'winston' })
    expect(value(await settleDecision(deps, decision.id))).toMatchObject({ status: 'answered', settledBy: 'owner' })
    expect(await rows('checkpoint_pages')).toBe(0)
    expect(await eventsOf(issueId)).toContain('answered')
  })

  test('the Issue cancelled while the Judge is out: the Decision is withdrawn and no one is paged', async () => {
    const issueId = await workingIssue()
    const { decision } = await ask(issueId)
    duringJudge = () => record(issueId, 'cancel', { kind: 'cancelled', payload: { reason: 'stop' }, actor: 'owner' })
    expect(value(await settleDecision(deps, decision.id))).toMatchObject({ status: 'withdrawn' })
    expect(await rows('checkpoint_pages')).toBe(0)
  })

  test('an answer that could not be recorded lets go of its step: the next pass goes on to the owner', async () => {
    const issueId = await workingIssue()
    const { decision } = await ask(issueId)
    judgeAnswer = () => ok({ verdict: 'answer', answer: 'pino', reason: 'r', source: 'plan: docs/x.md' })
    const real = deps.uow
    let blink = false
    duringJudge = async () => {
      blink = true
    }
    deps = {
      ...deps,
      uow: {
        inTransaction: () => real.inTransaction(),
        run: (work) => {
          if (!blink) return real.run(work)
          blink = false
          return Promise.resolve(err(portError('gone', 'the database blinked')))
        },
      },
    }
    expect(errorOf(await settleDecision(deps, decision.id))).toMatchObject({ kind: 'gone' })
    const shown = value(await showDecision(deps, decision.id))
    expect(shown.steps.find((step) => step.step === 'judge')).toMatchObject({ outcome: 'failed' })
    expect(shown.steps.find((step) => step.step === 'judge')?.detail).toContain('could not be recorded')

    duringJudge = null
    // The Judge never answered: its retry waits out the backoff, and only then the owner is reached.
    expect(value(await settleDecision(deps, decision.id))).toMatchObject({ status: 'open' })
    expect(await rows('checkpoint_pages')).toBe(0)
    clock.advance(JUDGE_BACKOFF_MS)
    judgeAnswer = () => ok({ verdict: 'owner', answer: '', reason: 'a taste question', source: '' })
    expect(value(await settleDecision(deps, decision.id))).toMatchObject({ status: 'open' })
    expect(await rows('checkpoint_pages')).toBe(1)
  })

  test('a pass over the open Decisions settles each, oldest first', async () => {
    const one = await workingIssue()
    const two = await workingIssue()
    rules = [{ when: 'logging', answer: 'pino', reason: 'standing' }]
    await ask(one)
    clock.advance(1000)
    await ask(two)
    const settled = value(await settleOpen(deps))
    expect(settled.map((s) => s.settledBy)).toEqual(['policy', 'policy'])
    expect(value(await settleOpen(deps))).toEqual([])
  })

  test('a step claimed by a call in flight leaves the Decision alone: no Judge, no owner step, no page', async () => {
    const issueId = await workingIssue()
    const { decision } = await ask(issueId)
    await db.sql`INSERT INTO factory.decision_steps (decision_id, step, claimed_until) VALUES (${decision.id}, 'policy', ${new Date('2026-03-01T12:30:00Z')})`
    expect(value(await settleDecision(deps, decision.id))).toMatchObject({ status: 'open', settledBy: null })
    const shown = value(await showDecision(deps, decision.id))
    expect(shown.steps).toEqual([{ step: 'policy', outcome: null, at: null, detail: null, tries: 1 }])
    expect(judgeCalls).toEqual([])
    expect(await rows('checkpoint_pages')).toBe(0)

    // The call that held it never reported back: once its lease has lapsed the next pass takes the step over.
    clock.advance(31 * 60_000)
    value(await settleDecision(deps, decision.id))
    expect(judgeCalls).toHaveLength(1)
    expect(await rows('checkpoint_pages')).toBe(1)
  })

  test('a Judge call in flight in another pass keeps the owner from being paged for what it may settle', async () => {
    const issueId = await workingIssue()
    const { decision } = await ask(issueId)
    await db.sql`INSERT INTO factory.decision_steps (decision_id, step, outcome, detail, at) VALUES (${decision.id}, 'policy', 'passed', 'no rule matches', ${clock.now()})`
    await db.sql`INSERT INTO factory.decision_steps (decision_id, step, claimed_until) VALUES (${decision.id}, 'judge', ${new Date('2026-03-01T12:30:00Z')})`
    value(await settleDecision(deps, decision.id))
    value(await settleDecision(deps, decision.id))
    expect(judgeCalls).toEqual([])
    expect(await rows('checkpoint_pages')).toBe(0)
    expect(value(await showDecision(deps, decision.id)).steps.map((s) => s.step)).toEqual(['policy', 'judge'])
  })
})

describe('the ledger', () => {
  test("worth asking is the owner's flag on an answered Decision only, and feeds the ledger", async () => {
    const issueId = await workingIssue()
    const { decision } = await ask(issueId)
    expect(errorOf(await markWorthAsking(deps, { decisionId: decision.id, worth: true }))).toMatchObject({
      kind: 'invalid',
    })
    value(await answerDecision(deps, { decisionId: decision.id, answer: 'pino' }))
    expect(value(await markWorthAsking(deps, { decisionId: decision.id, worth: true })).worthAsking).toBe(true)
    expect(value(await markWorthAsking(deps, { decisionId: decision.id, worth: true })).worthAsking).toBe(true)
    expect(
      errorOf(await markWorthAsking(deps, { decisionId: 'decision_nope' as DecisionId, worth: true })),
    ).toMatchObject({
      kind: 'not_found',
    })
  })
})

describe('artifacts', () => {
  const SPEC = { kind: 'spec', title: 'The queue spec', content: '# Queue\n\nWe keep the queue in Postgres.' }

  test("a Spec makes the Issue wait; a verdict is the lead's next turn, in one note_lead, once", async () => {
    const issueId = await workingIssue()
    const submitted = value(await submitArtifact(deps, { issueId, attempt: 1, raw: SPEC }))
    expect(submitted).toMatchObject({ result: 'applied', issue: { state: 'waiting', waitReason: 'review' } })
    const artifactId = submitted.artifact.id

    const given = value(
      await giveVerdict(deps, { artifactId, verdict: 'changes', note: 'Name the lock.', revision: null }),
    )
    expect(given).toMatchObject({ result: 'applied', issue: { state: 'working' } })
    expect(given.issue?.effects.map((e) => e.kind)).toEqual(['note_lead'])
    expect(await effectsOf(issueId, 'note_lead')).toBe(1)

    // The same verdict, or a second one on that revision, plans nothing: the first stands.
    const again = value(
      await giveVerdict(deps, { artifactId, verdict: 'changes', note: 'Name the lock.', revision: null }),
    )
    expect(again).toMatchObject({ result: 'replayed', issue: { effects: [] } })
    const second = value(await giveVerdict(deps, { artifactId, verdict: 'looks_good', note: null, revision: null }))
    expect(second).toMatchObject({ result: 'replayed', verdict: { verdict: 'changes' } })
    expect(await effectsOf(issueId, 'note_lead')).toBe(1)
    expect(await eventsOf(issueId)).toEqual([
      'filed',
      'settled',
      'admitted',
      'lead_started',
      'submitted',
      'noted',
      'verdict_given',
    ])
  })

  test('a revision after Changes waits again and pages for the new revision; a stale verdict is refused', async () => {
    const issueId = await workingIssue()
    const { artifact } = value(await submitArtifact(deps, { issueId, attempt: 1, raw: SPEC }))
    value(await giveVerdict(deps, { artifactId: artifact.id, verdict: 'changes', note: null, revision: null }))
    const revised = value(
      await reviseArtifact(deps, {
        artifactId: artifact.id,
        attempt: 1,
        content: '# Queue\n\nThe lock is advisory.',
        note: 'named it',
      }),
    )
    expect(revised).toMatchObject({ issue: { state: 'waiting', waitReason: 'review' } })
    expect(revised.artifact.id).toBe(artifact.id)
    expect(await rows('artifact_revisions')).toBe(2)
    expect(await rows('checkpoint_pages')).toBe(2)
    expect(
      errorOf(await giveVerdict(deps, { artifactId: artifact.id, verdict: 'looks_good', note: null, revision: 1 })),
    ).toMatchObject({
      kind: 'invalid',
    })
    // the same revision again is a replay
    expect(
      value(
        await reviseArtifact(deps, {
          artifactId: artifact.id,
          attempt: 1,
          content: '# Queue\n\nThe lock is advisory.',
          note: null,
        }),
      ),
    ).toMatchObject({ result: 'replayed' })
    expect(await rows('artifact_revisions')).toBe(2)
  })

  test('submitting the same hand-over twice is one artifact, one page', async () => {
    const issueId = await workingIssue()
    value(await submitArtifact(deps, { issueId, attempt: 1, raw: SPEC }))
    expect(value(await submitArtifact(deps, { issueId, attempt: 1, raw: SPEC }))).toMatchObject({ result: 'replayed' })
    expect(await rows('artifacts')).toBe(1)
    expect(await rows('checkpoint_pages')).toBe(1)
    expect(value(await sendDuePages(deps)).sent).toHaveLength(1)
    expect(value(await sendDuePages(deps)).sent).toHaveLength(0)
  })

  test('a Report never waits and pages no one; a missing field is named', async () => {
    const issueId = await workingIssue()
    const report = value(
      await submitArtifact(deps, {
        issueId,
        attempt: 1,
        raw: { kind: 'report', title: 'Spike', content: 'It works.' },
      }),
    )
    expect(report).toMatchObject({ issue: null })
    expect(await rows('checkpoint_pages')).toBe(0)
    expect(
      errorOf(await submitArtifact(deps, { issueId, attempt: 1, raw: { kind: 'spec', content: 'x' } })),
    ).toMatchObject({
      kind: 'missing_field',
      fields: ['title'],
    })
    // a spike's verdict is stored and wakes no one
    const verdict = value(
      await giveVerdict(deps, { artifactId: report.artifact.id, verdict: 'looks_good', note: null, revision: null }),
    )
    expect(verdict).toMatchObject({ issue: null, verdict: { verdict: 'looks_good' } })
  })

  test('a verdict on a Decision is invalid: it is answered', async () => {
    const issueId = await workingIssue()
    const { decision } = await ask(issueId)
    expect(
      errorOf(
        await giveVerdict(deps, {
          artifactId: decision.id as unknown as ArtifactId,
          verdict: 'looks_good',
          note: null,
          revision: null,
        }),
      ),
    ).toMatchObject({ kind: 'invalid' })
  })

  test('an annotation whose quote is gone from the revision lands in Unanchored', async () => {
    const issueId = await workingIssue()
    const { artifact } = value(
      await submitArtifact(deps, {
        issueId,
        attempt: 1,
        raw: {
          kind: 'report',
          title: 'Notes',
          content: '# Notes\n\nWe keep the queue in Postgres. Retries are three.',
        },
      }),
    )
    const annotate = (quote: string, comment: string, author: 'owner' | 'lead' = 'owner') =>
      annotateArtifact(deps, {
        artifactId: artifact.id,
        revision: null,
        author,
        raw: { quote, comment, path: 'Notes' },
      })
    value(await annotate('keep the queue in Postgres', 'why not Redis?'))
    value(await annotate('Retries are three', 'make it five'))
    expect(value(await annotate('Retries are three', 'make it five'))).toMatchObject({ result: 'replayed' })
    expect(await rows('annotations')).toBe(2)

    value(
      await reviseArtifact(deps, {
        artifactId: artifact.id,
        attempt: null,
        content: '# Notes\n\nWe keep the queue in Postgres.',
        note: null,
      }),
    )
    const shown = value(await showArtifact(deps, { artifactId: artifact.id, revision: null }))
    expect(shown.revision).toBe(2)
    expect(shown.annotations.map((a) => [a.annotation.quote, a.anchor])).toEqual([
      ['keep the queue in Postgres', 'anchored'],
      ['Retries are three', 'unanchored'],
    ])
    // Looked at on the revision it was made on, it is anchored again.
    const first = value(await showArtifact(deps, { artifactId: artifact.id, revision: 1 }))
    expect(first.annotations.every((a) => a.anchor === 'anchored')).toBe(true)
  })

  test('the owner edits and deletes an annotation; a repeat is harmless and another artifact is not found', async () => {
    const issueId = await workingIssue()
    const submit = async (title: string) =>
      value(
        await submitArtifact(deps, {
          issueId,
          attempt: 1,
          raw: { kind: 'report', title, content: 'Retries are three.' },
        }),
      ).artifact
    const artifact = await submit('Notes')
    const other = await submit('Other')
    const made = value(
      await annotateArtifact(deps, {
        artifactId: artifact.id,
        revision: null,
        author: 'owner',
        raw: { quote: 'Retries are three', comment: 'make it five' },
      }),
    )
    expect(made.issue).toBeNull()
    const [stored] = await showAnnotations(artifact.id)
    const id = stored?.id ?? ''
    expect(stored?.editedAt).toBeNull()

    const edit = (artifactId: ArtifactId, comment: unknown) =>
      editAnnotation(deps, { artifactId, annotationId: id, raw: { comment } })
    expect(value(await edit(artifact.id, '  make it four  '))).toMatchObject({ result: 'applied', issue: null })
    const [edited] = await showAnnotations(artifact.id)
    expect(edited).toMatchObject({ comment: 'make it four', quote: 'Retries are three' })
    expect(edited?.editedAt).not.toBeNull()
    expect(value(await edit(artifact.id, 'make it four'))).toMatchObject({ result: 'replayed' })
    // the old words can be said again as a new comment after the edit
    value(
      await annotateArtifact(deps, {
        artifactId: artifact.id,
        revision: null,
        author: 'owner',
        raw: { quote: 'Retries are three', comment: 'make it five' },
      }),
    )
    expect(await rows('annotations')).toBe(2)
    // a lead's comment is not the owner's to edit
    value(
      await annotateArtifact(deps, {
        artifactId: artifact.id,
        revision: null,
        author: 'lead',
        raw: { quote: 'Retries are three', comment: 'three is the contract' },
      }),
    )
    const leads = (await showAnnotations(artifact.id)).find((a) => a.author === 'lead')
    expect(
      errorOf(
        await editAnnotation(deps, { artifactId: artifact.id, annotationId: leads?.id ?? '', raw: { comment: 'x' } }),
      ),
    ).toMatchObject({ kind: 'invalid' })
    expect(await rows('annotations')).toBe(3)
    expect(errorOf(await edit(artifact.id, '   '))).toMatchObject({ kind: 'missing_field' })
    expect(errorOf(await edit(other.id, 'x'))).toMatchObject({ kind: 'not_found', what: 'annotation' })
    expect(errorOf(await edit('artifact_none' as ArtifactId, 'x'))).toMatchObject({
      kind: 'not_found',
      what: 'artifact',
    })
    expect(
      errorOf(
        await editAnnotation(deps, { artifactId: artifact.id, annotationId: 'annotation_none', raw: { comment: 'x' } }),
      ),
    ).toMatchObject({ kind: 'not_found', what: 'annotation' })

    const remove = (artifactId: ArtifactId) => deleteAnnotation(deps, { artifactId, annotationId: id })
    expect(errorOf(await remove(other.id))).toMatchObject({ kind: 'not_found', what: 'annotation' })
    expect(await rows('annotations')).toBe(3)
    expect(value(await remove(artifact.id))).toMatchObject({ result: 'applied', issue: null })
    expect(await rows('annotations')).toBe(2)
    expect(value(await remove(artifact.id))).toMatchObject({ result: 'replayed' })
    expect(errorOf(await remove('artifact_none' as ArtifactId))).toMatchObject({ kind: 'not_found', what: 'artifact' })
    const shown = value(await showArtifact(deps, { artifactId: artifact.id, revision: null }))
    expect(shown.annotations.map((a) => a.annotation.id)).not.toContain(id)
  })

  test('revising back to older content is a new revision; the latest content again is a replay', async () => {
    const issueId = await workingIssue()
    const { artifact } = value(
      await submitArtifact(deps, { issueId, attempt: 1, raw: { kind: 'report', title: 'R', content: 'X' } }),
    )
    const revise = (content: string) =>
      reviseArtifact(deps, { artifactId: artifact.id, attempt: null, content, note: null })
    expect(value(await revise('Y')).revisions).toHaveLength(2)
    expect(value(await revise('X')).revisions).toHaveLength(3)
    expect(value(await revise('X'))).toMatchObject({ result: 'replayed' })
    expect(await rows('artifact_revisions')).toBe(3)
  })

  test('a revision of a Concept needs the attempt; a Decision is not revised', async () => {
    const issueId = await workingIssue()
    const { artifact } = value(await submitArtifact(deps, { issueId, attempt: 1, raw: { ...SPEC, kind: 'concept' } }))
    value(await giveVerdict(deps, { artifactId: artifact.id, verdict: 'changes', note: null, revision: null }))
    expect(
      errorOf(await reviseArtifact(deps, { artifactId: artifact.id, attempt: null, content: 'v2', note: null })),
    ).toMatchObject({
      kind: 'missing_field',
      fields: ['attempt'],
    })
    const second = await workingIssue()
    const { decision } = await ask(second)
    expect(
      errorOf(
        await reviseArtifact(deps, {
          artifactId: decision.id as unknown as ArtifactId,
          attempt: 1,
          content: 'v2',
          note: null,
        }),
      ),
    ).toMatchObject({ kind: 'invalid' })
  })
})

describe('a Decision raised during a review', () => {
  const SPEC = { kind: 'spec', title: 'The queue spec', content: '# Queue\n\nWe keep the queue in Postgres.' }

  async function reviewed() {
    const issueId = await workingIssue()
    const { artifact } = value(await submitArtifact(deps, { issueId, attempt: 1, raw: SPEC }))
    return { issueId, artifactId: artifact.id }
  }
  const verdictOf = (artifactId: ArtifactId) =>
    giveVerdict(deps, { artifactId, verdict: 'looks_good', note: null, revision: null }).then(value)

  test('is taken, linked to the artifact, replayed, amended and judged like any other', async () => {
    const { issueId, artifactId } = await reviewed()
    const asked = await ask(issueId)
    expect(asked).toMatchObject({
      result: 'applied',
      issue: { state: 'waiting', waitReason: 'review' },
      decision: { artifactId },
    })
    expect(await ask(issueId)).toMatchObject({ result: 'replayed', decision: { id: asked.decision.id } })
    expect(await ask(issueId, { recommendation: 'winston' })).toMatchObject({
      result: 'amended',
      decision: { id: asked.decision.id, artifactId, form: { recommendation: 'winston' } },
    })
    expect(await rows('decisions')).toBe(1)

    judgeAnswer = () => ok({ verdict: 'answer', answer: 'pino', reason: 'the plan decided', source: 'plan' })
    expect(value(await settleDecision(deps, asked.decision.id))).toMatchObject({
      status: 'answered',
      settledBy: 'judge',
    })
    // The verdict is still due, so the Issue waits.
    expect(await eventsOf(issueId)).toEqual([
      'filed',
      'settled',
      'admitted',
      'lead_started',
      'submitted',
      'asked',
      'noted',
      'answered',
    ])
    expect(await effectsOf(issueId, 'note_lead')).toBe(0)
    const given = await verdictOf(artifactId)
    expect(given.issue).toMatchObject({ state: 'working' })
    expect(await effectsOf(issueId, 'note_lead')).toBe(1)
  })

  test('the verdict first: the Issue waits for the owner on the Decision, then resumes once', async () => {
    const { issueId, artifactId } = await reviewed()
    const { decision } = await ask(issueId)
    const given = await verdictOf(artifactId)
    expect(given.issue).toMatchObject({ state: 'waiting', waitReason: 'review' })
    expect(await effectsOf(issueId, 'note_lead')).toBe(0)

    value(await settleDecision(deps, decision.id))
    const needs = await readNeeds(db.sql, clock.now())
    // The review is done with; only the Decision is left, and it names its artifact.
    expect(needs.items.map((item) => [item.kind, item.id, item.artifact])).toEqual([
      ['decision', decision.id, artifactId],
    ])
    const answered = value(await answerDecision(deps, { decisionId: decision.id, answer: 'winston' }))
    expect(answered.issue).toMatchObject({ state: 'working' })
    expect(await effectsOf(issueId, 'note_lead')).toBe(1)
    expect((await eventsOf(issueId)).filter((kind) => kind === 'answered' || kind === 'verdict_given')).toEqual([
      'verdict_given',
      'answered',
    ])
  })

  test('Needs lists the review and its Decision together until the verdict is given', async () => {
    const { issueId, artifactId } = await reviewed()
    const { decision } = await ask(issueId)
    value(await settleDecision(deps, decision.id))
    const before = await readNeeds(db.sql, clock.now())
    expect(before.items.map((item) => [item.kind, item.id, item.artifact]).sort()).toEqual(
      [
        ['decision', decision.id, artifactId],
        ['review', artifactId, null],
      ].sort(),
    )
    await verdictOf(artifactId)
    expect((await readNeeds(db.sql, clock.now())).items.map((item) => item.kind)).toEqual(['decision'])
  })

  test('a Decision whose review wait ends by cancel is withdrawn', async () => {
    const { issueId } = await reviewed()
    const { decision } = await ask(issueId)
    await record(issueId, 'cancelled', { kind: 'cancelled', payload: { reason: 'no longer wanted' }, actor: 'owner' })
    expect(value(await settleDecision(deps, decision.id))).toMatchObject({ status: 'withdrawn' })
  })
})

describe('errands', () => {
  const APPROVE = { summary: 'Approve the App Store build' }
  const raise = async (issueId: IssueId, raw: Record<string, unknown> = APPROVE) =>
    value(await raiseErrand(deps, { issueId, attempt: 1, raw }))
  const pageCount = async () => rows('checkpoint_pages')

  test('raised by the lead: the Issue waits, nobody is paged and the owner does not see it', async () => {
    const issueId = await workingIssue()
    const raised = await raise(issueId)
    expect(raised).toMatchObject({ result: 'applied', issue: { state: 'waiting', waitReason: 'errand' } })
    expect(await raise(issueId)).toMatchObject({ result: 'replayed' })
    expect(await rows('errands')).toBe(1)
    expect(await pageCount()).toBe(0)
    expect((await readNeeds(db.sql, clock.now())).items).toEqual([])
    expect(raised.errand.reachedOwnerAt).toBeNull()
  })

  test('a pass reaches the owner: visible, paged once, replay safe, and the owner finishes it', async () => {
    const issueId = await workingIssue()
    const raised = await raise(issueId)
    expect(value(await screenErrands(deps))).toEqual([{ errand: raised.errand.id, outcome: 'reached_owner' }])
    expect(value(await screenErrands(deps))).toEqual([])
    expect(screenCalls).toEqual([{ errand: raised.errand.id, key: key('factory-errand', raised.errand.id, 1) }])
    expect(await pageCount()).toBe(1)
    expect((await readNeeds(db.sql, clock.now())).items).toMatchObject([
      { kind: 'errand', judge: 'a person must approve it' },
    ])
    expect(value(await sendDuePages(deps)).sent).toEqual([key('page', 'errand', raised.errand.id)])

    const done = value(await finishErrand(deps, { errandId: raised.errand.id, note: 'approved' }))
    expect(done).toMatchObject({
      result: 'applied',
      errand: { doneNote: 'approved', screenBy: 'judge' },
      issue: { state: 'working' },
    })
    expect(await effectsOf(issueId, 'note_lead')).toBe(1)
    expect(value(await finishErrand(deps, { errandId: raised.errand.id, note: null }))).toMatchObject({
      result: 'replayed',
    })
    expect(await effectsOf(issueId, 'note_lead')).toBe(1)
  })

  test('turned away by the screen: the wait ends, the lead hears why, nothing is paged', async () => {
    const issueId = await workingIssue()
    const raised = await raise(issueId)
    screenAnswer = () => ok({ verdict: 'turn_away', reason: 'a token can do this' })
    expect(value(await screenErrands(deps))).toEqual([{ errand: raised.errand.id, outcome: 'turned_away' }])
    const errand = value(await raiseErrandRead(raised.errand.id))
    expect(errand).toMatchObject({ doneNote: 'a token can do this', screenBy: 'judge' })
    expect(errand.turnedAwayAt).not.toBeNull()
    expect(await eventsOf(issueId)).toContain('errand_done')
    const [event] = await db.sql`
      SELECT actor, payload FROM factory.issue_events WHERE issue_id = ${issueId} AND kind = 'errand_done'`
    expect(event).toMatchObject({
      actor: 'judge',
      payload: { errand: raised.errand.id, turnedAway: 'a token can do this' },
    })
    expect(await effectsOf(issueId, 'note_lead')).toBe(1)
    expect(await pageCount()).toBe(0)
    expect((await readNeeds(db.sql, clock.now())).items).toEqual([])
    expect(value(await screenErrands(deps))).toEqual([])
  })

  test('a rule turns away a command a token can run without calling the screen', async () => {
    const issueId = await workingIssue()
    const raised = await raise(issueId, { summary: 'Run the migration', detail: 'Run `make deploy` on the host' })
    expect(value(await screenErrands(deps))).toEqual([{ errand: raised.errand.id, outcome: 'turned_away' }])
    expect(screenCalls).toEqual([])
    const [event] =
      await db.sql`SELECT actor FROM factory.issue_events WHERE issue_id = ${issueId} AND kind = 'errand_done'`
    expect(event).toMatchObject({ actor: 'factory' })
    expect(await pageCount()).toBe(0)
  })

  test('a screen that fails three times is held with a backoff, then the owner gets it unscreened', async () => {
    const issueId = await workingIssue()
    const raised = await raise(issueId)
    screenAnswer = () => err(portError('gone', 'agw is down'))
    expect(value(await screenErrands(deps))).toEqual([{ errand: raised.errand.id, outcome: 'held' }])
    expect(value(await screenErrands(deps))).toEqual([])
    for (const outcome of ['held', 'reached_owner'] as const) {
      clock.set(new Date(clock.now().getTime() + ERRAND_SCREEN_BACKOFF_MS + 1))
      expect(value(await screenErrands(deps))).toEqual([{ errand: raised.errand.id, outcome }])
    }
    expect(screenCalls.map((call) => call.key)).toEqual(
      [1, 2, 3].map((n) => key('factory-errand', raised.errand.id, n)),
    )
    expect(value(await raiseErrandRead(raised.errand.id))).toMatchObject({ screenBy: 'failed', screenTries: 3 })
    expect(await pageCount()).toBe(1)
    const needs = await readNeeds(db.sql, clock.now())
    expect(needs.items).toMatchObject([{ kind: 'errand' }])
  })

  test('an Issue that stopped waiting finishes the Errand with no event and no page', async () => {
    const issueId = await workingIssue()
    const raised = await raise(issueId)
    await record(issueId, 'cancel', { kind: 'cancelled', payload: { reason: 'no longer needed' }, actor: 'owner' })
    expect(value(await screenErrands(deps))).toEqual([{ errand: raised.errand.id, outcome: 'dropped' }])
    expect(screenCalls).toEqual([])
    expect(value(await raiseErrandRead(raised.errand.id))).toMatchObject({
      doneNote: 'the Issue no longer waits for it',
    })
    expect(await eventsOf(issueId)).not.toContain('errand_done')
    expect(await pageCount()).toBe(0)
  })

  test('a result that arrives after the owner acted is dropped', async () => {
    const issueId = await workingIssue()
    const raised = await raise(issueId)
    screenAnswer = () => ok({ verdict: 'turn_away', reason: 'late' })
    // The owner finishes it while the call is out.
    const screen = errandScreen.screen.bind(errandScreen)
    errandScreen.screen = async (request, callKey) => {
      value(await finishErrand(deps, { errandId: raised.errand.id, note: 'done by hand' }))
      return screen(request, callKey)
    }
    try {
      expect(value(await screenErrands(deps))).toEqual([{ errand: raised.errand.id, outcome: 'dropped' }])
    } finally {
      errandScreen.screen = screen
    }
    expect(value(await raiseErrandRead(raised.errand.id))).toMatchObject({
      doneNote: 'done by hand',
      turnedAwayAt: null,
    })
    expect(await pageCount()).toBe(0)
    expect((await eventsOf(issueId)).filter((kind) => kind === 'errand_done')).toHaveLength(1)
  })

  test('an Errand with no summary is refused with the field named', async () => {
    const issueId = await workingIssue()
    expect(errorOf(await raiseErrand(deps, { issueId, attempt: 1, raw: { detail: 'x' } }))).toMatchObject({
      kind: 'missing_field',
      fields: ['summary'],
    })
  })
})

const raiseErrandRead = (id: ErrandId) =>
  deps.uow.run(async ({ checkpoints }) => {
    const errand = await checkpoints.errand(id)
    return errand ? ok(errand) : err({ kind: 'not_found', what: 'Errand', id } as const)
  })

describe("the owner's line", () => {
  test('a failed send backs off and is tried again for as long as the checkpoint is open; a delivery is recorded once', async () => {
    const issueId = await workingIssue()
    await ask(issueId)
    value(await settleOpen(deps))
    sendResult = () => err(portError('gone', 'ntfy answered 503'))
    expect(value(await sendDuePages(deps)).failed).toHaveLength(1)
    // inside its backoff nothing is due
    expect(value(await sendDuePages(deps))).toEqual({ sent: [], failed: [] })
    // a line that stays down for an hour: the page is still there, failing, and still tried
    for (let attempt = 2; attempt <= 12; attempt++) {
      clock.advance(5 * 60_000)
      expect(value(await sendDuePages(deps)).failed).toHaveLength(1)
    }
    const [page] = await db.sql`SELECT attempts, sent_at, error FROM factory.checkpoint_pages`
    expect(page).toMatchObject({ attempts: 12, sent_at: null, error: 'gone: ntfy answered 503' })
    expect(value(await listPages(deps, 10))[0]?.status).toBe('failing')

    // the line comes back: it goes once
    sendResult = () => ok(undefined)
    clock.advance(5 * 60_000)
    expect(value(await sendDuePages(deps)).sent).toHaveLength(1)
    expect(value(await sendDuePages(deps))).toEqual({ sent: [], failed: [] })
    expect(sent).toHaveLength(1)
    expect(value(await listPages(deps, 10))[0]?.status).toBe('sent')
  })

  test("a send that arrived is never sent again, and an answered checkpoint's page is never sent", async () => {
    const issueId = await workingIssue()
    const { decision } = await ask(issueId)
    value(await settleDecision(deps, decision.id))
    value(await answerDecision(deps, { decisionId: decision.id, answer: 'pino' }))
    expect(value(await sendDuePages(deps))).toEqual({ sent: [], failed: [] })
    const [page] = await db.sql`SELECT cancelled_at FROM factory.checkpoint_pages`
    expect(page?.cancelled_at).not.toBeNull()
  })

  test('a claim that was not recorded lapses and the page goes again (at-least-once)', async () => {
    const issueId = await workingIssue()
    await ask(issueId)
    value(await settleOpen(deps))
    await db.sql`UPDATE factory.checkpoint_pages SET claimed_until = ${new Date('2026-03-01T12:01:00Z')}, attempts = 1`
    expect(value(await sendDuePages(deps)).sent).toHaveLength(0)
    clock.advance(2 * 60_000)
    expect(value(await sendDuePages(deps)).sent).toHaveLength(1)
  })
})

describe('blobs', () => {
  test('a revision is a blob named by its content, written once', async () => {
    const issueId = await workingIssue()
    const a = value(
      await submitArtifact(deps, { issueId, attempt: 1, raw: { kind: 'report', title: 'A', content: 'same' } }),
    )
    const b = value(
      await submitArtifact(deps, { issueId, attempt: 1, raw: { kind: 'report', title: 'B', content: 'same' } }),
    )
    const [x, y] = await db.sql`SELECT blob, sha256 FROM factory.artifact_revisions ORDER BY created_at, artifact_id`
    expect(x?.blob).toBe(y?.blob)
    expect(a.artifact.id).not.toBe(b.artifact.id)
    expect(x?.blob).toBe(`${String(x?.sha256).slice(0, 2)}/${String(x?.sha256)}`)
    expect(errorOf(await fileBlobStore(blobDir).get('../../etc/passwd'))).toMatchObject({ kind: 'refused' })
    expect(errorOf(await fileBlobStore(blobDir).get(`00/${'0'.repeat(64)}`))).toMatchObject({ kind: 'gone' })
  })
})
