import { expect, test } from 'bun:test'
import type { ChainNode, ReadIssueDetail } from '@software-factory/contract'
import {
  activityGroups,
  attemptSeries,
  cacheShare,
  chainAround,
  checkPassed,
  checkpointTally,
  kindOf,
  lozengeStateOf,
  nextActions,
  optionChips,
  regressionCount,
  SESSION_TONES,
  shipStatus,
  TAB_KEYS,
  TAB_LABEL,
  tabCounts,
  tabOf,
} from '../src/lib/issue-page.ts'

type Line = ReadIssueDetail['timeline'][number]
type Session = ReadIssueDetail['sessions'][number]
type Ship = ReadIssueDetail['shipping'][number]

const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const line = (at: Date, kind: string, text: string, session: string | null = null): Line => ({
  at: at.toISOString(),
  kind,
  text,
  session,
})

const session = (id: string, over: Partial<Session['insights']> = {}): Session =>
  ({
    id,
    insights: {
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: null,
      elapsedMs: 0,
      workingMs: 0,
      turns: 0,
      toolCalls: 0,
      subagents: 0,
      tokens,
      models: [],
      attempts: 1,
      partial: false,
      ...over,
    },
  }) as Session

const ship = (over: Partial<Ship> = {}, watch: Ship['watch'] = null): Ship => ({
  at: '2026-01-01T00:00:00Z',
  attempt: 1,
  result: 'accepted',
  detail: null,
  commits: [],
  review: { present: true, note: null },
  acceptance: null,
  watch,
  checks: [],
  ...over,
})

const watch = (answer: 'passed' | 'regressed' | 'ended' | null): NonNullable<Ship['watch']> => ({
  startedAt: '2026-01-01T00:00:00Z',
  windowMs: 60_000,
  answer,
  answeredAt: answer === null ? null : '2026-01-01T00:01:00Z',
})

const node = (id: string, title: string): ChainNode => ({
  id,
  kind: 'issue',
  repo: null,
  title,
  state: 'queued',
  issueKind: 'feature',
  since: null,
  waitReason: null,
  notBefore: null,
})

// local-time dates so the clock words are the same in any zone
const at = (day: number, h: number, m: number, s = 0) => new Date(2026, 10, day, h, m, s)

test('a tab value is one of the four, else the overview', () => {
  expect(TAB_KEYS.map(tabOf)).toEqual([...TAB_KEYS])
  expect(tabOf('nope')).toBe('overview')
  expect(tabOf(undefined)).toBe('overview')
  expect(tabOf(3)).toBe('overview')
  expect(Object.keys(TAB_LABEL)).toEqual([...TAB_KEYS])
})

test('a closed Issue shows a known outcome, otherwise its state', () => {
  expect(lozengeStateOf({ state: 'closed', outcome: 'done' })).toBe('done')
  expect(lozengeStateOf({ state: 'closed', outcome: 'healed' })).toBe('healed')
  expect(lozengeStateOf({ state: 'closed', outcome: 'weird' })).toBe('closed')
  expect(lozengeStateOf({ state: 'closed', outcome: null })).toBe('closed')
  expect(lozengeStateOf({ state: 'working', outcome: 'done' })).toBe('working')
})

test('only the five kinds are kinds', () => {
  expect(kindOf('bug')).toBe('bug')
  expect(kindOf('docs')).toBe('docs')
  expect(kindOf('epic')).toBeNull()
  expect(kindOf(null)).toBeNull()
})

test('an empty timeline has no groups', () => {
  expect(activityGroups({ timeline: [], sessions: [], now: 0, closed: false })).toEqual([])
})

test('lines before any attempt form their own group, then one group per attempt', () => {
  const sessions = [session('lead-1-1'), session('lead-1-2')]
  const timeline = [
    line(at(9, 10, 0), 'filed', 'Filed.'),
    line(at(9, 10, 1), 'lead_started', 'A lead started.', 'lead-1-1'),
    line(at(9, 10, 2), 'noted', 'A note.'),
    line(at(9, 10, 3), 'lead_gone', 'The lead ended.', 'lead-1-1'),
    line(at(9, 10, 4), 'lead_started', 'A lead started.', 'lead-1-2'),
  ]
  const groups = activityGroups({ timeline, sessions, now: at(9, 11, 0).getTime(), closed: true })
  expect(groups.map((g) => g.title)).toEqual(['Before the first attempt', 'Attempt 1', 'Attempt 2'])
  expect(groups.map((g) => g.steps.length)).toEqual([1, 3, 1])
  expect(new Set(groups.flatMap((g) => g.steps.map((s) => s.id))).size).toBe(5)
  expect(new Set(groups.map((g) => g.key)).size).toBe(3)
  expect(groups[0]?.steps[0]).toMatchObject({ kind: 'filed', label: 'Filed.', at: '10:00:00', durationMs: 60_000 })
})

test('one attempt only: the first line already belongs to it', () => {
  const groups = activityGroups({
    timeline: [line(at(9, 10, 0), 'lead_started', 'Started.', 'lead-1-1')],
    sessions: [session('lead-1-1')],
    now: 0,
    closed: true,
  })
  expect(groups.map((g) => g.title)).toEqual(['Attempt 1'])
})

test('the last step runs to now while open, and has no duration once closed', () => {
  const timeline = [line(at(9, 10, 0), 'filed', 'Filed.'), line(at(9, 10, 0, 30), 'admitted', 'Admitted.')]
  const now = at(9, 10, 5).getTime()
  const open = activityGroups({ timeline, sessions: [], now, closed: false })[0]?.steps
  expect(open?.map((s) => s.durationMs)).toEqual([30_000, 270_000])
  const closed = activityGroups({ timeline, sessions: [], now, closed: true })[0]?.steps
  expect(closed?.map((s) => s.durationMs)).toEqual([30_000, undefined])
})

test('a day change shows the date with the minute', () => {
  const timeline = [line(at(9, 23, 59, 30), 'filed', 'Filed.'), line(at(10, 0, 2, 5), 'admitted', 'Admitted.')]
  const steps = activityGroups({ timeline, sessions: [], now: 0, closed: true })[0]?.steps
  expect(steps?.map((s) => s.at)).toEqual(['23:59:30', '10 Nov 00:02'])
})

test('a stall or regression is failed, with the words after the colon as its detail', () => {
  const timeline = [
    line(at(9, 10, 0), 'stalled', 'Stalled: no output for 10 min'),
    line(at(9, 10, 1), 'regressed', 'Regressed.'),
    line(at(9, 10, 2), 'lead_gone', 'The lead ended: crashed'),
  ]
  const steps = activityGroups({ timeline, sessions: [], now: 0, closed: true })[0]?.steps ?? []
  expect(steps[0]).toMatchObject({ failed: true, detail: 'no output for 10 min' })
  expect(steps[1]?.failed).toBe(true)
  expect(steps[1]?.detail).toBeUndefined()
  expect(steps[2]?.failed).toBeUndefined()
  expect(steps[2]?.detail).toBeUndefined()
})

test('the series has one entry per session, oldest first', () => {
  const sessions = [
    session('a', { workingMs: 10, turns: 2, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }),
    session('b', { workingMs: 20, turns: 5 }),
  ]
  expect(attemptSeries(sessions)).toEqual({
    labels: ['Attempt 1', 'Attempt 2'],
    workingMs: [10, 20],
    turns: [2, 5],
    tokensOut: [2, 0],
  })
  expect(attemptSeries([]).labels).toEqual([])
})

test('the cache share is the read share of the prompt, null with nothing counted', () => {
  expect(cacheShare(tokens)).toBeNull()
  expect(cacheShare({ input: 10, output: 99, cacheRead: 80, cacheWrite: 10 })).toBe(0.8)
  expect(cacheShare({ input: 0, output: 0, cacheRead: 0, cacheWrite: 5 })).toBe(0)
})

test('regressions count the timeline or the watches, whichever is more', () => {
  const regressed = line(at(9, 10, 0), 'regressed', 'Regressed.')
  expect(regressionCount({ timeline: [], shipping: [] })).toBe(0)
  expect(regressionCount({ timeline: [regressed, regressed], shipping: [ship({}, watch('regressed'))] })).toBe(2)
  expect(regressionCount({ timeline: [], shipping: [ship({}, watch('regressed')), ship({}, watch('passed'))] })).toBe(1)
})

test('the checkpoint tally counts what waits on the owner', () => {
  const tally = checkpointTally({
    asks: [{ status: 'open' }, { status: 'answered' }, { status: 'open' }] as ReadIssueDetail['asks'],
    artifacts: [{ verdict: null }, { verdict: 'looks_good' }] as ReadIssueDetail['artifacts'],
    notes: [{}] as ReadIssueDetail['notes'],
  })
  expect(tally).toEqual({ decisions: 3, openDecisions: 2, artifacts: 2, awaitingVerdict: 1, notes: 1, open: 3 })
  expect(checkpointTally({ asks: [], artifacts: [], notes: [] }).open).toBe(0)
})

test('a chain around a ref skips unknown nodes and puts open links first', () => {
  const nodes = [node('me', 'Me'), node('b1', 'Zeta'), node('b2', 'Alpha'), node('b3', 'Mid'), node('d1', 'Down')]
  const edges = [
    { from: 'me', to: 'b1', closed: false },
    { from: 'me', to: 'b2', closed: true },
    { from: 'me', to: 'b3', closed: false },
    { from: 'me', to: 'ghost', closed: false },
    { from: 'd1', to: 'me', closed: false },
    { from: 'ghost', to: 'me', closed: false },
  ]
  const { blockedBy, blocks } = chainAround({ chain: { nodes, edges }, ref: 'me' })
  expect(blockedBy.map((l) => [l.node.id, l.closed])).toEqual([
    ['b3', false],
    ['b1', false],
    ['b2', true],
  ])
  expect(blocks.map((l) => l.node.id)).toEqual(['d1'])
  expect(chainAround({ chain: { nodes, edges }, ref: 'nobody' })).toEqual({ blockedBy: [], blocks: [] })
})

test('tab counts: activity lines, evidence with ships, checkpoints without notes', () => {
  expect(
    tabCounts({
      timeline: [line(at(9, 1, 0), 'filed', 'x')],
      shipping: [ship()],
      evidence: [{}, {}] as ReadIssueDetail['evidence'],
      asks: [{ status: 'open' }] as ReadIssueDetail['asks'],
      artifacts: [{ verdict: null }, { verdict: null }] as ReadIssueDetail['artifacts'],
      notes: [{}, {}, {}] as ReadIssueDetail['notes'],
    }),
  ).toEqual({ overview: null, activity: 1, evidence: 3, checkpoints: 3 })
})

test('a ship reads refused, regressed, passed, watching or shipped', () => {
  expect(shipStatus(ship({ result: 'refused', detail: 'no' }))).toEqual({ label: 'Refused', tone: 'bad' })
  expect(shipStatus(ship({}, watch('regressed')))).toEqual({ label: 'Regressed', tone: 'bad' })
  expect(shipStatus(ship({}, watch('passed')))).toEqual({ label: 'Passed', tone: 'good' })
  expect(shipStatus(ship({}, watch(null)))).toEqual({ label: 'Watching', tone: 'warn' })
  expect(shipStatus(ship({}, watch('ended')))).toEqual({ label: 'Shipped', tone: 'neutral' })
  expect(shipStatus(ship())).toEqual({ label: 'Shipped', tone: 'neutral' })
})

test('the next actions are the first open Decision and the first artifact without a verdict', () => {
  const asks = [
    { id: 'a1', status: 'answered' },
    { id: 'a2', status: 'open' },
  ] as ReadIssueDetail['asks']
  const artifacts = [
    { id: 'r1', verdict: 'looks_good' },
    { id: 'r2', verdict: null },
  ] as ReadIssueDetail['artifacts']
  expect(nextActions({ asks, artifacts })).toEqual({ decisionId: 'a2', artifactId: 'r2' })
  expect(nextActions({ asks: [], artifacts: [] })).toEqual({ decisionId: null, artifactId: null })
})

test('an option is recommended when the recommendation is or starts with its label, whole word, any case', () => {
  const ask = { recommendation: 'Option A: it is cheaper', default: 'Option B', answer: 'Option B' }
  expect(optionChips('option a', ask)).toEqual(['Recommended'])
  expect(optionChips('Option B', ask)).toEqual(['Default', 'Answer'])
  expect(optionChips('Option', { ...ask, default: null, answer: null })).toEqual(['Recommended'])
  expect(optionChips('Opt', { ...ask, default: null, answer: null })).toEqual([])
  expect(optionChips('', { ...ask, default: null, answer: null })).toEqual([])
})

test('session states have an explicit tone: working accent, trouble warn, the rest quiet', () => {
  expect(SESSION_TONES.working).toBe('accent')
  expect(SESSION_TONES.stuck).toBe('warn')
  expect(SESSION_TONES.dead).toBe('neutral')
})

test('only a green verify run passed', () => {
  expect(checkPassed('green')).toBe(true)
  expect(checkPassed('red')).toBe(false)
  expect(checkPassed('blocked')).toBe(false)
  expect(checkPassed('whatever')).toBe(false)
})
