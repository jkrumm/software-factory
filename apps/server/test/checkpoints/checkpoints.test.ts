import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { srcHash } from '@software-factory/contract'
import { fileBlobStore } from '../../src/adapters/blobs/filesystem.ts'
import { postgresCheckpointStore } from '../../src/adapters/postgres/checkpoint-store.ts'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { postgresUnitOfWork } from '../../src/adapters/postgres/unit-of-work.ts'
import { postgresWorkStore } from '../../src/adapters/postgres/work-store.ts'
import {
  annotateArtifact,
  deleteAnnotation,
  editAnnotation,
  replyAnnotation,
  answerDecision,
  askDecision,
  finishErrand,
  turnBackErrand,
  giveVerdict,
  listPages,
  markWorthAsking,
  raiseErrand,
  reviseArtifact,
  showArtifact,
  showDecision,
  submitArtifact,
  takeDefault,
} from '../../src/app/checkpoints.ts'
import { type PageDeps, sendDuePages } from '../../src/app/checkpoints-pages.ts'
import { lookAtReview, recheckReviews } from '../../src/app/checkpoints-reviews.ts'
import { requestErrand } from '../../src/app/checkpoints.ts'
import { attachSpec, storeSpecBlob } from '../../src/app/filed-spec.ts'
import { screenErrands } from '../../src/app/checkpoints-errands.ts'
import { screenSpecs } from '../../src/app/checkpoints-specs.ts'
import { type SettleDeps, settleDecision, settleOpen } from '../../src/app/checkpoints-settle.ts'
import { fileIssue, recordIssueEvent } from '../../src/app/issues.ts'
import { readNeeds } from '../../src/read/needs.ts'
import { readSince } from '../../src/read/since.ts'
import type { ArtifactId } from '../../src/domains/checkpoints/artifact.ts'
import { JUDGE_BACKOFF_MS, type DecisionId, type JudgeVerdict } from '../../src/domains/checkpoints/decision.ts'
import { AUTO_RUN_NOTE } from '../../src/kernel/auto-run.ts'
import { ERRAND_SCREEN_BACKOFF_MS, type ErrandId } from '../../src/domains/checkpoints/errand.ts'
import type { ErrandScreenAnswer } from '@software-factory/contract'
import type { ErrandScreenPort, Notifier, JudgePort } from '../../src/domains/checkpoints/ports.ts'
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
let judgeCalls: {
  question: string
  precedents: number
  given: { question: string; answer: string; settledBy: string; worthAsking: null; repo: string }[]
  key: string
}[]
let judgeAnswer: () => Result<JudgeVerdict>
let screenCalls: { errand: string; key: string }[]
let screenDetails: (string | null)[]
let screenAnswer: () => Result<ErrandScreenAnswer>
let sent: string[]
let sendResult: () => Result<void>
/** what happens while a Judge call is out: the world moves on under it */
let duringJudge: (() => Promise<unknown>) | null

const judge: JudgePort = {
  judge: async (input, key) => {
    judgeCalls.push({ question: input.question, precedents: input.precedents.length, given: input.precedents, key })
    await duringJudge?.()
    return judgeAnswer()
  },
}
const errandScreen: ErrandScreenPort = {
  screen: (request, key) => {
    // The port is never called inside a transaction.
    expect(deps.uow.inTransaction()).toBe(false)
    screenCalls.push({ errand: request.errand.id, key })
    screenDetails.push(request.errand.detail)
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
  judgeCalls = []
  judgeAnswer = () => ok({ verdict: 'owner', answer: '', reason: 'a taste question', source: '' })
  screenCalls = []
  screenDetails = []
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
    checks: { run: async () => ({ exit: 0, timedOut: false, output: '' }) },
    judge,
    errandScreen,
    specScreen: { screen: () => Promise.resolve(ok({ verdict: 'pass', reason: "the owner's to read" })) },
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
async function workingIssue(repo = 'example', extra: { checkpoint?: 'spec' | 'gate' } = {}): Promise<IssueId> {
  const filed = value(
    await fileIssue(deps, {
      key: key('filed', deps.ids.next('signal')),
      event: {
        kind: 'filed',
        payload: { repo, title: 'the probe fails', kind: 'bug', origin: 'you', ...extra },
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

  test('a lead Decision whose recommended default is to keep waiting is refused with the Errand hint, nothing stored', async () => {
    const issueId = await workingIssue()
    const waiting = {
      ...FORM,
      question: 'PR #102 is green but needs an approving review',
      recommendation: 'Keep waiting',
      options: [
        { label: 'Keep waiting', reversible: true, cost: 'nothing moves until someone approves' },
        { label: 'Merge around it', reversible: false, cost: 'bypasses the review rule' },
      ],
      noAnswer: { consequence: 'The PR stays open', default: 'Keep waiting', waitMinutes: 60 },
    }
    const error = errorOf(await askDecision(deps, { issueId, attempt: 1, form: waiting }))
    expect(error).toMatchObject({ kind: 'invalid' })
    expect(error.kind === 'invalid' && error.detail).toContain('factory errand raise')
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

describe('a call', () => {
  test('the same call twice is one Decision', async () => {
    const issueId = await workingIssue()
    const first = value(await askDecision(deps, { issueId, attempt: 1, form: FORM, call: 'a-1' }))
    const again = value(await askDecision(deps, { issueId, attempt: 1, form: FORM, call: 'a-1' }))
    expect(again).toMatchObject({ result: 'replayed', decision: { id: first.decision.id } })
    expect(await rows('decisions')).toBe(1)
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
  test("the Judge settles it, with the owner's earlier answers as precedent", async () => {
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
    expect(shown.steps.map((s) => [s.step, s.outcome])).toEqual([['judge', 'answered']])
    expect(await rows('checkpoint_pages')).toBe(0)
  })

  test("the precedents handed to the Judge are the owner's own answers: never the Judge's, a default's or the orchestrator's", async () => {
    const owners = await workingIssue()
    const ownerAsk = await ask(owners, {
      question: 'Which retention for the audit log rows?',
      noAnswer: { consequence: 'Waits.' },
    })
    value(await answerDecision(deps, { decisionId: ownerAsk.decision.id, answer: 'pino' }))

    judgeAnswer = () => ok({ verdict: 'answer', answer: 'winston', reason: 'r', source: 'plan: docs/decisions.md' })
    const judged = await ask(await workingIssue(), { question: 'Which retention for the session log rows?' })
    expect(value(await settleDecision(deps, judged.decision.id))).toMatchObject({ settledBy: 'judge' })

    judgeAnswer = () => ok({ verdict: 'owner', answer: '', reason: 'a taste question', source: '' })
    const defaulted = await ask(await workingIssue(), {
      question: 'Which retention for the job log rows?',
      noAnswer: { consequence: 'Pino stays.', default: 'pino', waitMinutes: 30 },
    })
    value(await settleDecision(deps, defaulted.decision.id))
    clock.advance(31 * 60_000)
    expect(value(await settleDecision(deps, defaulted.decision.id))).toMatchObject({ settledBy: 'default' })

    judgeCalls = []
    const latest = await ask(await workingIssue(), { question: 'Which retention for the access log rows?' })
    value(await settleDecision(deps, latest.decision.id))
    expect(judgeCalls).toHaveLength(1)
    expect(judgeCalls[0]?.given).toEqual([
      {
        question: 'Which retention for the audit log rows?',
        answer: 'pino',
        settledBy: 'owner',
        worthAsking: null,
        repo: 'example',
      },
    ])
  })

  test('a Judge answer the guards reject, an irreversible option included, goes on to the owner', async () => {
    const issueId = await workingIssue()
    judgeAnswer = () => ok({ verdict: 'answer', answer: 'wipe the table', reason: 'tidy', source: 'plan: docs/x.md' })
    const { decision } = await ask(issueId)
    expect(value(await settleDecision(deps, decision.id))).toMatchObject({ status: 'open', settledBy: null })
    const shown = value(await showDecision(deps, decision.id))
    expect(shown.steps.map((s) => [s.step, s.outcome])).toEqual([
      ['judge', 'rejected'],
      ['owner', 'open'],
    ])
    expect(shown.steps[0]?.detail).toContain('cannot be taken back')
  })

  test('a Judge that fails is tried again after the backoff; the owner is reached only after the third failure, with the failure recorded', async () => {
    const issueId = await workingIssue()
    judgeAnswer = () => err(portError('timeout', 'agw did not answer'))
    const { decision } = await ask(issueId)
    const stepsOf = async () =>
      value(await showDecision(deps, decision.id)).steps.map((s) => [s.step, s.outcome, s.tries])

    value(await settleDecision(deps, decision.id))
    expect(await stepsOf()).toEqual([['judge', 'failed', 1]])
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
      ['judge', 'failed', 3],
      ['owner', 'open', 1],
    ])
    expect(shown.steps[0]?.detail).toBe('the Judge could not be reached after 3 tries: timeout: agw did not answer')
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
      ['judge', 'passed'],
      ['default', 'answered'],
    ])
    expect(await rows('checkpoint_pages')).toBe(0)
    expect(await effectsOf(issueId, 'note_lead')).toBe(1)
  })

  test('a Decision whose default is still running down its wait is in Needs once the Judge passed it on, with no page', async () => {
    const issueId = await workingIssue()
    const { decision } = await ask(issueId, {
      noAnswer: { consequence: 'Console logging.', default: 'pino', waitMinutes: 30 },
    })
    value(await settleDecision(deps, decision.id))
    const needs = await readNeeds(db.sql, clock.now())
    expect(needs.items.map((item) => [item.kind, item.id])).toEqual([['decision', decision.id]])
    expect(needs.items[0]?.defaultAt).toBe(new Date(clock.now().getTime() + 30 * 60_000).toISOString())
    expect(await rows('checkpoint_pages')).toBe(0)

    clock.advance(30 * 60_000)
    value(await settleDecision(deps, decision.id))
    expect((await readNeeds(db.sql, clock.now())).items).toEqual([])
  })

  test('a Decision with a default is not in Needs while the Judge still has tries left', async () => {
    const issueId = await workingIssue()
    judgeAnswer = () => err(portError('timeout', 'agw did not answer'))
    const { decision } = await ask(issueId, {
      noAnswer: { consequence: 'Console logging.', default: 'pino', waitMinutes: 600 },
    })
    value(await settleDecision(deps, decision.id))
    expect((await readNeeds(db.sql, clock.now())).items).toEqual([])
  })

  test('a Decision with a default is in Needs, with no page, once the Judge failed its last try', async () => {
    const issueId = await workingIssue()
    judgeAnswer = () => err(portError('timeout', 'agw did not answer'))
    const { decision } = await ask(issueId, {
      noAnswer: { consequence: 'Console logging.', default: 'pino', waitMinutes: 600 },
    })
    for (let i = 0; i < 3; i++) {
      value(await settleDecision(deps, decision.id))
      clock.advance(JUDGE_BACKOFF_MS)
    }
    expect(judgeCalls).toHaveLength(3)
    const needs = await readNeeds(db.sql, clock.now())
    expect(needs.items.map((item) => item.id)).toEqual([decision.id])
    expect(needs.items[0]?.judge).toContain('could not be reached after 3 tries')
    expect(await rows('checkpoint_pages')).toBe(0)
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

  describe('the lead takes its own default', () => {
    const withDefault = { noAnswer: { consequence: 'Console logging.', default: 'pino', waitMinutes: 1440 } }

    test('the Decision is answered as the default, the Issue works again and ship is taken', async () => {
      const issueId = await workingIssue()
      const { decision } = await ask(issueId, withDefault)
      const shipped: AnyIssueEvent = { kind: 'shipped', payload: { attempt: 1 }, actor: 'lead' }
      const early = value(
        await recordIssueEvent(deps, { issueId, key: key('test', issueId, 'ship-early'), event: shipped }),
      )
      expect(early.result).toBe('refused')

      const taken = value(await takeDefault(deps, { decisionId: decision.id, attempt: 1 }))
      expect(taken).toMatchObject({
        decision: {
          settledBy: 'default',
          answer: 'pino',
          source: expect.stringContaining('the lead took the default'),
        },
        issue: { state: 'working' },
      })
      expect(value(await showDecision(deps, decision.id)).steps.map((s) => [s.step, s.outcome])).toContainEqual([
        'default',
        'answered',
      ])
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

      const after = value(await recordIssueEvent(deps, { issueId, key: key('test', issueId, 'ship'), event: shipped }))
      expect(after.issue.state).toBe('watching')
      // the pass finds nothing left to settle
      expect(value(await settleDecision(deps, decision.id))).toMatchObject({ status: 'answered', settledBy: 'default' })
      expect(judgeCalls).toEqual([])
    })

    test('a second call is already_answered, and no event is added', async () => {
      const issueId = await workingIssue()
      const { decision } = await ask(issueId, withDefault)
      value(await takeDefault(deps, { decisionId: decision.id, attempt: 1 }))
      expect(errorOf(await takeDefault(deps, { decisionId: decision.id, attempt: 1 }))).toMatchObject({
        kind: 'already_answered',
        by: 'default',
      })
      expect((await eventsOf(issueId)).filter((kind) => kind === 'answered')).toHaveLength(1)
    })

    test('a Decision with no default, of another attempt or raised by the steward is refused', async () => {
      const issueId = await workingIssue()
      const bare = await ask(issueId)
      expect(errorOf(await takeDefault(deps, { decisionId: bare.decision.id, attempt: 1 }))).toMatchObject({
        kind: 'invalid',
        detail: expect.stringContaining('names no default'),
      })
      const other = await ask(issueId, { ...withDefault, question: 'Which formatter?' })
      expect(errorOf(await takeDefault(deps, { decisionId: other.decision.id, attempt: 2 }))).toMatchObject({
        kind: 'invalid',
        detail: expect.stringContaining('attempt 1'),
      })
      expect(errorOf(await takeDefault(deps, { decisionId: 'decision_none' as DecisionId, attempt: 1 }))).toMatchObject(
        {
          kind: 'not_found',
        },
      )
      expect(await eventsOf(issueId)).not.toContain('answered')
    })
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
    judgeAnswer = () => ok({ verdict: 'answer', answer: 'pino', reason: 'r', source: 'plan: docs/decisions.md' })
    await ask(one)
    clock.advance(1000)
    await ask(two)
    const settled = value(await settleOpen(deps))
    expect(settled.map((s) => s.settledBy)).toEqual(['judge', 'judge'])
    expect(value(await settleOpen(deps))).toEqual([])
  })

  test('a step claimed by a call in flight leaves the Decision alone: no Judge, no owner step, no page', async () => {
    const issueId = await workingIssue()
    const { decision } = await ask(issueId)
    await db.sql`INSERT INTO factory.decision_steps (decision_id, step, claimed_until) VALUES (${decision.id}, 'judge', ${new Date('2026-03-01T12:30:00Z')})`
    expect(value(await settleDecision(deps, decision.id))).toMatchObject({ status: 'open', settledBy: null })
    const shown = value(await showDecision(deps, decision.id))
    expect(shown.steps).toEqual([{ step: 'judge', outcome: null, at: null, detail: null, tries: 1 }])
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
    await db.sql`INSERT INTO factory.decision_steps (decision_id, step, claimed_until) VALUES (${decision.id}, 'judge', ${new Date('2026-03-01T12:30:00Z')})`
    value(await settleDecision(deps, decision.id))
    value(await settleDecision(deps, decision.id))
    expect(judgeCalls).toEqual([])
    expect(await rows('checkpoint_pages')).toBe(0)
    expect(value(await showDecision(deps, decision.id)).steps.map((s) => s.step)).toEqual(['judge'])
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

  test("the owner's delegate gives a Spec's verdict for him; his own verdict replaces it and the lead hears so", async () => {
    const issueId = await workingIssue()
    const { artifact } = value(await submitArtifact(deps, { issueId, attempt: 1, raw: SPEC }))
    const given = value(
      await giveVerdict(deps, {
        artifactId: artifact.id,
        verdict: 'looks_good',
        note: 'technical',
        revision: null,
        by: 'orchestrator',
      }),
    )
    expect(given).toMatchObject({ result: 'applied', issue: { state: 'working' }, verdict: { by: 'orchestrator' } })
    expect(await eventsOf(issueId)).toContain('verdict_given')
    const [sent] =
      await db.sql`SELECT payload->>'text' AS text, actor FROM factory.issue_events WHERE issue_id = ${issueId} AND kind = 'noted'`
    expect(sent).toMatchObject({ actor: 'orchestrator' })
    expect(sent?.text).toContain("The owner's delegate (the orchestrator) gave this verdict on his behalf")

    // a repeat of the delegate's, or its own change of mind, is a replay: the first stands
    const again = value(
      await giveVerdict(deps, {
        artifactId: artifact.id,
        verdict: 'changes',
        note: null,
        revision: null,
        by: 'orchestrator',
      }),
    )
    expect(again).toMatchObject({ result: 'replayed', verdict: { verdict: 'looks_good', by: 'orchestrator' } })

    // the owner reopens it: his verdict replaces the delegate's, and the lead hears one more note
    const reopened = value(
      await giveVerdict(deps, { artifactId: artifact.id, verdict: 'changes', note: 'Name the lock.', revision: null }),
    )
    expect(reopened).toMatchObject({ result: 'applied', verdict: { verdict: 'changes', by: 'owner', neededMe: null } })
    const notes =
      await db.sql`SELECT payload->>'text' AS text FROM factory.issue_events WHERE issue_id = ${issueId} AND kind = 'noted' AND result = 'applied' ORDER BY version`
    expect(notes).toHaveLength(2)
    expect(notes[1]?.text).toContain("The owner reopened his delegate's verdict with his own")
    expect(await effectsOf(issueId, 'note_lead')).toBe(2)

    // his verdict stands against the delegate's, and against his own again
    const last = value(
      await giveVerdict(deps, {
        artifactId: artifact.id,
        verdict: 'looks_good',
        note: null,
        revision: null,
        by: 'orchestrator',
      }),
    )
    expect(last).toMatchObject({ result: 'replayed', verdict: { verdict: 'changes', by: 'owner' } })
  })

  test("the owner reopens his delegate's verdict after the Issue closed: the verdict is replaced, and no lead is told", async () => {
    const issueId = await workingIssue()
    const { artifact } = value(await submitArtifact(deps, { issueId, attempt: 1, raw: SPEC }))
    value(
      await giveVerdict(deps, {
        artifactId: artifact.id,
        verdict: 'looks_good',
        note: null,
        revision: null,
        by: 'orchestrator',
      }),
    )
    await record(issueId, 'cancelled', { kind: 'cancelled', payload: { reason: 'not needed' }, actor: 'owner' })
    const reopened = value(
      await giveVerdict(deps, { artifactId: artifact.id, verdict: 'changes', note: 'No.', revision: null }),
    )
    expect(reopened).toMatchObject({ result: 'applied', verdict: { verdict: 'changes', by: 'owner' } })
    const [row] = await db.sql`SELECT verdict, by FROM factory.verdicts WHERE artifact_id = ${artifact.id}`
    expect(row).toMatchObject({ verdict: 'changes', by: 'owner' })
  })

  test('the delegate gives no verdict on an owner gate, a Concept or a Report', async () => {
    const gated = await workingIssue('example', { checkpoint: 'gate' })
    const gate = value(await submitArtifact(deps, { issueId: gated, attempt: 1, raw: SPEC }))
    expect(
      errorOf(
        await giveVerdict(deps, {
          artifactId: gate.artifact.id,
          verdict: 'looks_good',
          note: null,
          revision: null,
          by: 'orchestrator',
        }),
      ),
    ).toMatchObject({ kind: 'invalid', detail: expect.stringContaining('owner gate') })

    const issueId = await workingIssue()
    const concept = value(
      await submitArtifact(deps, { issueId, attempt: 1, raw: { kind: 'concept', title: 'A concept', content: '# C' } }),
    )
    expect(
      errorOf(
        await giveVerdict(deps, {
          artifactId: concept.artifact.id,
          verdict: 'looks_good',
          note: null,
          revision: null,
          by: 'orchestrator',
        }),
      ),
    ).toMatchObject({ kind: 'invalid', detail: expect.stringContaining('Spec only') })
    const [given] =
      await db.sql`SELECT count(*)::int AS n FROM factory.verdicts WHERE artifact_id IN (${gate.artifact.id}, ${concept.artifact.id})`
    expect(given).toMatchObject({ n: 0 })
  })

  test('a revision after Changes waits again and pages for the new revision; a stale verdict is refused', async () => {
    const issueId = await workingIssue()
    const { artifact } = value(await submitArtifact(deps, { issueId, attempt: 1, raw: SPEC }))
    // a Spec is paged once the screen passes it: the first revision by the workflow
    expect(value(await screenSpecs(deps))).toMatchObject([{ revision: 1, outcome: 'passed' }])
    value(await giveVerdict(deps, { artifactId: artifact.id, verdict: 'changes', note: null, revision: null }))
    const revised = value(
      await reviseArtifact(deps, {
        artifactId: artifact.id,
        attempt: 1,
        content: '# Queue\n\nThe lock is advisory.',
        note: 'named it',
      }),
    )
    // the screen passes both revisions: the first by the workflow, the second by rule (the owner asked for it)
    expect(value(await screenSpecs(deps))).toMatchObject([{ revision: 2, outcome: 'passed' }])
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
    value(await screenSpecs(deps))
    value(await screenSpecs(deps))
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

  test('an annotation keeps the occurrence it hangs on: equal passages are separate comments, and one without it is as before', async () => {
    const issueId = await workingIssue()
    const sentence = 'We keep the queue in Postgres.'
    const artifact = value(
      await submitArtifact(deps, {
        issueId,
        attempt: 1,
        raw: {
          kind: 'report',
          title: 'Notes',
          content: `# Notes\n\n${sentence}\n\n## Options\n\n${sentence}\n\n## Risks\n\n${sentence}`,
        },
      }),
    ).artifact
    const annotate = (raw: Record<string, unknown>) =>
      annotateArtifact(deps, {
        artifactId: artifact.id,
        revision: null,
        author: 'owner',
        raw: { quote: sentence, ...raw },
      })
    value(await annotate({ comment: 'why?', occurrence: 1, prefix: 'Options ', suffix: ' Risks' }))
    // the same words on the third occurrence are another comment, not a replay of the second
    value(await annotate({ comment: 'why?', occurrence: 2, prefix: 'Risks ', suffix: '' }))
    expect(value(await annotate({ comment: 'why?', occurrence: 2, prefix: 'Risks ', suffix: '' }))).toMatchObject({
      result: 'replayed',
    })
    // a comment made without them keeps its old identity and resolves to the first occurrence
    value(await annotate({ comment: 'why?' }))
    expect(value(await annotate({ comment: 'why?' }))).toMatchObject({ result: 'replayed' })
    expect(await rows('annotations')).toBe(3)

    const stored = await showAnnotations(artifact.id)
    expect(stored.map((a) => [a.occurrence, a.prefix, a.suffix])).toEqual([
      [1, 'Options ', ' Risks'],
      [2, 'Risks ', null],
      [null, null, null],
    ])
    // a revision that inserts a paragraph above keeps all three anchored, and their context with them
    value(
      await reviseArtifact(deps, {
        artifactId: artifact.id,
        attempt: null,
        content: `# Notes\n\nNew paragraph.\n\n${sentence}\n\n## Options\n\n${sentence}\n\n## Risks\n\n${sentence}`,
        note: null,
      }),
    )
    const shown = value(await showArtifact(deps, { artifactId: artifact.id, revision: null }))
    expect(shown.annotations.map((a) => [a.anchor, a.annotation.occurrence, a.annotation.prefix])).toEqual([
      ['anchored', 1, 'Options '],
      ['anchored', 2, 'Risks '],
      ['anchored', null, null],
    ])
  })

  test('an annotation hangs on a picture: whole or at a spot, each its own comment, and it follows the picture through a revision', async () => {
    const issueId = await workingIssue()
    const shots = (...pictures: [src: string, alt: string][]) =>
      pictures.map(([src, alt]) => `<img src="${src}" alt="${alt}">`).join('<p>between</p>')
    const artifact = value(
      await submitArtifact(deps, {
        issueId,
        attempt: 1,
        raw: {
          kind: 'report',
          title: 'Screens',
          contentFormat: 'html',
          content: `<h1>Screens</h1>${shots(['/1.png', 'one'], ['/2.png', 'two'], ['/3.png', 'three'])}`,
        },
      }),
    ).artifact
    const annotate = (raw: Record<string, unknown>) =>
      annotateArtifact(deps, { artifactId: artifact.id, revision: null, author: 'owner', raw })
    const second = { occurrence: 1, srcHash: srcHash('/2.png'), label: 'two' }
    const third = { occurrence: 2, srcHash: srcHash('/3.png'), label: 'three', x: 0.5, y: 0.25 }
    value(await annotate({ comment: 'crop it', image: second }))
    value(await annotate({ comment: 'crop it', image: third }))
    expect(value(await annotate({ comment: 'crop it', image: second }))).toMatchObject({ result: 'replayed' })
    // a quote sent along is ignored: the picture is the identity
    expect(value(await annotate({ comment: 'crop it', quote: 'something else', image: second }))).toMatchObject({
      result: 'replayed',
    })
    // the same words on another picture, or on another spot of the same one, are other comments
    value(
      await annotate({
        comment: 'crop it',
        image: { ...second, occurrence: 0, srcHash: srcHash('/1.png'), label: 'one' },
      }),
    )
    value(await annotate({ comment: 'crop it', image: { ...third, x: 0.1 } }))
    expect(await rows('annotations')).toBe(4)
    // a comment on text next to them is as before
    value(await annotate({ comment: 'why?', quote: 'Screens' }))
    expect(value(await annotate({ comment: 'why?', quote: 'Screens' }))).toMatchObject({ result: 'replayed' })
    expect(await rows('annotations')).toBe(5)

    const imageOf = async (revision: number | null) => {
      const shown = value(await showArtifact(deps, { artifactId: artifact.id, revision }))
      return shown.annotations.map((a) => ({
        quote: a.annotation.quote,
        image: a.annotation.image,
        occurrence: a.annotation.occurrence,
        anchor: a.anchor,
      }))
    }
    const first = await imageOf(null)
    expect(first.find((a) => a.image?.occurrence === 1)).toEqual({
      quote: 'Image 2: two',
      image: { ...second, x: null, y: null },
      occurrence: null,
      anchor: 'anchored',
    })
    expect(first.find((a) => a.image?.x === 0.5)).toMatchObject({
      quote: 'Image 3: three · spot 50% / 25%',
      image: third,
      anchor: 'anchored',
    })
    expect(first.find((a) => a.image === null)).toMatchObject({ quote: 'Screens', anchor: 'anchored' })
    expect((await showAnnotations(artifact.id)).find((a) => a.image?.occurrence === 1)?.image).toEqual({
      ...second,
      x: null,
      y: null,
    })

    // a revision that reorders the pictures keeps both comments anchored
    value(
      await reviseArtifact(deps, {
        artifactId: artifact.id,
        attempt: null,
        content: `<h1>Screens</h1>${shots(['/3.png', 'three'], ['/1.png', 'one'], ['/2.png', 'two'])}`,
        note: null,
      }),
    )
    expect((await imageOf(null)).every((a) => a.anchor === 'anchored')).toBe(true)

    // a revision that replaces the second picture moves its comment to Unanchored, and only that one
    value(
      await reviseArtifact(deps, {
        artifactId: artifact.id,
        attempt: null,
        content: `<h1>Screens</h1>${shots(['/1.png', 'one'], ['/9.png', 'nine'], ['/3.png', 'three'])}`,
        note: null,
      }),
    )
    expect(
      (await imageOf(null))
        .map((a) => [a.image?.srcHash === srcHash('/2.png') ? 'second' : (a.image?.label ?? 'text'), a.anchor])
        .sort(),
    ).toEqual([
      ['one', 'anchored'],
      ['second', 'unanchored'],
      ['text', 'anchored'],
      ['three', 'anchored'],
      ['three', 'anchored'],
    ])
  })

  test('a picture comment on a Markdown artifact hangs on its ![alt](src) images', async () => {
    const issueId = await workingIssue()
    const artifact = value(
      await submitArtifact(deps, {
        issueId,
        attempt: 1,
        raw: {
          kind: 'report',
          title: 'Notes',
          content: '# Notes\n\n![a](https://x.test/1.png)\n\n![b](https://x.test/2.png "Second")',
        },
      }),
    ).artifact
    const image = { occurrence: 1, srcHash: srcHash('https://x.test/2.png'), label: 'b' }
    value(
      await annotateArtifact(deps, {
        artifactId: artifact.id,
        revision: null,
        author: 'owner',
        raw: { comment: 'blurry', image },
      }),
    )
    expect(value(await showArtifact(deps, { artifactId: artifact.id, revision: null })).annotations).toMatchObject([
      { anchor: 'anchored', annotation: { quote: 'Image 2: b', image } },
    ])
    value(
      await reviseArtifact(deps, {
        artifactId: artifact.id,
        attempt: null,
        content: '# Notes\n\n![b](https://x.test/2.png)\n\n![a](https://x.test/1.png)',
        note: null,
      }),
    )
    expect(value(await showArtifact(deps, { artifactId: artifact.id, revision: null })).annotations[0]?.anchor).toBe(
      'anchored',
    )
    value(
      await reviseArtifact(deps, {
        artifactId: artifact.id,
        attempt: null,
        content: '# Notes\n\n![a](https://x.test/1.png)',
        note: null,
      }),
    )
    expect(value(await showArtifact(deps, { artifactId: artifact.id, revision: null })).annotations[0]?.anchor).toBe(
      'unanchored',
    )
  })

  test('the lead answers an annotation with a disposition: its own attempt only, a note for a deferral and a decline, a repeat is a replay', async () => {
    const issueId = await workingIssue()
    const artifact = value(
      await submitArtifact(deps, {
        issueId,
        attempt: 1,
        raw: { kind: 'spec', title: 'Plan', content: 'Retries are three.' },
      }),
    ).artifact
    value(
      await annotateArtifact(deps, {
        artifactId: artifact.id,
        revision: null,
        author: 'owner',
        raw: { quote: 'Retries are three', comment: 'make it five' },
      }),
    )
    value(
      await annotateArtifact(deps, {
        artifactId: artifact.id,
        revision: null,
        author: 'lead',
        raw: { quote: 'Retries', comment: 'a lead note' },
      }),
    )
    const [mine, leads] = await showAnnotations(artifact.id)
    expect(mine?.disposition).toBeNull()
    const reply = (raw: unknown, attempt: number | null = 1, annotationId = mine?.id ?? '') =>
      replyAnnotation(deps, { artifactId: artifact.id, annotationId, attempt, raw })

    expect(errorOf(await reply({ disposition: 'maybe' }))).toMatchObject({ kind: 'missing_field' })
    expect(errorOf(await reply({ disposition: 'declined' }))).toMatchObject({ kind: 'missing_field' })
    expect(errorOf(await reply({ disposition: 'deferred', note: '  ' }))).toMatchObject({ kind: 'missing_field' })
    expect(errorOf(await reply({ disposition: 'applied' }, null))).toMatchObject({ kind: 'missing_field' })
    expect(errorOf(await reply({ disposition: 'applied' }, 2))).toMatchObject({ kind: 'invalid' })
    expect(errorOf(await reply({ disposition: 'applied' }, 1, leads?.id))).toMatchObject({ kind: 'invalid' })
    expect(errorOf(await reply({ disposition: 'applied' }, 1, 'annotation_none'))).toMatchObject({ kind: 'not_found' })

    expect(value(await reply({ disposition: 'declined', note: '  Redis adds a second store.  ' }))).toMatchObject({
      result: 'applied',
      issue: null,
    })
    const [declined] = await showAnnotations(artifact.id)
    expect(declined).toMatchObject({ disposition: 'declined', dispositionNote: 'Redis adds a second store.' })
    expect(declined?.disposedAt).not.toBeNull()
    expect(value(await reply({ disposition: 'declined', note: 'Redis adds a second store.' }))).toMatchObject({
      result: 'replayed',
    })
    // a later answer replaces the earlier one; an applied one needs no note
    expect(value(await reply({ disposition: 'applied' }))).toMatchObject({ result: 'applied' })
    expect((await showAnnotations(artifact.id))[0]).toMatchObject({ disposition: 'applied', dispositionNote: '' })
    // new words from the owner are not answered by the reply to the old ones
    value(
      await editAnnotation(deps, {
        artifactId: artifact.id,
        annotationId: mine?.id ?? '',
        raw: { comment: 'drop retries' },
      }),
    )
    expect((await showAnnotations(artifact.id))[0]).toMatchObject({
      comment: 'drop retries',
      disposition: null,
      dispositionNote: null,
      disposedAt: null,
    })
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

  test('a Spec filed with a queued Issue is revised without an attempt; once a lead works it, the attempt is needed', async () => {
    const filed = value(
      await fileIssue(deps, {
        key: key('filed', deps.ids.next('signal')),
        event: {
          kind: 'filed',
          payload: { repo: 'example', title: 'a gated change', kind: 'feature', origin: 'you', checkpoint: 'gate' },
          actor: 'factory',
        },
      }),
    )
    const id = filed.issue.id
    await record(id, 'settled', { kind: 'settled', payload: {}, actor: 'factory' })
    const stored = value(await storeSpecBlob(deps, { content: '# v1', given: undefined, fallback: 'a gated change' }))
    value(await deps.uow.run(({ checkpoints }) => attachSpec(deps, checkpoints, { id, repo: 'example' }, stored)))
    const artifactId = (await postgresCheckpointStore(db.sql).artifactByKey(key('filed-spec', id)))?.id as ArtifactId
    const revised = value(await reviseArtifact(deps, { artifactId, attempt: null, content: '# v2', note: null }))
    expect(revised.revisions).toHaveLength(2)
    expect(await eventsOf(id)).toEqual(['filed', 'settled'])
    // the owner sees the new revision: the screen passes it, and it is the one he reads and gives his verdict on
    expect(value(await screenSpecs(deps))).toMatchObject([{ revision: 2, outcome: 'passed' }])
    expect(value(await showArtifact(deps, { artifactId, revision: null }))).toMatchObject({ revision: 2 })
    expect(
      errorOf(await giveVerdict(deps, { artifactId, verdict: 'looks_good', note: null, revision: 1 })),
    ).toMatchObject({ kind: 'invalid' })
    await record(id, 'admitted', { kind: 'admitted', payload: {}, actor: 'factory' })
    await record(id, 'lead_started', {
      kind: 'lead_started',
      payload: { attempt: 1, terminal: 't1' },
      actor: 'factory',
    })
    expect(
      errorOf(await reviseArtifact(deps, { artifactId, attempt: null, content: '# v3', note: null })),
    ).toMatchObject({
      kind: 'missing_field',
    })
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
    value(await screenSpecs(deps))
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
  const APPROVE = { summary: 'Approve the App Store build', need: 'hands', tried: 'looked for an API key route: none' }
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

  test('a root step for the MacBook is raised and reaches the owner by rule, without the screen model', async () => {
    const issueId = await workingIssue()
    const raised = await raise(issueId, {
      summary: 'Install the launchd daemon and sysctl',
      need: 'hands',
      tried: 'looked for a way without root: none',
      cmd: 'op read "op://Private/mac-mini-server/password" --account <account> | sudo -S make install-daemon',
      host: 'macbook',
    })
    expect(raised).toMatchObject({ result: 'applied' })
    expect(value(await screenErrands(deps))).toEqual([{ errand: raised.errand.id, outcome: 'reached_owner' }])
    expect(screenCalls).toEqual([])
    expect(await pageCount()).toBe(1)
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

  test('the orchestrator closes an Errand only as done and with evidence, recorded as itself', async () => {
    const issueId = await workingIssue()
    const raised = await raise(issueId)
    expect(value(await screenErrands(deps))).toEqual([{ errand: raised.errand.id, outcome: 'reached_owner' }])

    const bare = await finishErrand(deps, { errandId: raised.errand.id, note: 'did it', by: 'orchestrator' })
    expect(bare).toMatchObject({ ok: false, error: { kind: 'invalid' } })
    const needless = await finishErrand(deps, {
      errandId: raised.errand.id,
      note: null,
      outcome: 'not_needed',
      by: 'orchestrator',
      confirmedBy: 'the operator',
    })
    expect(needless).toMatchObject({ ok: false, error: { kind: 'invalid' } })
    expect(value(await raiseErrandRead(raised.errand.id)).doneAt).toBeNull()

    // an approval Errand is the owner's yes: his delegate does not give it
    await db.sql`UPDATE factory.errands SET need = 'approval' WHERE id = ${raised.errand.id}`
    const approval = await finishErrand(deps, {
      errandId: raised.errand.id,
      note: null,
      by: 'orchestrator',
      confirmedBy: 'the operator',
    })
    expect(approval).toMatchObject({ ok: false, error: { kind: 'invalid' } })
    // an approval by rule that has no stored need yet (the settle pass has not reached it) is the same
    await db.sql`
      UPDATE factory.errands SET need = NULL, command = 'ssh mini ''make -C ~/gate deploy-release SHA=feedbeef'''
      WHERE id = ${raised.errand.id}`
    expect(
      await finishErrand(deps, {
        errandId: raised.errand.id,
        note: null,
        by: 'orchestrator',
        confirmedBy: 'the operator',
      }),
    ).toMatchObject({ ok: false, error: { kind: 'invalid' } })
    await db.sql`UPDATE factory.errands SET need = 'hands', command = NULL WHERE id = ${raised.errand.id}`

    const done = value(
      await finishErrand(deps, {
        errandId: raised.errand.id,
        note: 'archive moved',
        by: 'orchestrator',
        confirmedBy: 'the MacBook operator, who listed the folder',
      }),
    )
    expect(done).toMatchObject({
      result: 'applied',
      errand: {
        closedBy: 'orchestrator',
        closedKind: 'done',
        doneNote: 'confirmed by the MacBook operator, who listed the folder · archive moved',
      },
    })
    const events = await db.sql`
      SELECT kind, actor FROM factory.issue_events WHERE issue_id = ${issueId} AND kind IN ('errand_done', 'noted') ORDER BY id`
    expect(events.filter((e: { kind: string }) => e.kind === 'errand_done')).toMatchObject([{ actor: 'orchestrator' }])
    expect(events.some((e: { actor: string }) => e.actor === 'owner')).toBe(false)
    expect(await effectsOf(issueId, 'note_lead')).toBe(1)
  })

  test('an auto-run close says the MacBook ran it by itself, and is stored with its evidence', async () => {
    const issueId = await workingIssue()
    const raised = await raise(issueId)
    expect(value(await screenErrands(deps))).toEqual([{ errand: raised.errand.id, outcome: 'reached_owner' }])

    const done = value(
      await finishErrand(deps, {
        errandId: raised.errand.id,
        note: 'ran by itself on the MacBook (auto-run secrets-seed, exit 0): 125 refs sealed',
        by: 'orchestrator',
        confirmedBy:
          'ask-human: auto-run class secrets-seed, granted by the owner on the MacBook, ran it with no dialog',
      }),
    )
    expect(done).toMatchObject({
      errand: { closedBy: 'orchestrator', closedKind: 'done' },
    })
    expect(done.errand.doneNote).toStartWith(AUTO_RUN_NOTE)
    const noted = await db.sql`
      SELECT payload->>'text' AS text FROM factory.issue_events WHERE issue_id = ${issueId} AND kind = 'noted' ORDER BY id DESC LIMIT 1`
    expect(noted[0].text).toContain(
      "ran by itself on the owner's MacBook (auto-run class secrets-seed), with no dialog and no owner",
    )
    expect(noted[0].text).not.toContain('delegate')
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

  describe('a request from ask-human', () => {
    const ask = async (text: string, command: string | null = null) =>
      value(
        await requestErrand(deps, {
          raw: { source: 'ask-human', need: 'hands', text, ...(command ? { command } : {}) },
        }),
      )

    test('waits for the screen like a lead Errand: held out of Needs-you, then reaches the owner without a page', async () => {
      const made = await ask('Approve the sign-in dialog on the MacBook')
      expect(made.errand.reachedOwnerAt).toBeNull()
      expect((await readNeeds(db.sql, clock.now())).items).toEqual([])
      expect(value(await screenErrands(deps))).toEqual([{ errand: made.errand.id, outcome: 'reached_owner' }])
      expect(screenCalls).toEqual([{ errand: made.errand.id, key: key('factory-errand', made.errand.id, 1) }])
      expect(await pageCount()).toBe(0)
      expect((await readNeeds(db.sql, clock.now())).items).toMatchObject([
        { kind: 'errand', id: made.errand.id, issue: null, judge: 'a person must approve it', source: 'ask-human' },
      ])
    })

    test('one an agent can do is turned away with the reason, as the Errand note', async () => {
      const made = await ask('Merge the pull request', 'gh pr merge 12')
      screenAnswer = () => ok({ verdict: 'turn_away', reason: 'gh can merge it with a token' })
      expect(value(await screenErrands(deps))).toEqual([{ errand: made.errand.id, outcome: 'turned_away' }])
      expect(value(await raiseErrandRead(made.errand.id))).toMatchObject({
        doneNote: 'gh can merge it with a token',
        closedKind: 'turned_away',
        screenBy: 'judge',
      })
      expect((await readNeeds(db.sql, clock.now())).items).toEqual([])
    })

    test('a MacBook command reaches the screen with the fact that the mini cannot run it, and a pass reaches the owner', async () => {
      const made = await requestErrand(deps, {
        raw: {
          source: 'ask-human',
          need: 'hands',
          text: 'Deploy Tinycast Home Lights',
          command: 'cd ~/SourceRoot/tinycast-extensions && git pull --ff-only && make deploy',
          where: 'macbook',
        },
      }).then(value)
      expect(value(await screenErrands(deps))).toEqual([{ errand: made.errand.id, outcome: 'reached_owner' }])
      const [detail] = screenDetails
      expect(detail).toContain('Command to run (macbook): cd ~/SourceRoot/tinycast-extensions')
      expect(detail).toContain('The mini has no shell on it')
    })

    test('a long MacBook request still carries the fact to the screen', async () => {
      const made = await requestErrand(deps, {
        raw: {
          source: 'ask-human',
          need: 'hands',
          text: `Deploy it\n${'x'.repeat(3800)}`,
          command: `make deploy # ${'y'.repeat(1500)}`,
          where: 'macbook',
        },
      }).then(value)
      expect(value(await screenErrands(deps))).toEqual([{ errand: made.errand.id, outcome: 'reached_owner' }])
      expect(screenDetails[0]).toContain('The mini has no shell on it')
      expect(screenDetails[0]?.length).toBeLessThanOrEqual(4000)
    })

    test('the first look by rule turns away a plain command without calling the screen', async () => {
      const made = await ask('Run `make deploy` on the host')
      expect(value(await screenErrands(deps))).toEqual([{ errand: made.errand.id, outcome: 'turned_away' }])
      expect(screenCalls).toEqual([])
    })
  })

  test('a rule turns away a command a token can run without calling the screen', async () => {
    const issueId = await workingIssue()
    const raised = await raise(issueId, {
      summary: 'Run the migration',
      detail: 'Run `make deploy` on the host',
      need: 'hands',
      tried: 'nothing yet',
    })
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

  test('an Errand a host class covers is refused at the raise: nothing is raised and the route is named', async () => {
    const issueId = await workingIssue()
    for (const [summary, route] of [
      ['Mint a door token and set the door route for kuma', 'factory door token new'],
      ['Install exiftool and magick on the mini', 'Makefile target'],
      ['Point the owner at the verdict: the Report does not show in Needs you', '--repo software-factory'],
    ] as const) {
      const refused = errorOf(
        await raiseErrand(deps, { issueId, attempt: 1, raw: { summary, need: 'hands', tried: 'nothing' } }),
      )
      expect(refused).toMatchObject({ kind: 'invalid' })
      expect(JSON.stringify(refused)).toContain(route)
    }
    expect(await rows('errands')).toBe(0)
    expect(await eventsOf(issueId)).not.toContain('errand_raised')
  })

  test('what the lead tried is never read by the rule screen as the ask', async () => {
    const issueId = await workingIssue()
    const raised = await raise(issueId, {
      summary: 'Rotate the OAuth consent in the Google console',
      need: 'hands',
      tried: '`gh api /repos/x` returned 403',
    })
    expect(raised.errand.detail).toBeNull()
    expect(value(await screenErrands(deps))).not.toEqual([{ errand: raised.errand.id, outcome: 'turned_away' }])
  })

  test('the same call twice is one Errand, whatever its summary', async () => {
    const issueId = await workingIssue()
    const first = value(await raiseErrand(deps, { issueId, attempt: 1, raw: APPROVE, call: 'e-1' }))
    const second = value(
      await raiseErrand(deps, { issueId, attempt: 1, raw: { ...APPROVE, summary: 'Another words' }, call: 'e-1' }),
    )
    expect(second).toMatchObject({ result: 'replayed', errand: { id: first.errand.id } })
    expect(await rows('errands')).toBe(1)
  })

  test('an Errand with no summary is refused with the field named', async () => {
    const issueId = await workingIssue()
    expect(
      errorOf(
        await raiseErrand(deps, { issueId, attempt: 1, raw: { detail: 'x', need: 'hands', tried: 'a command' } }),
      ),
    ).toMatchObject({
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

describe('a Concept or Spec the owner has not answered for a day', () => {
  const SPEC = { kind: 'spec', title: 'The queue spec', content: '# Queue\n\nOne page.' }
  const HOUR = 3_600_000
  const later = (hours: number) => clock.set(new Date(clock.now().getTime() + hours * HOUR))
  const rechecks = async () =>
    await db.sql`SELECT checkpoint_id, kind, outcome, by, through_version FROM factory.checkpoint_rechecks ORDER BY at, checkpoint_id`

  test('a flagged Issue takes its lead its defaults after the wait: a verdict by the factory, one note, the lead goes on', async () => {
    const issueId = await workingIssue('example', { checkpoint: 'spec' })
    const { artifact } = value(await submitArtifact(deps, { issueId, attempt: 1, raw: SPEC }))
    later(23)
    expect(value(await recheckReviews(deps))).toEqual([])
    later(2)
    expect(value(await recheckReviews(deps))).toEqual([{ artifact: artifact.id, outcome: 'defaulted' }])

    const [issue] = await db.sql`SELECT state FROM factory.issues WHERE id = ${issueId}`
    expect(issue).toMatchObject({ state: 'working' })
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
    const [verdict] = await db.sql`SELECT verdict, note, by FROM factory.verdicts WHERE artifact_id = ${artifact.id}`
    expect(verdict).toMatchObject({ verdict: 'looks_good', by: 'factory' })
    expect(String(verdict.note)).toContain('no verdict in 24 hours')
    const [note] = await db.sql`
      SELECT payload->>'text' AS text, actor FROM factory.issue_events WHERE issue_id = ${issueId} AND kind = 'noted' AND actor = 'factory'`
    expect(String(note.text)).toStartWith('No verdict from the owner on "The queue spec"')
    expect(await rechecks()).toEqual([
      { checkpoint_id: artifact.id, kind: 'artifact', outcome: 'settled', by: 'factory', through_version: 1 },
    ])

    // a second pass changes nothing
    expect(value(await recheckReviews(deps))).toEqual([])
    expect(await effectsOf(issueId, 'note_lead')).toBe(1)
  })

  test.each(['spec', 'concept'] as const)(
    'an unflagged Issue takes its defaults for a %s after the wait too, and the lead goes on',
    async (kind) => {
      const issueId = await workingIssue()
      const { artifact } = value(await submitArtifact(deps, { issueId, attempt: 1, raw: { ...SPEC, kind } }))
      later(23)
      expect(value(await recheckReviews(deps))).toEqual([])
      later(2)
      expect(value(await recheckReviews(deps))).toEqual([{ artifact: artifact.id, outcome: 'defaulted' }])
      const [verdict] = await db.sql`SELECT verdict, note FROM factory.verdicts WHERE artifact_id = ${artifact.id}`
      expect(verdict).toMatchObject({ verdict: 'looks_good' })
      expect(String(verdict.note)).toContain('no verdict in 24 hours')
      const [issue] = await db.sql`SELECT state FROM factory.issues WHERE id = ${issueId}`
      expect(issue).toMatchObject({ state: 'working' })
      expect(await effectsOf(issueId, 'note_lead')).toBe(1)
      expect((await rechecks())[0]).toMatchObject({ kind: 'artifact', outcome: 'settled', by: 'factory' })
      // a later pass leaves it, and no second page was ever planned
      later(48)
      expect(value(await recheckReviews(deps))).toEqual([])
      // a Spec nobody screened was never paged; a Concept is paged at once
      expect(await rows('checkpoint_pages')).toBe(kind === 'concept' ? 1 : 0)
    },
  )

  test('an owner gate takes no default: its wait runs past the hours, and only the owner gives the verdict', async () => {
    const issueId = await workingIssue('example', { checkpoint: 'gate' })
    const { artifact } = value(await submitArtifact(deps, { issueId, attempt: 1, raw: SPEC }))
    later(25)
    expect(value(await recheckReviews(deps))).toEqual([])
    later(24 * 30)
    expect(value(await recheckReviews(deps))).toEqual([])
    const [waiting] = await db.sql`SELECT state, wait_reason FROM factory.issues WHERE id = ${issueId}`
    expect(waiting).toMatchObject({ state: 'waiting', wait_reason: 'review' })
    expect(await db.sql`SELECT 1 FROM factory.verdicts WHERE artifact_id = ${artifact.id}`).toHaveLength(0)

    const given = value(
      await giveVerdict(deps, { artifactId: artifact.id, verdict: 'looks_good', note: null, revision: null }),
    )
    expect(given.verdict.by).toBe('owner')
    const [verdict] = await db.sql`SELECT by FROM factory.verdicts WHERE artifact_id = ${artifact.id}`
    expect(verdict).toMatchObject({ by: 'owner' })
    const [after] = await db.sql`SELECT state FROM factory.issues WHERE id = ${issueId}`
    expect(after).toMatchObject({ state: 'working' })
  })

  test('an owner gate in Needs you says that no default is taken', async () => {
    const issueId = await workingIssue('example', { checkpoint: 'gate' })
    value(await submitArtifact(deps, { issueId, attempt: 1, raw: { ...SPEC, kind: 'concept' } }))
    const needs = await readNeeds(db.sql, clock.now())
    const review = needs.items.find((item) => item.kind === 'review' && item.issue === issueId)
    expect(review?.summary).toContain('An owner gate: no default is taken')
  })

  test('an owner gate that closed is still withdrawn, and triage never turns it into a plain Spec', async () => {
    const issueId = await workingIssue('example', { checkpoint: 'gate' })
    const { artifact } = value(await submitArtifact(deps, { issueId, attempt: 1, raw: SPEC }))
    await record(issueId, 'cancelled', { kind: 'cancelled', payload: { reason: 'not needed' }, actor: 'owner' })
    later(25)
    expect(value(await recheckReviews(deps))).toEqual([{ artifact: artifact.id, outcome: 'withdrawn' }])
    const [verdict] = await db.sql`SELECT verdict, by FROM factory.verdicts WHERE artifact_id = ${artifact.id}`
    expect(verdict).toMatchObject({ verdict: 'no_longer_applies', by: 'factory' })
  })

  test('a Spec whose Issue closed meanwhile is withdrawn, and its pages are never sent', async () => {
    const issueId = await workingIssue('example', { checkpoint: 'spec' })
    const { artifact } = value(await submitArtifact(deps, { issueId, attempt: 1, raw: SPEC }))
    await record(issueId, 'cancelled', { kind: 'cancelled', payload: { reason: 'not needed' }, actor: 'owner' })
    later(25)
    expect(value(await recheckReviews(deps))).toEqual([{ artifact: artifact.id, outcome: 'withdrawn' }])
    const [verdict] = await db.sql`SELECT verdict, note FROM factory.verdicts WHERE artifact_id = ${artifact.id}`
    expect(verdict).toMatchObject({ verdict: 'no_longer_applies', note: 'the Issue is closed' })
    expect((await rechecks())[0]).toMatchObject({ outcome: 'withdrawn' })
  })

  test('a revision after Changes is looked at again from its own hand-over', async () => {
    const issueId = await workingIssue('example', { checkpoint: 'spec' })
    const { artifact } = value(await submitArtifact(deps, { issueId, attempt: 1, raw: SPEC }))
    value(await giveVerdict(deps, { artifactId: artifact.id, verdict: 'changes', note: null, revision: null }))
    later(30)
    value(await reviseArtifact(deps, { artifactId: artifact.id, attempt: 1, content: '# Queue\n\nv2', note: 'x' }))
    later(23)
    expect(value(await recheckReviews(deps))).toEqual([])
    later(2)
    expect(value(await recheckReviews(deps))).toEqual([{ artifact: artifact.id, outcome: 'defaulted' }])
  })

  test('lookAtReview: a Concept or Spec is defaulted whatever the checkpoint, withdrawn when its Issue moved on', () => {
    const wait = {
      artifact: 'artifact_1',
      issueId: 'issue_1' as IssueId,
      kind: 'concept' as const,
      title: 't',
      revision: 1,
      at: new Date(0),
      filed: false,
    }
    expect(lookAtReview({ wait, closed: false, waiting: true }).outcome).toBe('defaulted')
    expect(lookAtReview({ wait: { ...wait, kind: 'spec' }, closed: false, waiting: true }).outcome).toBe('defaulted')
    expect(lookAtReview({ wait, closed: false, waiting: false }).outcome).toBe('withdrawn')
    expect(lookAtReview({ wait, closed: true, waiting: true }).outcome).toBe('withdrawn')
  })
})

describe('decided by rule before the owner (issue 1714)', () => {
  const REPORT = 'mount | grep smbfs'
  const pageCount = async () => rows('checkpoint_pages')
  const raise = async (issueId: IssueId, raw: Record<string, unknown>) =>
    raiseErrand(deps, { issueId, attempt: 1, raw: { need: 'hands', tried: 'looked for a route: none', ...raw } })
  let verbCalls: string[][]
  let verbAnswer: () => Result<{ exit: number; output: string }>

  beforeEach(() => {
    verbCalls = []
    verbAnswer = () => ok({ exit: 0, output: '//host/share on /Volumes/share (smbfs)\n' })
    deps.macbook = {
      run: (verb) => {
        // the port is never called inside a transaction
        expect(deps.uow.inTransaction()).toBe(false)
        verbCalls.push(verb.verb === 'dotfiles-sync' ? [verb.verb] : [verb.verb, verb.name])
        return Promise.resolve(verbAnswer())
      },
    }
  })

  test('(e) an Errand with no need is refused and nothing is raised', async () => {
    const issueId = await workingIssue()
    const refused = errorOf(
      await raiseErrand(deps, { issueId, attempt: 1, raw: { summary: 'Approve the build', tried: 'looked' } }),
    )
    expect(refused).toMatchObject({ kind: 'missing_field' })
    expect(JSON.stringify(refused)).toContain('--need')
    expect(await rows('errands')).toBe(0)
    expect(await eventsOf(issueId)).not.toContain('errand_raised')
  })

  test('(e) a place with no command is refused', async () => {
    const issueId = await workingIssue()
    const refused = errorOf(await raise(issueId, { summary: 'Run the thing', need: 'place' }))
    expect(JSON.stringify(refused)).toContain('--cmd')
    expect(await rows('errands')).toBe(0)
  })

  test('(a) a command that runs wholly on the mini is refused with the words to run it yourself', async () => {
    const issueId = await workingIssue()
    const refused = errorOf(
      await raise(issueId, {
        summary: 'Install the deploy gate',
        cmd: "ssh mini 'make -C ~/SourceRoot/dotfiles deploy-gate-install'",
        need: 'place',
      }),
    )
    expect(JSON.stringify(refused)).toContain('run it yourself')
    expect(await rows('errands')).toBe(0)
    // the gate's release stays his yes
    const release = await raise(issueId, {
      summary: 'Release the commit',
      cmd: "ssh mini 'make -C ~/gate deploy-release SHA=feedbeef'",
      need: 'place',
    })
    expect(value(release)).toMatchObject({ result: 'applied' })
  })

  test('(d) the same need turned back is not raised again for three days, and his note is the refusal', async () => {
    const issueId = await workingIssue()
    const body = { summary: 'The mini needs its planned restart', need: 'hands' }
    const first = value(await raise(issueId, body))
    value(
      await turnBackErrand(deps, { errandId: first.errand.id, note: 'Not tonight: restart on Sunday', by: 'owner' }),
    )
    expect(await eventsOf(issueId)).toContain('errand_turned_back')
    // the next lead, on another Issue, asks the same thing
    const next = await workingIssue()
    const again = errorOf(await raise(next, body))
    expect(JSON.stringify(again)).toContain('Not tonight: restart on Sunday')
    expect(await rows('errands')).toBe(1)
    // a different ask is not held
    expect(value(await raise(next, { summary: 'Plug in the cable', need: 'hands' }))).toMatchObject({
      result: 'applied',
    })
    // after the hold the ask is raised again
    clock.set(new Date(clock.now().getTime() + 3 * 24 * 3_600_000 + 60_000))
    expect(value(await raise(await workingIssue(), body))).toMatchObject({ result: 'applied' })
  })

  test('(d) a decline by a loop, or a done Errand, holds nothing', async () => {
    const issueId = await workingIssue()
    const body = { summary: 'Approve the build', need: 'hands' }
    const first = value(await raise(issueId, body))
    value(await finishErrand(deps, { errandId: first.errand.id, note: 'approved' }))
    expect(value(await raise(await workingIssue(), body))).toMatchObject({ result: 'applied' })
  })

  describe('a request', () => {
    const ask = (raw: Record<string, unknown>) => requestErrand(deps, { raw: { source: 'ask-human', ...raw } })

    test('(c) a bot check is refused with the route, and nothing is stored', async () => {
      const refused = errorOf(
        await ask({
          text: 'agw: example.com shows a bot check the research Chrome cannot pass. Open screen share to the mini',
          command: 'open vnc://mini',
        }),
      )
      expect(JSON.stringify(refused)).toContain('report the page as blocked')
      expect(await rows('errands')).toBe(0)
    })

    test('(e) a request that says nothing about its need is refused, and one that states it is taken', async () => {
      expect(JSON.stringify(errorOf(await ask({ text: 'Please have a look at the thing' })))).toContain('--need')
      expect(value(await ask({ text: 'Please have a look at the thing', need: 'hands' }))).toMatchObject({
        result: 'applied',
      })
    })

    test('(a) a command that runs on the mini is refused', async () => {
      const refused = errorOf(await ask({ text: 'Run it', command: 'ssh homelab docker ps' }))
      expect(JSON.stringify(refused)).toContain('keyless')
    })

    test('(d) the same ask the owner turned back is refused with his note', async () => {
      const made = value(await ask({ text: 'Restart the mini now', need: 'hands' }))
      value(await turnBackErrand(deps, { errandId: made.errand.id, note: 'No, not before the release', by: 'owner' }))
      expect(JSON.stringify(errorOf(await ask({ text: 'Restart the mini now', need: 'hands' })))).toContain(
        'No, not before the release',
      )
    })
  })

  test('(b) a read-only MacBook report runs with no dialog and its output reaches the lead', async () => {
    const issueId = await workingIssue()
    const raised = value(await raise(issueId, { summary: 'Which smb mounts are up?', cmd: REPORT, need: 'place' }))
    expect(value(await screenErrands(deps))).toEqual([{ errand: raised.errand.id, outcome: 'ran' }])
    expect(verbCalls).toEqual([['report', 'smb-mounts']])
    expect(screenCalls).toEqual([])
    expect(await pageCount()).toBe(0)
    const errand = value(await raiseErrandRead(raised.errand.id))
    expect(errand).toMatchObject({ closedKind: 'done', closedBy: 'loop', reachedOwnerAt: null })
    expect(errand.doneNote).toContain('MacBook verb "report smb-mounts"')
    expect(errand.doneNote).toContain('//host/share on /Volumes/share (smbfs)')
    const [event] = await db.sql`
      SELECT actor, payload FROM factory.issue_events WHERE issue_id = ${issueId} AND kind = 'errand_done'`
    expect(event).toMatchObject({ actor: 'factory' })
    expect(JSON.stringify(event.payload)).toContain('smbfs')
    expect(await effectsOf(issueId, 'note_lead')).toBe(1)
    expect((await readNeeds(db.sql, clock.now())).items).toEqual([])
    expect(value(await screenErrands(deps))).toEqual([])
  })

  test('(b) a pull of the owner’s own repo runs through repo-pull; a standalone request is closed the same way', async () => {
    const made = value(
      await requestErrand(deps, {
        raw: {
          source: 'ask-human',
          text: 'Pull brain on the MacBook',
          command: 'git -C ~/SourceRoot/brain pull --ff-only',
          where: 'macbook',
        },
      }),
    )
    expect(value(await screenErrands(deps))).toEqual([{ errand: made.errand.id, outcome: 'ran' }])
    expect(verbCalls).toEqual([['repo-pull', 'brain']])
    expect(value(await raiseErrandRead(made.errand.id))).toMatchObject({ closedKind: 'done', closedBy: 'loop' })
    // the band of Errands closed without the owner says the factory ran it
    const band = (await readSince(db.sql, { now: clock.now(), since: new Date(clock.now().getTime() - 60_000) }))
      .categories.errands
    expect(band.items).toMatchObject([{ title: 'Pull brain on the MacBook (run by the factory)' }])
  })

  test('an ask-human request the MacBook ran by itself is in the band of Errands closed without the owner', async () => {
    const made = value(
      await requestErrand(deps, {
        raw: { source: 'ask-human', text: 'Reseal the cache', command: "hc run 'make secrets-seed'", where: 'macbook' },
      }),
    )
    value(
      await finishErrand(deps, {
        errandId: made.errand.id,
        note: 'ran by itself on the MacBook (auto-run secrets-seed, exit 0)',
        by: 'orchestrator',
        confirmedBy: 'ask-human: auto-run class secrets-seed (granted by the owner on the MacBook)',
      }),
    )
    const band = (await readSince(db.sql, { now: clock.now(), since: new Date(clock.now().getTime() - 60_000) }))
      .categories.errands
    expect(band.items).toMatchObject([{ title: 'Reseal the cache (ran by itself on your MacBook)' }])
  })

  test('(b) a verb that did not run leaves the command with the owner as a place Errand, with the reason', async () => {
    // each case its own command: the same command is the same Errand
    for (const [exit, why, cmd] of [
      [255, 'did not answer', REPORT],
      [126, 'does not serve that verb', 'ntfy-mac update --check'],
    ] as const) {
      verbAnswer = () => ok({ exit, output: '' })
      const raised = value(await raise(await workingIssue(), { summary: 'Look at the MacBook', cmd, need: 'place' }))
      expect(value(await screenErrands(deps))).toEqual([{ errand: raised.errand.id, outcome: 'reached_owner' }])
      expect(value(await raiseErrandRead(raised.errand.id))).toMatchObject({ need: 'place', closedKind: null })
      expect((value(await raiseErrandRead(raised.errand.id)).screenNote ?? '').includes(why)).toBe(true)
    }
    expect(screenCalls).toEqual([])
  })

  test('(b) a failed pull is the owner’s with git’s words; a port that errors is the same', async () => {
    const issueId = await workingIssue()
    verbAnswer = () => ok({ exit: 1, output: 'fatal: Not possible to fast-forward, aborting.\n' })
    const pull = value(
      await raise(issueId, {
        summary: 'Pull brain',
        cmd: 'git -C ~/SourceRoot/brain pull --ff-only',
        need: 'place',
        needKey: 'pull-brain',
      }),
    )
    expect(value(await screenErrands(deps))).toEqual([{ errand: pull.errand.id, outcome: 'reached_owner' }])
    expect(value(await raiseErrandRead(pull.errand.id)).screenNote).toContain('Not possible to fast-forward')
    verbAnswer = () => err(portError('gone', 'ssh could not start'))
    const second = value(await raise(await workingIssue(), { summary: 'Which mounts', cmd: REPORT, need: 'place' }))
    expect(value(await screenErrands(deps))).toEqual([{ errand: second.errand.id, outcome: 'reached_owner' }])
  })

  test('(b) a class command that names a secret or hands is never run', async () => {
    const issueId = await workingIssue()
    const raised = value(
      await raise(issueId, {
        summary: 'Pull the private repo: the keychain password prompt appears',
        cmd: 'git -C ~/SourceRoot/brain pull --ff-only',
        need: 'secret',
      }),
    )
    expect(value(await screenErrands(deps))).toEqual([{ errand: raised.errand.id, outcome: 'reached_owner' }])
    expect(verbCalls).toEqual([])
    expect(value(await raiseErrandRead(raised.errand.id))).toMatchObject({ need: 'secret' })
  })

  test('(b) an Errand with its own check is not run by a verb: the check decides, so it reaches the owner', async () => {
    const raised = value(
      await raise(await workingIssue(), {
        summary: 'Pull brain',
        cmd: 'git -C ~/SourceRoot/brain pull --ff-only',
        need: 'place',
        check: 'true',
      }),
    )
    expect(value(await screenErrands(deps))).toEqual([{ errand: raised.errand.id, outcome: 'reached_owner' }])
    expect(verbCalls).toEqual([])
  })

  test('(b) with no MacBook port the class command reaches the owner as before', async () => {
    delete deps.macbook
    const issueId = await workingIssue()
    const raised = value(await raise(issueId, { summary: 'Which smb mounts are up?', cmd: REPORT, need: 'place' }))
    expect(value(await screenErrands(deps))).toEqual([{ errand: raised.errand.id, outcome: 'reached_owner' }])
  })
})
