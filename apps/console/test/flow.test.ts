import { expect, test } from 'bun:test'
import { type FlowModel, workCountsOf } from '@software-factory/contract'
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
    { repo: 'chat', open: 2 },
    { repo: 'argo', open: 2 },
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

/** The model as the server sends it: `work` is the five words of the open Issues. */
const withWork = (model: FlowModel): FlowModel => ({
  ...model,
  work: workCountsOf(
    (['settling', 'queued', 'working', 'waiting', 'watching'] as const).flatMap((state) =>
      model.states[state].issues.map((i) => ({ state, waitReason: i.waitReason, queueKind: i.queue?.kind ?? null })),
    ),
  ),
})

test('origins are words', () => {
  expect(originWord('you')).toBe('You')
  expect(originWord('github')).toBe('GitHub')
  expect(originWord('infrastructure')).toBe('Infrastructure')
  expect(originWord('feedback')).toBe('Feedback')
})

test('the reason line: wait reason, queue message only when present; a closed card carries the outcome as its state', () => {
  const cards = cardsOf(data)
  expect(cards.paused[0]?.reason).toBe('On you: a Decision')
  expect(cards.held.map((card) => card.reason)).toEqual(['Being settled', 'waits for another change'])
  expect(cards.ready[0]?.reason).toBeNull()
  expect(cards.closed[0]).toMatchObject({ reason: null, state: 'healed', since: SINCE })
})

test('filters narrow every state; an unknown value gives none', () => {
  expect(countsOf(cardsOf(data, { project: 'chat' }))).toMatchObject({ held: 0, ready: 1, paused: 1, closed: 0 })
  expect(countsOf(cardsOf(data, { origin: 'you' }))).toMatchObject({ held: 1, ready: 1, paused: 0, closed: 0 })
  expect(countsOf(cardsOf(data, { project: 'chat', origin: 'you' }))).toMatchObject({ ready: 1, paused: 0 })
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

test('a state value names a list or is dropped; the stored names of an old link read as their word', () => {
  expect(listStateOf('running')).toBe('running')
  expect(listStateOf('closed')).toBe('closed')
  expect(listStateOf('working')).toBe('running')
  expect(listStateOf('waiting')).toBe('paused')
  expect(listStateOf('queued')).toBe('ready')
  expect(listStateOf('settling')).toBe('held')
  expect(listStateOf('watching')).toBe('checking')
  expect(listStateOf('nope')).toBeUndefined()
  expect(listStateOf(undefined)).toBeUndefined()
})

test('a state leaves the cards alone and picks what the list shows: one word, or what closed lately', () => {
  expect(countsOf(cardsOf(data, { state: 'paused' }))).toEqual(countsOf(cardsOf(data)))
  const cards = cardsOf(data)
  expect(listOf(cards, 'paused').map((c) => c.number)).toEqual([4])
  expect(listOf(cards, 'held').map((c) => c.number)).toEqual([1, 2])
  expect(listOf(cards, 'ready').map((c) => c.number)).toEqual([3])
  expect(listOf(cards, 'running')).toEqual([])
  expect(listOf(cards, 'closed').map((c) => c.number)).toEqual([5])
  // no state: every open Issue, then what closed lately
  expect(listOf(cards).map((c) => c.number)).toEqual([4, 3, 1, 2, 5])
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
  expect(sortedCards(cards, { key: 'since', direction: 'desc' }).map((c) => c.number)).toEqual([4, 3, 1, 2, 5])
  expect(sortedCards(cards, { key: 'title', direction: 'desc' }).map((c) => c.number)).toEqual([4, 3, 2, 1, 5])
  expect(defaultSort('running')).toEqual({ key: 'since', direction: 'asc' })
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

test('the sidebar counts open Issues by the five words, never a closed one', () => {
  // harbor has only a closed Issue: no entry, so its row shows no figure; argo's settling Issue is held, as is its chained one
  const argo = openSplits(data, 'repo').argo
  expect(argo).toMatchObject({ running: 0, paused: 0, ready: 0, held: 2, checking: 0 })
  expect(argo?.split.held).toEqual({ issue: 1, line: 0, drain: 0, spec: 0, settling: 1 })
  expect(openSplits(data, 'repo').chat).toMatchObject({ paused: 1, ready: 1, held: 0 })
  expect(openSplits(data, 'repo').harbor).toBeUndefined()
  expect(openSplits(data, 'origin').github).toMatchObject({ paused: 1 })
})

test('Checking is its own word; the sidebar, the strip and the cards count alike', () => {
  const states = {
    ...data.states,
    working: { count: 2, issues: [issue('issue_6', 'argo', 'you'), issue('issue_7', 'harbor', 'you')] },
    watching: { count: 1, issues: [issue('issue_8', 'argo', 'you')] },
  }
  const model = withWork({ ...data, states })
  expect(model.work).toMatchObject({ running: 2, paused: 1, ready: 1, held: 2, checking: 1 })
  expect(openSplits(model, 'repo').argo).toMatchObject({ running: 1, held: 2, checking: 1 })
  // the stat cards show the figures of the strip, Not started being Ready and Held together
  const [running, paused, notStarted] = statsOf(model, Date.parse(SINCE))
  expect([running?.value, paused?.value, notStarted?.value]).toEqual([2, 1, 3])
  expect(running?.sub).toBe('in 2 projects, 1 more checking')
  const splits = Object.values(openSplits(model, 'repo'))
  expect(splits.reduce((n, split) => n + split.running, 0)).toBe(model.work.running)
  expect(splits.reduce((n, split) => n + split.checking, 0)).toBe(model.work.checking)
})

test('a card has its number, kind and state (the state, or the outcome when closed)', () => {
  const cards = cardsOf(data)
  expect(numberOf('issue_12')).toBe(12)
  expect(cards.paused[0]).toMatchObject({ number: 4, kind: 'feature', state: 'paused', split: 'you' })
  expect(cards.ready[0]).toMatchObject({ number: 3, state: 'ready', split: 'seat' })
  expect(cards.held[1]).toMatchObject({ number: 2, state: 'held', split: 'issue' })
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
  const [running, paused, notStarted, shipped] = statsOf(withWork(data), now)
  expect(running).toMatchObject({
    title: 'Running',
    value: 0,
    delta: 1,
    higherIsBetter: true,
    sub: 'Nothing running',
    state: 'running',
  })
  expect(running?.series).toEqual([1, 2, 2, 3, 3, 2, 1, 2])
  expect(running?.footer).toEqual([
    { label: 'Oldest', value: 'None' },
    { label: 'Queue', value: 'Run' },
  ])
  expect(paused).toMatchObject({ value: 1, delta: 1, higherIsBetter: false, sub: 'on you 1', state: 'paused' })
  expect(paused?.footer[0]).toEqual({ label: 'Oldest', value: '2 h' })
  // not started is Ready and Held: its sample is the sum of both stored states
  expect(notStarted).toMatchObject({ title: 'Not started', value: 3, delta: 0, sub: '1 ready, 2 held', state: 'ready' })
  expect(notStarted?.series).toEqual([3, 3, 2, 2, 2, 2, 3, 3])
  expect(notStarted?.footer[1]).toEqual({ label: 'Projects', value: '2' })
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
  expect(sidebar).not.toBe(counts.running)
})
