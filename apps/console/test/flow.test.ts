import { expect, test } from 'bun:test'
import type { FlowModel } from '@software-factory/contract'
import {
  cardsOf,
  countsOf,
  defaultSort,
  DEFAULT_TREND_RANGE,
  flowNote,
  listOf,
  listStateOf,
  type Origin,
  openCount,
  openSplits,
  originsOf,
  originWord,
  projectsOf,
  countWords,
  flowCounts,
  longestWords,
  numberOf,
  shortDate,
  statsOf,
  singleProject,
  sortedCards,
  startSort,
  TREND_RANGES,
  xLabelsOf,
} from '../src/lib/flow.ts'

const SINCE = '2026-11-08T10:00:00.000Z'
const issue = (id: string, repo: string, origin: Origin, extra: Record<string, unknown> = {}) => ({
  id,
  repo,
  title: `Title ${id}`,
  origin,
  kind: 'feature' as const,
  since: SINCE,
  waitReason: null,
  queue: null,
  ...extra,
})

const data = {
  at: SINCE,
  states: {
    settling: { count: 1, issues: [issue('issue_1', 'argo', 'feedback')] },
    queued: {
      count: 2,
      issues: [
        issue('issue_2', 'argo', 'you', {
          queue: { kind: 'chain', message: 'waits for another change', opensAt: null },
        }),
        issue('issue_3', 'chat', 'you'),
      ],
    },
    working: { count: 0, issues: [] },
    waiting: { count: 1, issues: [issue('issue_4', 'chat', 'github', { waitReason: 'decision' })] },
    watching: { count: 0, issues: [] },
  },
  closedRecently: [
    {
      id: 'issue_5',
      repo: 'harbor',
      title: 'Old',
      origin: 'factory',
      kind: 'incident',
      outcome: 'healed',
      closedAt: SINCE,
    },
  ],
  perProject: [
    { repo: 'chat', open: 2, working: 0, waiting: 1, queued: 1 },
    { repo: 'argo', open: 2, working: 0, waiting: 0, queued: 2 },
  ],
  queueStates: { global: 'run', projects: {} },
  trend: {
    at: Array.from({ length: 8 }, (_, i) => new Date(Date.parse(SINCE) - (7 - i) * 86_400_000).toISOString()),
    states: {
      settling: [0, 0, 0, 0, 0, 0, 1, 1],
      queued: [3, 3, 2, 2, 2, 2, 2, 2],
      working: [1, 2, 2, 3, 3, 2, 1, 2],
      waiting: [0, 0, 1, 1, 1, 1, 1, 1],
      watching: [0, 0, 0, 0, 0, 0, 0, 0],
    },
    shipped: [1, 0, 2, 0, 1, 1, 3],
    shippedBefore: 5,
  },
} as unknown as FlowModel

test('origins are words', () => {
  expect(originWord('you')).toBe('You')
  expect(originWord('github')).toBe('GitHub')
  expect(originWord('infrastructure')).toBe('Infrastructure')
  expect(originWord('feedback')).toBe('Feedback')
})

test('the reason line: wait reason, queue message only when present; a closed card carries the outcome as its state', () => {
  const cards = cardsOf(data)
  expect(cards.waiting[0]?.reason).toBe('decision')
  expect(cards.queued[0]?.reason).toBe('waits for another change')
  expect(cards.queued[1]?.reason).toBeNull()
  expect(cards.settling[0]?.reason).toBeNull()
  expect(cards.closed[0]).toMatchObject({ reason: null, state: 'healed', since: SINCE })
})

test('filters narrow every state; an unknown value gives none', () => {
  expect(countsOf(cardsOf(data, { project: 'chat' }))).toMatchObject({ settling: 0, queued: 1, waiting: 1, closed: 0 })
  expect(countsOf(cardsOf(data, { origin: 'you' }))).toMatchObject({ queued: 2, waiting: 0, closed: 0 })
  expect(countsOf(cardsOf(data, { project: 'chat', origin: 'you' }))).toMatchObject({ queued: 1, waiting: 0 })
  const none = countsOf(cardsOf(data, { project: 'nope' }))
  expect(Object.values(none).every((n) => n === 0)).toBe(true)
})

test('options come from the data, sorted', () => {
  expect(projectsOf(data)).toEqual(['argo', 'chat', 'harbor'])
  expect(originsOf(data)).toEqual(['you', 'github', 'feedback', 'factory'])
})

test('the note counts open and closed', () => {
  expect(flowNote(countsOf(cardsOf(data)))).toBe('4 open, 1 closed in the last day')
})

test('a state value names a list or is dropped', () => {
  expect(listStateOf('working')).toBe('working')
  expect(listStateOf('closed')).toBe('closed')
  expect(listStateOf('watching')).toBeUndefined()
  expect(listStateOf('nope')).toBeUndefined()
  expect(listStateOf(undefined)).toBeUndefined()
})

test('a state leaves the cards alone and picks what the list shows: a count takes its states in', () => {
  expect(countsOf(cardsOf(data, { state: 'waiting' }))).toEqual(countsOf(cardsOf(data)))
  const cards = cardsOf(data)
  expect(listOf(cards, 'waiting').map((c) => c.number)).toEqual([4])
  // queued takes settling in: the number the strip shows
  expect(listOf(cards, 'queued').map((c) => c.number)).toEqual([1, 2, 3])
  expect(listOf(cards, 'working')).toEqual([])
  expect(listOf(cards, 'closed').map((c) => c.number)).toEqual([5])
  // no state: every open Issue, then what closed lately
  expect(listOf(cards).map((c) => c.number)).toEqual([1, 2, 3, 4, 5])
})

test('the list sorts by the pressed column and keeps the order of ties', () => {
  const cards = listOf(cardsOf(data))
  expect(sortedCards(cards, startSort('number')).map((c) => c.number)).toEqual([5, 4, 3, 2, 1])
  expect(sortedCards(cards, { key: 'project', direction: 'asc' }).map((c) => c.repo)).toEqual([
    'argo',
    'argo',
    'chat',
    'chat',
    'harbor',
  ])
  // every card has the same `since`: a sort by it leaves the order alone, either way
  expect(sortedCards(cards, { key: 'since', direction: 'desc' }).map((c) => c.number)).toEqual([1, 2, 3, 4, 5])
  expect(sortedCards(cards, { key: 'title', direction: 'desc' }).map((c) => c.number)).toEqual([4, 3, 2, 1, 5])
  expect(defaultSort('working')).toEqual({ key: 'since', direction: 'asc' })
  expect(defaultSort('closed')).toEqual({ key: 'since', direction: 'desc' })
})

test('the list belongs to one project only when its rows do', () => {
  expect(singleProject(listOf(cardsOf(data, { project: 'chat' })))).toBe('chat')
  expect(singleProject(listOf(cardsOf(data)))).toBeNull()
  expect(singleProject([])).toBeNull()
})

test('the trend control: 24 hours and 7 days by the hour, 30 days by the day, opening on 7 days', () => {
  expect(TREND_RANGES.map((r) => [r.label, r.window, r.bucket])).toEqual([
    ['24 h', '24h', 'hour'],
    ['7 d', '7d', 'hour'],
    ['30 d', '30d', 'day'],
  ])
  expect(DEFAULT_TREND_RANGE.key).toBe('7d')
})

test('the sidebar counts open Issues as working, waiting and queued, never a closed one', () => {
  // harbor has only a closed Issue: no entry, so its row shows no figure; argo's settling Issue is queued
  expect(openSplits(data, 'repo')).toEqual({
    argo: { working: 0, waiting: 0, queued: 2 },
    chat: { working: 0, waiting: 1, queued: 1 },
  })
  expect(openSplits(data, 'origin')).toEqual({
    feedback: { working: 0, waiting: 0, queued: 1 },
    you: { working: 0, waiting: 0, queued: 2 },
    github: { working: 0, waiting: 1, queued: 0 },
  })
})

test('working includes watching, queued includes settling: the sidebar, the strip and the cards count alike', () => {
  const states = {
    ...data.states,
    working: { count: 2, issues: [issue('issue_6', 'argo', 'you'), issue('issue_7', 'harbor', 'you')] },
    watching: { count: 1, issues: [issue('issue_8', 'argo', 'you')] },
  }
  const model = { ...data, states }
  expect(openSplits(model, 'repo')).toEqual({
    argo: { working: 2, waiting: 0, queued: 2 },
    chat: { working: 0, waiting: 1, queued: 1 },
    harbor: { working: 1, waiting: 0, queued: 0 },
  })
  // the strip's figures
  expect(flowCounts(model)).toEqual({ working: 3, waiting: 1, queued: 3 })
  // the stat cards show the same figures, and the splits of every project add up to them
  const [working, waiting, queued] = statsOf(model, Date.parse(SINCE))
  expect([working?.value, waiting?.value, queued?.value]).toEqual([3, 1, 3])
  expect(working?.sub).toBe('in 2 projects, 1 of them watching')
  const splits = Object.values(openSplits(model, 'repo'))
  expect([
    splits.reduce((n, split) => n + split.working, 0),
    splits.reduce((n, split) => n + split.waiting, 0),
    splits.reduce((n, split) => n + split.queued, 0),
  ]).toEqual([3, 1, 3])
})

test('a card has its number, kind and state (the state, or the outcome when closed)', () => {
  const cards = cardsOf(data)
  expect(numberOf('issue_12')).toBe(12)
  expect(cards.waiting[0]).toMatchObject({ number: 4, kind: 'feature', state: 'waiting' })
  expect(cards.queued[1]).toMatchObject({ number: 3, state: 'queued' })
  expect(cards.closed[0]).toMatchObject({ number: 5, kind: 'incident', state: 'healed' })
})

test('x labels: the first day, the middle one and Now', () => {
  const labels = xLabelsOf(data.trend.at)
  expect(labels[0]).toBe(shortDate(data.trend.at[0] ?? ''))
  expect(labels[1]).toBe(shortDate(data.trend.at[3] ?? ''))
  expect(labels[2]).toBe('Now')
  expect(shortDate(SINCE)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/)
})

test('counts in words, biggest first, null named', () => {
  expect(countWords(['decision', 'review', 'decision', null], 'unknown')).toBe('2 decision, 1 review, 1 unknown')
  expect(countWords(['claim_stall'], 'x')).toBe('1 claim stall')
  expect(countWords([], 'x')).toBe('')
})

test('the longest time in a state', () => {
  const now = Date.parse(SINCE) + 3 * 3_600_000
  expect(longestWords([SINCE, new Date(now - 60_000).toISOString()], now)).toBe('3 h')
  expect(longestWords([], now)).toBe('None')
})

test('the stat row: live counts, trend deltas, subs, footers and the 7-day sums', () => {
  const now = Date.parse(SINCE) + 2 * 3_600_000
  const [working, waiting, queued, shipped] = statsOf(data, now)
  expect(working).toMatchObject({
    title: 'Working',
    value: 0,
    delta: 1,
    higherIsBetter: true,
    sub: 'Nothing running',
    state: 'working',
  })
  expect(working?.series).toEqual([1, 2, 2, 3, 3, 2, 1, 2])
  expect(working?.footer).toEqual([
    { label: 'Oldest', value: 'None' },
    { label: 'Queue', value: 'Run' },
  ])
  expect(waiting).toMatchObject({ value: 1, delta: 1, higherIsBetter: false, sub: '1 decision' })
  expect(waiting?.footer[0]).toEqual({ label: 'Oldest', value: '2 h' })
  // queued counts the settling Issue: its sample is the sum of both states
  expect(queued).toMatchObject({ value: 3, delta: 0, higherIsBetter: false, sub: '1 chain, 1 ready, 1 settling' })
  expect(queued?.series).toEqual([3, 3, 2, 2, 2, 2, 3, 3])
  expect(queued?.footer[1]).toEqual({ label: 'Projects', value: '2' })
  expect(shipped).toMatchObject({
    title: 'Shipped this week',
    value: 8,
    delta: 3,
    sub: '5 in the 7 days before',
    state: 'closed',
  })
  expect(shipped?.bars).toEqual([1, 0, 2, 0, 1, 1, 3])
  expect(shipped?.footer).toEqual([
    { label: 'Best day', value: '3' },
    { label: 'Last day', value: '3' },
  ])
  expect(shipped?.labels).toHaveLength(7)
})

test('the sidebar count and the Flow note share one open count, which is not the working count', () => {
  const counts = countsOf(cardsOf(data))
  const sidebar = openCount(counts)
  expect(sidebar).toBe(4)
  expect(flowNote(counts)).toBe(`${sidebar} open, 1 closed in the last day`)
  expect(sidebar).not.toBe(counts.working)
})
