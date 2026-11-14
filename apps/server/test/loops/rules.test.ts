import { expect, test } from 'bun:test'
import type { StewardAnswer, TriageAnswer } from '@software-factory/contract'
import { cycleThrough } from '../../src/domains/planning/chain.ts'
import { readDecisionForm } from '../../src/domains/checkpoints/decision.ts'
import { type CallPolicy, type CallRow, planCall } from '../../src/domains/loops/calls.ts'
import { checkSettle, settleRequest, settleRule, type SettlingFacts } from '../../src/domains/loops/settle.ts'
import {
  checkAnswer,
  decideStall,
  DEFAULT_STEWARD_RULES,
  decideIdle,
  fallbackDecision,
  idleClockStart,
  readIdleHistory,
  REVISE_NOTE,
  IDLE_NOTE,
  type IdleFacts,
  SAME_STALL,
  sameWords,
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
  episode: 0,
  repeatOf: null,
  holds: 0,
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
  statedEdges: false,
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

test('an Issue whose filer stated its edges settles by rule: the model is not asked for edges', () => {
  expect(settleRule(settling({ statedEdges: true }), shown)).toBe('now')
  expect(settleRule(settling({ statedEdges: true, origin: 'factory' }), shown)).toBe('now')
  expect(settleRule(settling({ statedEdges: true, origin: 'github' }), shown)).toBe('now')
})

const triaged = (over: Partial<TriageAnswer>): TriageAnswer => ({
  amend: null,
  after: [],
  kind: null,
  size: null,
  reason: 'builds on it',
  ...over,
})

const never = () => false

test('edges are held to what the answer was shown: no unseen Issue, not itself, none twice, no amend', () => {
  expect(checkSettle(shown, settling(), triaged({ after: ['issue_12'] }), never)).toEqual({
    ok: true,
    after: [id(12)],
    dropped: [],
    reason: 'builds on it',
    refinement: { kind: undefined, checkpoint: undefined },
  })
  expect(checkSettle(shown, settling(), triaged({ after: [] }), never)).toMatchObject({ ok: true, after: [] })
  expect(checkSettle(shown, settling(), triaged({ after: ['issue_99'] }), never)).toMatchObject({ ok: false })
  expect(checkSettle(shown, settling(), triaged({ after: ['issue_20'] }), never)).toMatchObject({ ok: false })
  expect(checkSettle(shown, settling(), triaged({ after: ['issue_12', 'issue_12'] }), never)).toMatchObject({
    ok: false,
  })
  expect(checkSettle(shown, settling(), triaged({ amend: 'issue_12' }), never)).toMatchObject({ ok: false })
})

test('an edge that inverts the chain or names a later Issue is dropped with its reason; the rest stand', () => {
  // issue_12 already waits for issue_20 (directly), issue_15 through issue_12 (transitively)
  const chain = [
    { issue: id(12), after: id(20), satisfied: false },
    { issue: id(15), after: id(12), satisfied: false },
  ]
  const later = { id: id(30), title: 'Filed after it', kind: 'feature', state: 'queued' }
  const open = [...shown, later, { id: id(11), title: 'Older', kind: 'chore', state: 'queued' }]
  const waits = (edges: typeof chain) => (blocker: IssueId) => cycleThrough(edges, id(20), blocker) !== undefined
  const checked = checkSettle(
    open,
    settling(),
    triaged({ after: ['issue_12', 'issue_15', 'issue_30', 'issue_11'] }),
    waits(chain),
  )
  expect(checked).toEqual({
    ok: true,
    after: [id(11)],
    dropped: [
      { issue: id(12), why: 'issue_12 already waits for issue_20' },
      { issue: id(15), why: 'issue_15 already waits for issue_20' },
      { issue: id(30), why: 'issue_30 was filed after issue_20' },
    ],
    reason: 'builds on it',
    refinement: { kind: undefined, checkpoint: undefined },
  })
  // a satisfied edge holds nobody back
  expect(
    checkSettle(
      shown,
      settling(),
      triaged({ after: ['issue_12'] }),
      waits([{ issue: id(12), after: id(20), satisfied: true }]),
    ),
  ).toMatchObject({ ok: true, after: [id(12)], dropped: [] })
})

test('a kind is refined only for an owner or agent request, and only to a different feature, bug, chore or docs', () => {
  const kindOf = (facts: Partial<SettlingFacts>, kind: TriageAnswer['kind']) => {
    const checked = checkSettle(shown, settling(facts), triaged({ kind }), never)
    return checked.ok ? checked.refinement.kind : 'refused'
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

test('a Spec checkpoint is flagged by triage for any asked Issue of a session or more, never for an incident, and only as `spec`', () => {
  const flagOf = (
    facts: Partial<SettlingFacts>,
    checkpoint: TriageAnswer['checkpoint'],
    size: TriageAnswer['size'] = 'medium',
  ) => {
    const checked = checkSettle(shown, settling(facts), triaged({ checkpoint, size }), never)
    return checked.ok ? checked.refinement.checkpoint : 'refused'
  }
  expect(flagOf({}, 'spec')).toBe('spec')
  expect(flagOf({}, 'spec', 'large')).toBe('spec')
  expect(flagOf({ origin: 'github' }, 'spec')).toBe('spec')
  expect(flagOf({}, null)).toBeUndefined()
  expect(flagOf({}, undefined)).toBeUndefined()
  expect(flagOf({ kind: 'incident' }, 'spec')).toBeUndefined()
  // a one-line config change is an hour's work, and an unsized Issue is its lead's to judge: no Spec is owed (Issue 1096)
  expect(flagOf({ title: 'Raise the plan file limit to 256 KiB' }, 'spec', 'small')).toBeUndefined()
  expect(flagOf({}, 'spec', null)).toBeUndefined()
})

test('the settle request carries the owner’s newest needed-me marks, cleaned', () => {
  const request = settleRequest(settling({}), [], (t) => t.replace(/abcd\w+/g, '[x]'), [
    {
      title: 'Raise the limit token=abcd1234',
      repo: 'example',
      source: 'triage',
      screened: 'passed',
      needed: false,
      verdict: 'looks_good',
      note: 'not needed abcdefgh',
    },
  ])
  expect(request.precedents).toEqual([
    {
      title: 'Raise the limit token=[x]',
      repo: 'example',
      source: 'triage',
      screened: 'passed',
      needed: false,
      verdict: 'looks_good',
      note: 'not needed [x]',
    },
  ])
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

const idle = (over: Partial<IdleFacts> = {}): IdleFacts => ({
  idleSince: new Date(NOW.getTime() - 30 * 60_000),
  quietSince: new Date(NOW.getTime() - 30 * 60_000),
  wakes: 0,
  lastEvent: 'v7 regressed: the probe failed',
  background: false,
  verdictAt: null,
  attempt: 1,
  pendingRevision: null,
  ...over,
})

test('a lead quiet for less than the threshold is left alone', () => {
  const young = idle({
    idleSince: new Date(NOW.getTime() - 5 * 60_000),
    quietSince: new Date(NOW.getTime() - 5 * 60_000),
  })
  expect(decideIdle(young, NOW, rules)).toMatchObject({ kind: 'wait' })
})

test('a quiet lead is woken with a note naming the last event, twice per attempt, then the workflow is asked', () => {
  const first = decideIdle(idle(), NOW, rules)
  expect(first).toMatchObject({ kind: 'wake' })
  if (first.kind !== 'wake') throw new Error('unreachable')
  expect(first.detail).toStartWith(IDLE_NOTE)
  expect(first.detail).toContain('30 minute(s)')
  expect(first.detail).toContain('v7 regressed: the probe failed')
  expect(first.detail).toContain('background tasks')
  expect(decideIdle(idle({ wakes: 1 }), NOW, rules)).toMatchObject({ kind: 'wake' })
  expect(decideIdle(idle({ wakes: 2 }), NOW, rules)).toEqual({ kind: 'ask' })
})

test('a lead waiting on background work is nudged only past the longer threshold, and told so', () => {
  const waiting = (minutes: number, over: Partial<IdleFacts> = {}) =>
    idle({
      background: true,
      idleSince: new Date(NOW.getTime() - minutes * 60_000),
      quietSince: new Date(NOW.getTime() - minutes * 60_000),
      ...over,
    })
  // 67 minutes is the longest wait on an implementer the burn-in measured
  expect(decideIdle(waiting(67), NOW, rules)).toMatchObject({ kind: 'wait' })
  const late = decideIdle(waiting(95), NOW, rules)
  expect(late).toMatchObject({ kind: 'wake' })
  if (late.kind !== 'wake') throw new Error('unreachable')
  expect(late.detail).toContain('background work still running')
  // the second wake waits another background threshold, not the short one
  expect(
    decideIdle(waiting(95, { wakes: 1, quietSince: new Date(NOW.getTime() - 30 * 60_000) }), NOW, rules),
  ).toMatchObject({
    kind: 'wait',
  })
})

test('a repeated stall that a Decision settled is not asked again; a note from a person still ends it', () => {
  const repeat = stall({ repeatOf: { answeredAt: 14, held: false } })
  expect(decideStall(repeat, NOW, rules)).toMatchObject({ kind: 'wait' })
  expect(decideStall(stall(), NOW, rules)).toEqual({ kind: 'ask' })
  expect(decideStall({ ...repeat, notes: ['use the v2 endpoint'] }, NOW, rules)).toMatchObject({ kind: 'wake' })
})

test('a repeated block after a hold answer is held until a later time, each hold twice as long, and raises no Decision', () => {
  const first = decideStall(stall({ repeatOf: { answeredAt: 14, held: true }, holds: 1 }), NOW, rules)
  const second = decideStall(stall({ repeatOf: { answeredAt: 14, held: true }, holds: 2 }), NOW, rules)
  expect(first).toMatchObject({ kind: 'hold' })
  expect(second).toMatchObject({ kind: 'hold' })
  const gap = (action: unknown) => Date.parse((action as { until: string }).until) - NOW.getTime()
  expect(gap(second)).toBe(gap(first) * 2)
  // only a lead's block is held; a note from a person still ends it
  expect(
    decideStall(stall({ cause: 'regressed', repeatOf: { answeredAt: 14, held: true } }), NOW, rules),
  ).toMatchObject({
    kind: 'wait',
  })
  expect(
    decideStall(stall({ repeatOf: { answeredAt: 14, held: true }, notes: ['use the v2 endpoint'] }), NOW, rules),
  ).toMatchObject({ kind: 'wake' })
})

test('two stall details read alike by their words, whatever the digits', () => {
  expect(
    sameWords(
      'regressed 3 times: make verify failed on macOS 26.7.2',
      'regressed 14 times: make verify failed on macOS 26.7.3',
    ),
  ).toBe(1)
  expect(
    sameWords(
      'Holding until the macOS update lands, as answered. No change: make verify red only on that pending update.',
      'make verify is red only because of the pending macOS update; holding until it lands',
    ),
  ).toBeGreaterThanOrEqual(SAME_STALL)
  expect(
    sameWords('waiting for the staging database', 'the migration number clashes with another branch'),
  ).toBeLessThan(SAME_STALL)
})

test('the next wake waits another threshold from the last one', () => {
  const justWoken = idle({ wakes: 1, quietSince: new Date(NOW.getTime() - 60_000) })
  expect(decideIdle(justWoken, NOW, rules)).toMatchObject({ kind: 'wait' })
  expect(decideIdle(idle({ wakes: 2, quietSince: new Date(NOW.getTime() - 60_000) }), NOW, rules)).toMatchObject({
    kind: 'wait',
  })
})

const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000)
const record = (version: number, kind: string, minutes: number, payload: unknown = {}, actor = 'owner') => ({
  version,
  kind,
  actor,
  payload,
  at: minutesAgo(minutes),
})

test('a verdict followed by 25 minutes of silence produces no idle nudge; after the grace the usual one comes', () => {
  // the lead has been quiet for 25 minutes since it heard the verdict
  const heard = idle({ idleSince: minutesAgo(25), quietSince: minutesAgo(25), verdictAt: minutesAgo(25) })
  expect(decideIdle(heard, NOW, rules)).toMatchObject({ kind: 'wait' })
  const later = idle({ idleSince: minutesAgo(31), quietSince: minutesAgo(31), verdictAt: minutesAgo(31) })
  expect(decideIdle(later, NOW, rules)).toMatchObject({ kind: 'wake' })
})

test('the idle clock starts at the last news the lead heard, not at an older turn end', () => {
  const history = readIdleHistory(
    [
      record(2, 'admitted', 200),
      record(5, 'submitted', 100, { attempt: 1, artifact: { id: 'artifact_1' } }, 'lead'),
      record(6, 'noted', 24),
      record(7, 'verdict_given', 24, { artifact: 'artifact_1', verdict: 'looks_good' }),
      record(8, 'noted', 4, { text: `${IDLE_NOTE} for 9 minute(s)` }, 'steward'),
    ],
    2,
  )
  expect(history.newsAt).toEqual(minutesAgo(24))
  expect(history.verdictAt).toEqual(minutesAgo(24))
  expect(history.pendingRevision).toBeNull()
  // the events of an earlier attempt are not news
  expect(readIdleHistory([record(3, 'verdict_given', 5, { artifact: 'a', verdict: 'changes' })], 4)).toEqual({
    newsAt: null,
    verdictAt: null,
    pendingRevision: null,
  })
})

test('a changes verdict with no revision after 60 minutes idle produces the specific revise note, once', () => {
  const verdict = record(7, 'verdict_given', 70, { artifact: 'artifact_1', verdict: 'changes' })
  const owed = readIdleHistory([record(2, 'admitted', 300), verdict], 2)
  expect(owed.pendingRevision).toMatchObject({ artifact: 'artifact_1', version: 7, noted: false })
  const facts = (minutes: number, pendingRevision = owed.pendingRevision) =>
    idle({
      idleSince: minutesAgo(minutes),
      quietSince: minutesAgo(minutes),
      verdictAt: owed.verdictAt,
      pendingRevision,
    })
  // 40 minutes idle: past the verdict grace and the generic threshold, yet the generic nudge is held back for the revise note
  expect(decideIdle(facts(40), NOW, rules)).toMatchObject({ kind: 'wait' })
  const note = decideIdle(facts(61), NOW, rules)
  if (note.kind !== 'wake') throw new Error('unreachable')
  expect(note.detail).toStartWith(REVISE_NOTE)
  expect(note.detail).not.toStartWith(IDLE_NOTE)
  expect(note.detail).toContain('factory artifact revise artifact_1')
  expect(note.revise).toEqual({ artifact: 'artifact_1', version: 7 })

  // once told, the pending revision no longer holds the generic nudge back, and the note is not sent again
  const told = readIdleHistory(
    [record(2, 'admitted', 300), verdict, record(9, 'noted', 5, { text: note.detail }, 'steward')],
    2,
  )
  expect(told.pendingRevision?.noted).toBe(true)
  const again = decideIdle(facts(61, told.pendingRevision), NOW, rules)
  expect(again).toMatchObject({ kind: 'wake' })
  if (again.kind === 'wake') expect(again.revise).toBeUndefined()

  // a revision submitted after the verdict clears it
  const revised = readIdleHistory(
    [
      record(2, 'admitted', 300),
      verdict,
      record(8, 'submitted', 65, { attempt: 1, artifact: { id: 'artifact_1' } }, 'lead'),
    ],
    2,
  )
  expect(revised.pendingRevision).toBeNull()
  // a verdict of looks_good owes none
  expect(
    readIdleHistory([record(7, 'verdict_given', 70, { artifact: 'artifact_1', verdict: 'with_notes' })], 2)
      .pendingRevision,
  ).toBeNull()
})

test("self-watch counts a lead idle on the steward's clock: after the verdict grace, and after the revise note is due", () => {
  const quiet = idle({ idleSince: minutesAgo(5), verdictAt: minutesAgo(5) })
  expect(idleClockStart(quiet, rules)).toEqual(new Date(minutesAgo(5).getTime() + rules.verdictGraceMs))
  const owed = idle({
    idleSince: minutesAgo(50),
    verdictAt: minutesAgo(50),
    pendingRevision: { artifact: 'artifact_1', version: 7, verdictAt: minutesAgo(50), noted: false },
  })
  expect(idleClockStart(owed, rules)).toEqual(new Date(minutesAgo(50).getTime() + rules.reviseAfterMs))
  const told = idle({
    idleSince: minutesAgo(50),
    pendingRevision: { artifact: 'artifact_1', version: 7, verdictAt: minutesAgo(50), noted: true },
  })
  expect(idleClockStart(told, rules)).toEqual(minutesAgo(50))
})
