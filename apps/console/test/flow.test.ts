import { expect, test } from 'bun:test'
import type { FlowModel } from '@software-factory/contract'
import {
  boardColumns,
  boardNote,
  boardOf,
  columnKeyOf,
  columnWeight,
  countsOf,
  defaultTab,
  facetCounts,
  type Origin,
  openCount,
  originsOf,
  originWord,
  projectsOf,
  countWords,
  longestWords,
  numberOf,
  shortDate,
  statsOf,
  xLabelsOf,
  visibleColumns,
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
    { repo: 'chat', open: 2, working: 0, queued: 1 },
    { repo: 'argo', open: 2, working: 0, queued: 1 },
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
  const board = boardOf(data)
  expect(board.waiting[0]?.reason).toBe('decision')
  expect(board.queued[0]?.reason).toBe('waits for another change')
  expect(board.queued[1]?.reason).toBeNull()
  expect(board.settling[0]?.reason).toBeNull()
  expect(board.closed[0]).toMatchObject({ reason: null, state: 'healed', since: SINCE })
})

test('filters narrow every column; an unknown value gives empty columns', () => {
  expect(countsOf(boardOf(data, { project: 'chat' }))).toMatchObject({ settling: 0, queued: 1, waiting: 1, closed: 0 })
  expect(countsOf(boardOf(data, { origin: 'you' }))).toMatchObject({ queued: 2, waiting: 0, closed: 0 })
  expect(countsOf(boardOf(data, { project: 'chat', origin: 'you' }))).toMatchObject({ queued: 1, waiting: 0 })
  const none = countsOf(boardOf(data, { project: 'nope' }))
  expect(Object.values(none).every((n) => n === 0)).toBe(true)
})

test('options come from the data, sorted', () => {
  expect(projectsOf(data)).toEqual(['argo', 'chat', 'harbor'])
  expect(originsOf(data)).toEqual(['you', 'github', 'feedback', 'factory'])
})

test('the default tab is Working, else the first column with cards', () => {
  expect(defaultTab(countsOf(boardOf(data)))).toBe('settling')
  const working = {
    ...data,
    states: { ...data.states, working: { count: 1, issues: [issue('issue_9', 'argo', 'you')] } },
  }
  expect(defaultTab(countsOf(boardOf(working)))).toBe('working')
  expect(defaultTab(countsOf(boardOf(data, { project: 'nope' })))).toBe('working')
})

test('the note counts open and closed', () => {
  expect(boardNote(countsOf(boardOf(data)))).toBe('4 open, 1 closed in the last day')
})

test('a state value names a column or is dropped', () => {
  expect(columnKeyOf('working')).toBe('working')
  expect(columnKeyOf('closed')).toBe('closed')
  expect(columnKeyOf('nope')).toBeUndefined()
  expect(columnKeyOf(undefined)).toBeUndefined()
})

test('a state shows one column and leaves the rows alone', () => {
  expect(visibleColumns('waiting')).toEqual(['waiting'])
  expect(visibleColumns()).toHaveLength(6)
  expect(countsOf(boardOf(data, { state: 'waiting' }))).toEqual(countsOf(boardOf(data)))
})

test('facet counts cover every column before any filter', () => {
  expect(facetCounts(data, 'repo')).toEqual({ argo: 2, chat: 2, harbor: 1 })
  expect(facetCounts(data, 'origin')).toEqual({ feedback: 1, you: 2, github: 1, factory: 1 })
})

test('a card has its number, kind and state (the column, or the outcome when closed)', () => {
  const board = boardOf(data)
  expect(numberOf('issue_12')).toBe(12)
  expect(board.waiting[0]).toMatchObject({ number: 4, kind: 'feature', state: 'waiting' })
  expect(board.queued[1]).toMatchObject({ number: 3, state: 'queued' })
  expect(board.closed[0]).toMatchObject({ number: 5, kind: 'incident', state: 'healed' })
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
  expect(queued).toMatchObject({ value: 2, delta: -1, higherIsBetter: false, sub: '1 chain, 1 ready' })
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
  const counts = countsOf(boardOf(data))
  const sidebar = openCount(counts)
  expect(sidebar).toBe(4)
  expect(boardNote(counts)).toBe(`${sidebar} open, 1 closed in the last day`)
  expect(sidebar).not.toBe(counts.working)
})

test('columnWeight: empty columns are narrow, crowded ones wide, Closed recently the widest', () => {
  expect(columnWeight('working', 0)).toBeLessThan(columnWeight('working', 1))
  expect(columnWeight('waiting', 1)).toBeLessThan(columnWeight('waiting', 10))
  expect(columnWeight('closed', 112)).toBeGreaterThan(columnWeight('waiting', 112))
  expect(columnWeight('closed', 0)).toBe(columnWeight('working', 0))
})

test('boardColumns: one track per shown column, an empty one with the smaller minimum', () => {
  const counts = { settling: 0, queued: 0, working: 1, waiting: 1, watching: 0, closed: 112 }
  expect(boardColumns(['working', 'watching', 'closed'], counts)).toBe(
    'minmax(15rem, 1fr) minmax(11rem, 0.6fr) minmax(15rem, 2fr)',
  )
})
