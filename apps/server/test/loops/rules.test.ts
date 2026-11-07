import { expect, test } from 'bun:test'
import type { StewardAnswer, TriageAnswer } from '@software-factory/contract'
import { readDecisionForm } from '../../src/domains/checkpoints/decision.ts'
import { type CallPolicy, type CallRow, planCall } from '../../src/domains/loops/calls.ts'
import { checkSettle, settleRequest, settleRule, type SettlingFacts } from '../../src/domains/loops/settle.ts'
import {
  checkAnswer,
  decideStall,
  DEFAULT_STEWARD_RULES,
  fallbackDecision,
  type StallFacts,
  stallRequest,
} from '../../src/domains/loops/stall.ts'
import type { IssueId } from '../../src/kernel/ids.ts'

const NOW = new Date('2026-11-07T12:00:00Z')
const id = (n: number) => `issue_${n}` as IssueId

const stall = (over: Partial<StallFacts> = {}): StallFacts => ({
  issue: id(12),
  repo: 'app',
  title: 'Fix the checkout total',
  kind: 'bug',
  cause: 'blocked',
  detail: 'waiting for the staging database',
  since: 9,
  stalledAt: new Date(NOW.getTime() - 10 * 60_000),
  attempt: 1,
  restarts: 0,
  regressions: 0,
  stewardWakes: 0,
  notes: [],
  history: [],
  windowOpen: null,
  ...over,
})

const rules = DEFAULT_STEWARD_RULES

test('a young stall is left alone: the lead’s next turn may end it', () => {
  const young = stall({ cause: 'wall', stalledAt: new Date(NOW.getTime() - 30_000), windowOpen: true })
  expect(decideStall(young, NOW, rules)).toMatchObject({ kind: 'wait' })
})

test('a wall is woken when the window is open or unknown, and left while it is closed', () => {
  expect(decideStall(stall({ cause: 'wall', windowOpen: true }), NOW, rules)).toMatchObject({ kind: 'wake' })
  expect(decideStall(stall({ cause: 'wall', windowOpen: null }), NOW, rules)).toMatchObject({ kind: 'wake' })
  expect(decideStall(stall({ cause: 'wall', windowOpen: false }), NOW, rules)).toMatchObject({ kind: 'wait' })
})

test('a note that arrived while it waited is delivered: a wake, or a requeue for a lead that is gone', () => {
  const notes = ['the vendor answered']
  expect(decideStall(stall({ notes }), NOW, rules)).toMatchObject({ kind: 'wake' })
  expect(decideStall(stall({ cause: 'regressed', notes }), NOW, rules)).toMatchObject({ kind: 'wake' })
  expect(decideStall(stall({ cause: 'lead_gone', notes }), NOW, rules)).toMatchObject({ kind: 'requeue' })
  // even a wall still closed: the note is news
  expect(decideStall(stall({ cause: 'wall', windowOpen: false, notes }), NOW, rules)).toMatchObject({ kind: 'wake' })
})

test('an unreported stop is woken twice per attempt, then asked about', () => {
  expect(decideStall(stall({ cause: 'unreported', stewardWakes: 0 }), NOW, rules)).toMatchObject({ kind: 'wake' })
  expect(decideStall(stall({ cause: 'unreported', stewardWakes: 1 }), NOW, rules)).toMatchObject({ kind: 'wake' })
  expect(decideStall(stall({ cause: 'unreported', stewardWakes: 2 }), NOW, rules)).toEqual({ kind: 'ask' })
})

test('the stalls the rules cannot read are asked: blocked, lead_gone with no news, regressed', () => {
  for (const cause of ['blocked', 'lead_gone', 'regressed'] as const) {
    expect(decideStall(stall({ cause }), NOW, rules)).toEqual({ kind: 'ask' })
  }
})

test('the request is cut to the workflow’s limits and scrubbed by the caller’s cleaner', () => {
  const request = stallRequest(
    stall({ detail: 'x'.repeat(5_000), notes: Array.from({ length: 30 }, (_, i) => `note ${i} token=hunter2hunter2`) }),
    NOW,
    (text) => text.replace(/hunter2hunter2/g, '[redacted]'),
  )
  expect(request.detail).toHaveLength(4_000)
  expect(request.notes).toHaveLength(20)
  expect(request.notes.at(-1)).toBe('note 29 token=[redacted]')
  expect(request).toMatchObject({ issue: 'issue_12', stalledMinutes: 10, cause: 'blocked' })
})

const answer = (over: Partial<StewardAnswer>): StewardAnswer => ({
  action: 'wake',
  note: '',
  reason: 'the cause is gone',
  decision: null,
  ...over,
})

test('an answer is held to the stall: requeue ends only lead_gone, wake every other, none is none', () => {
  expect(checkAnswer({ cause: 'blocked' }, answer({ action: 'wake', note: ' hello ' }))).toEqual({
    kind: 'wake',
    note: 'hello',
    reason: 'the cause is gone',
  })
  expect(checkAnswer({ cause: 'lead_gone' }, answer({ action: 'requeue' }))).toMatchObject({
    kind: 'requeue',
    note: null,
  })
  expect(checkAnswer({ cause: 'blocked' }, answer({ action: 'requeue' }))).toMatchObject({ kind: 'none' })
  expect(checkAnswer({ cause: 'lead_gone' }, answer({ action: 'wake' }))).toMatchObject({ kind: 'none' })
  expect(checkAnswer({ cause: 'blocked' }, answer({ action: 'none' }))).toMatchObject({ kind: 'none' })
  expect(checkAnswer({ cause: 'blocked' }, answer({ action: 'raise_decision' }))).toMatchObject({ kind: 'none' })
})

test('a lead that is gone gets a requeue, never a Decision: an answer cannot start a new attempt', () => {
  const decision = {
    question: 'q',
    recommendation: 'a',
    checked: 'c',
    options: [
      { label: 'a', reversible: true, cost: 'x' },
      { label: 'b', reversible: true, cost: 'y' },
    ],
    noAnswer: { consequence: 'z', default: null, waitMinutes: null },
  }
  expect(checkAnswer({ cause: 'lead_gone' }, answer({ action: 'raise_decision', decision }))).toMatchObject({
    kind: 'none',
    why: expect.stringContaining('requeue'),
  })
  expect(checkAnswer({ cause: 'blocked' }, answer({ action: 'raise_decision', decision }))).toMatchObject({
    kind: 'decision',
  })
})

test('the Decision the factory raises itself when no answer came is a complete form', () => {
  for (const cause of ['wall', 'unreported', 'blocked', 'lead_gone', 'regressed'] as const) {
    const form = readDecisionForm(fallbackDecision(stall({ cause })))
    expect(form).toMatchObject({ ok: true })
  }
})

// ---- calls ---------------------------------------------------------------------------------------------------------

const policy: CallPolicy = { maxRounds: 3, retryMs: 10 * 60_000, leaseMs: 35 * 60_000 }
const row = (round: number, over: Partial<CallRow> = {}): CallRow => ({
  key: `steward:issue_12:9:${round}`,
  loop: 'steward',
  issueId: id(12),
  subject: 'wait:9',
  round,
  claimedAt: new Date(NOW.getTime() - 60 * 60_000),
  leaseUntil: new Date(NOW.getTime() - 25 * 60_000),
  outcome: 'failed',
  answer: null,
  detail: 'gone',
  finishedAt: new Date(NOW.getTime() - 59 * 60_000),
  ...over,
})

test('a subject with no round is claimed as round one', () => {
  expect(planCall([], NOW, policy)).toEqual({ kind: 'claim', round: 1 })
})

test('an answered round is reused, whatever came after', () => {
  const answered = row(1, { outcome: 'answered', answer: { action: 'wake' } })
  expect(planCall([answered, row(2)], NOW, policy)).toEqual({ kind: 'answered', row: answered })
})

test('a round in flight is left to its call until its lease lapses, then it is retaken', () => {
  const flying = row(1, {
    outcome: null,
    finishedAt: null,
    claimedAt: NOW,
    leaseUntil: new Date(NOW.getTime() + 1_000),
  })
  expect(planCall([flying], NOW, policy)).toEqual({ kind: 'in_flight' })
  // a lapsed lease is a call the server stopped under: asked again under its own key, not as a round of its own
  const lapsed = { ...flying, leaseUntil: new Date(NOW.getTime() - 20 * 60_000) }
  expect(planCall([lapsed], NOW, policy)).toEqual({ kind: 'retake', row: lapsed })
})

test('a round that came to nothing is retried after the wait, and the rounds run out', () => {
  const recent = row(1, { finishedAt: new Date(NOW.getTime() - 60_000) })
  expect(planCall([recent], NOW, policy)).toEqual({
    kind: 'backoff',
    until: new Date(NOW.getTime() - 60_000 + 600_000),
  })
  expect(planCall([row(1)], NOW, policy)).toEqual({ kind: 'claim', round: 2 })
  expect(planCall([row(1), row(2), row(3)], NOW, policy)).toEqual({ kind: 'exhausted', rounds: 3 })
})

// ---- settling ------------------------------------------------------------------------------------------------------

const settling = (over: Partial<SettlingFacts> = {}): SettlingFacts => ({
  issue: id(20),
  repo: 'app',
  title: 'Show the coupon',
  kind: 'feature',
  origin: 'you',
  filedAt: NOW,
  fromAlert: false,
  text: '',
  ...over,
})
const shown = [
  { id: id(12), title: 'Fix the checkout total', kind: 'bug', state: 'working' },
  { id: id(15), title: 'Add a dark theme', kind: 'feature', state: 'queued' },
]

test('settle by rule when no edges are needed: an incident, an alert’s Issue, nothing else open', () => {
  expect(settleRule(settling({ kind: 'incident' }), shown)).toBe('now')
  expect(settleRule(settling({ fromAlert: true, kind: 'bug' }), shown)).toBe('now')
  expect(settleRule(settling({ origin: 'github' }), [])).toBe('now')
  expect(settleRule(settling({ origin: 'github' }), shown)).toBe('ask')
  expect(settleRule(settling(), shown)).toBe('ask')
  // an owner's or an agent's request is asked even with nothing open beside it: its kind may be refined
  expect(settleRule(settling(), [])).toBe('ask')
  expect(settleRule(settling({ origin: 'factory' }), [])).toBe('ask')
})

const triaged = (over: Partial<TriageAnswer>): TriageAnswer => ({
  amend: null,
  after: [],
  kind: null,
  size: null,
  reason: 'builds on it',
  ...over,
})

test('edges are held to what the answer was shown: no unseen Issue, not itself, none twice, no amend', () => {
  expect(checkSettle(shown, settling(), triaged({ after: ['issue_12'] }))).toEqual({
    ok: true,
    after: [id(12)],
    reason: 'builds on it',
    kind: undefined,
  })
  expect(checkSettle(shown, settling(), triaged({ after: [] }))).toMatchObject({ ok: true, after: [] })
  expect(checkSettle(shown, settling(), triaged({ after: ['issue_99'] }))).toMatchObject({ ok: false })
  expect(checkSettle(shown, settling(), triaged({ after: ['issue_20'] }))).toMatchObject({ ok: false })
  expect(checkSettle(shown, settling(), triaged({ after: ['issue_12', 'issue_12'] }))).toMatchObject({ ok: false })
  expect(checkSettle(shown, settling(), triaged({ amend: 'issue_12' }))).toMatchObject({ ok: false })
})

test('a kind is refined only for an owner or agent request, and only to a different feature, bug, chore or docs', () => {
  const kindOf = (facts: Partial<SettlingFacts>, kind: TriageAnswer['kind']) => {
    const checked = checkSettle(shown, settling(facts), triaged({ kind }))
    return checked.ok ? checked.kind : 'refused'
  }
  expect(kindOf({}, 'docs')).toBe('docs')
  expect(kindOf({ origin: 'factory' }, 'bug')).toBe('bug')
  expect(kindOf({}, 'feature')).toBeUndefined()
  expect(kindOf({}, null)).toBeUndefined()
  expect(kindOf({}, 'incident')).toBeUndefined()
  expect(kindOf({ origin: 'github' }, 'docs')).toBeUndefined()
  expect(kindOf({ fromAlert: true, kind: 'bug' }, 'docs')).toBeUndefined()
  expect(kindOf({ kind: 'incident' }, 'docs')).toBeUndefined()
})

test('the settle request shows at most 40 open Issues, cleaned, and the Issue’s own words', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    id: id(100 + i),
    title: `Issue ${i} secret=abcd1234`,
    kind: 'bug',
    state: 'queued',
  }))
  const request = settleRequest(settling({ text: 'api_key=abcdefgh' }), many, (t) => t.replace(/abcd\w+/g, '[x]'))
  expect(request.candidates).toHaveLength(40)
  expect(request.candidates[0]?.title).toBe('Issue 0 secret=[x]')
  expect(request.issue).toMatchObject({ id: 'issue_20', text: 'api_key=[x]' })
})
