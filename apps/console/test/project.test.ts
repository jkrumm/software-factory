import { expect, test } from 'bun:test'
import { dayLabels, hygieneLine, laneWords, nextRows, planSummary } from '../src/lib/project.ts'

const row = (key: string, state: 'done' | 'open' | 'filable' | 'waiting') => ({ key, state })

test('the plan summary counts each state and the done share', () => {
  const summary = planSummary([
    row('a', 'done'),
    row('b', 'done'),
    row('c', 'open'),
    row('d', 'filable'),
    row('e', 'waiting'),
  ])
  expect(summary).toEqual({ total: 5, done: 2, open: 1, filable: 1, waiting: 1, percent: 40 })
  expect(planSummary([]).percent).toBeNull()
})

test('the next rows drop the done ones and put the open ones first, then those that may file, in plan order', () => {
  const rows = [row('a', 'waiting'), row('b', 'done'), row('c', 'filable'), row('d', 'open'), row('e', 'filable')]
  expect(nextRows(rows).map((r) => r.key)).toEqual(['d', 'c', 'e', 'a'])
})

test('seven day labels end at the given day', () => {
  const labels = dayLabels('2026-11-16T12:00:00Z')
  expect(labels).toHaveLength(7)
  expect(new Set(labels).size).toBe(7)
})

test('the hygiene line says never, clean or the finding count with the age', () => {
  const age = (ms: number) => `${Math.round(ms / 3_600_000)} h ago`
  const now = Date.parse('2026-11-16T12:00:00Z')
  expect(hygieneLine({ lastPassAt: null, outcome: null, findings: 0 }, now, age)).toBe('Never swept')
  expect(hygieneLine({ lastPassAt: '2026-11-16T10:00:00Z', outcome: 'answered', findings: 0 }, now, age)).toBe(
    'Clean 2 h ago',
  )
  expect(hygieneLine({ lastPassAt: '2026-11-16T10:00:00Z', outcome: 'answered', findings: 1 }, now, age)).toBe(
    '1 finding, 2 h ago',
  )
  expect(hygieneLine({ lastPassAt: '2026-11-16T10:00:00Z', outcome: 'answered', findings: 3 }, now, age)).toBe(
    '3 findings, 2 h ago',
  )
})

test('lanes read as words with their memory', () => {
  expect(laneWords({ apple: { leads: 1, memoryMib: 18432 }, light: { leads: 4, memoryMib: null } })).toEqual([
    'apple: 1 at once (18 GiB each)',
    'light: 4 at once',
  ])
})
