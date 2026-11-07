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
  answerDecision,
  askDecision,
  finishErrand,
  giveVerdict,
  markWorthAsking,
  raiseErrand,
  reviseArtifact,
  showArtifact,
  showDecision,
  submitArtifact,
} from '../../src/app/checkpoints.ts'
import { type PageDeps, sendDuePages } from '../../src/app/checkpoints-pages.ts'
import { type SettleDeps, settleDecision, settleOpen } from '../../src/app/checkpoints-settle.ts'
import { fileIssue, recordIssueEvent } from '../../src/app/issues.ts'
import type { ArtifactId } from '../../src/domains/checkpoints/artifact.ts'
import type { DecisionId, JudgeVerdict, PolicyRule } from '../../src/domains/checkpoints/decision.ts'
import type { Notifier, JudgePort, StandingPolicies } from '../../src/domains/checkpoints/ports.ts'
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
let judgeCalls: { question: string; precedents: number }[]
let judgeAnswer: () => Result<JudgeVerdict>
let sent: string[]
let sendResult: () => Result<void>

const policies: StandingPolicies = { rulesFor: () => Promise.resolve(ok(rules)) }
const judge: JudgePort = {
  judge: (input) => {
    judgeCalls.push({ question: input.question, precedents: input.precedents.length })
    return Promise.resolve(judgeAnswer())
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
  sent = []
  sendResult = () => ok(undefined)
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
    const error = errorOf(await askDecision(deps, { issueId, attempt: 1, form: { ...FORM, question: 'Another one?' } }))
    expect(error.kind).toBe('machine_refused')
    expect(await rows('decisions')).toBe(1)
  })

  test('an Issue that does not exist is unknown', async () => {
    expect(errorOf(await askDecision(deps, { issueId: 'issue_99' as IssueId, attempt: 1, form: FORM }))).toMatchObject({
      kind: 'unknown_issue',
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
    expect(judgeCalls).toEqual([{ question: 'Which retention for the access log rows?', precedents: 1 }])
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

  test('a Judge that fails goes on to the owner, who is paged', async () => {
    const issueId = await workingIssue()
    judgeAnswer = () => err(portError('timeout', 'agw did not answer'))
    const { decision } = await ask(issueId)
    value(await settleDecision(deps, decision.id))
    const shown = value(await showDecision(deps, decision.id))
    expect(shown.steps.map((s) => [s.step, s.outcome])).toEqual([
      ['policy', 'passed'],
      ['judge', 'failed'],
      ['owner', 'open'],
    ])
    expect(await rows('checkpoint_pages')).toBe(1)
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

  test('a step claimed by a call in flight is left to it', async () => {
    const issueId = await workingIssue()
    const { decision } = await ask(issueId)
    await db.sql`INSERT INTO factory.decision_steps (decision_id, step, claimed_until) VALUES (${decision.id}, 'policy', ${new Date('2026-03-01T12:30:00Z')})`
    value(await settleDecision(deps, decision.id))
    const shown = value(await showDecision(deps, decision.id))
    // policy is still claimed: the pass went on to the Judge, and the Decision stays open
    expect(shown.steps.find((s) => s.step === 'policy')?.outcome).toBeNull()
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

describe('errands', () => {
  test('raised by the lead and done by the owner: the Issue waits, pages once, and wakes with one note_lead', async () => {
    const issueId = await workingIssue()
    const raised = value(
      await raiseErrand(deps, { issueId, attempt: 1, raw: { summary: 'Approve the App Store build' } }),
    )
    expect(raised).toMatchObject({ result: 'applied', issue: { state: 'waiting', waitReason: 'errand' } })
    expect(
      value(await raiseErrand(deps, { issueId, attempt: 1, raw: { summary: 'Approve the App Store build' } })),
    ).toMatchObject({
      result: 'replayed',
    })
    expect(await rows('errands')).toBe(1)
    expect(value(await sendDuePages(deps)).sent).toEqual([key('page', 'errand', raised.errand.id)])

    const done = value(await finishErrand(deps, { errandId: raised.errand.id, note: 'approved' }))
    expect(done).toMatchObject({ result: 'applied', errand: { doneNote: 'approved' }, issue: { state: 'working' } })
    expect(await effectsOf(issueId, 'note_lead')).toBe(1)
    expect(value(await finishErrand(deps, { errandId: raised.errand.id, note: null }))).toMatchObject({
      result: 'replayed',
    })
    expect(await effectsOf(issueId, 'note_lead')).toBe(1)
  })

  test('an Errand with no summary is refused with the field named', async () => {
    const issueId = await workingIssue()
    expect(errorOf(await raiseErrand(deps, { issueId, attempt: 1, raw: { detail: 'x' } }))).toMatchObject({
      kind: 'missing_field',
      fields: ['summary'],
    })
  })
})

describe("the owner's line", () => {
  test('a failed send waits and tries again, backing off; the fifth failure is final; a delivery is recorded once', async () => {
    const issueId = await workingIssue()
    await ask(issueId)
    value(await settleOpen(deps))
    sendResult = () => err(portError('gone', 'ntfy answered 503'))
    expect(value(await sendDuePages(deps)).failed).toHaveLength(1)
    // inside its backoff nothing is due
    expect(value(await sendDuePages(deps))).toEqual({ sent: [], failed: [] })
    for (let attempt = 2; attempt <= 5; attempt++) {
      clock.advance(5 * 60_000)
      expect(value(await sendDuePages(deps)).failed).toHaveLength(1)
    }
    const [page] = await db.sql`SELECT attempts, failed_at, error FROM factory.checkpoint_pages`
    expect(page).toMatchObject({ attempts: 5, error: 'gone: ntfy answered 503' })
    expect(page?.failed_at).not.toBeNull()
    clock.advance(10 * 60_000)
    expect(value(await sendDuePages(deps))).toEqual({ sent: [], failed: [] })

    sendResult = () => ok(undefined)
    expect(sent).toEqual([])
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
