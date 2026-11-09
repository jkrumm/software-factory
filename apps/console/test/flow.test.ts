import { expect, test } from 'bun:test'
import type { FlowModel } from '@software-factory/contract'
import {
  boardNote,
  boardOf,
  columnKeyOf,
  countsOf,
  defaultTab,
  facetCounts,
  type Origin,
  originsOf,
  originWord,
  projectsOf,
  visibleColumns,
} from '../src/lib/flow.ts'

const SINCE = '2026-11-08T10:00:00.000Z'
const issue = (id: string, repo: string, origin: Origin, extra: Record<string, unknown> = {}) => ({
  id,
  repo,
  title: `Title ${id}`,
  origin,
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
    { id: 'issue_5', repo: 'harbor', title: 'Old', origin: 'factory', outcome: 'healed', closedAt: SINCE },
  ],
  perProject: [
    { repo: 'chat', open: 2, working: 0, queued: 1 },
    { repo: 'argo', open: 2, working: 0, queued: 1 },
  ],
  queueStates: { global: 'run', projects: {} },
} as unknown as FlowModel

test('origins are words', () => {
  expect(originWord('you')).toBe('You')
  expect(originWord('github')).toBe('GitHub')
  expect(originWord('infrastructure')).toBe('Infrastructure')
  expect(originWord('feedback')).toBe('Feedback')
})

test('the reason line: wait reason, queue message only when present, outcome for closed', () => {
  const board = boardOf(data)
  expect(board.waiting[0]?.reason).toBe('decision')
  expect(board.queued[0]?.reason).toBe('waits for another change')
  expect(board.queued[1]?.reason).toBeNull()
  expect(board.settling[0]?.reason).toBeNull()
  expect(board.closed[0]).toMatchObject({ reason: 'Healed', since: SINCE })
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
