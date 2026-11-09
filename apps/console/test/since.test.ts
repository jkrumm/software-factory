import { describe, expect, test } from 'bun:test'
import type { SinceItem, SinceModel } from '@software-factory/contract'
import {
  agoWords,
  clockOf,
  visitWords,
  isQuiet,
  originBreakdown,
  SHOWN,
  SINCE_KEYS,
  SINCE_LABEL,
  SINCE_TONE,
  sinceRows,
} from '../src/lib/since.ts'

const item = (n: number): SinceItem => ({
  issue: `issue_${n}`,
  title: `Item ${n}`,
  repo: 'argo',
  at: new Date(Date.UTC(2026, 0, 1, 10, n)).toISOString(),
})

const category = (count: number, items: SinceItem[] = []) => ({ count, items })

const model = (over: Partial<SinceModel['categories']> = {}): SinceModel => ({
  at: '2026-01-01T12:00:00.000Z',
  since: '2026-01-01T09:12:00.000Z',
  categories: {
    shipped: category(0),
    failed: category(0),
    dropped: category(0),
    judge: category(0),
    screen: category(0),
    filed: { count: 0, byOrigin: [], items: [] },
    incidents: category(0),
    ...over,
  },
})

describe('sinceRows', () => {
  test('the categories read in a fixed order with their labels and tones', () => {
    const rows = sinceRows(model())
    expect(rows.map((r) => r.key)).toEqual([...SINCE_KEYS])
    expect(rows.map((r) => r.label)).toEqual([
      'Shipped and verified',
      'Regressed',
      'Dropped',
      'Settled by the Judge',
      'Turned away',
      'New Issues',
      'Incidents',
    ])
    expect(Object.keys(SINCE_LABEL)).toEqual([...SINCE_KEYS])
    expect(Object.keys(SINCE_TONE)).toEqual([...SINCE_KEYS])
    expect(rows.find((r) => r.key === 'failed')?.tone).toBe('bad')
    expect(rows.find((r) => r.key === 'shipped')?.tone).toBe('good')
  })

  test('the Judge and the screen carry an InfoHint word, nothing else does', () => {
    const hints = sinceRows(model()).map((r) => [r.key, r.hint])
    expect(hints.filter(([, hint]) => hint)).toEqual([
      ['judge', 'judge'],
      ['screen', 'screen'],
    ])
  })

  test('three items show, the rest fold, and a count beyond what arrived says "and N more"', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8].map(item)
    const row = sinceRows(model({ shipped: category(11, items) })).find((r) => r.key === 'shipped')
    expect(SHOWN).toBe(3)
    expect(row?.shown.map((i) => i.title)).toEqual(['Item 8', 'Item 7', 'Item 6'])
    expect(row?.folded).toHaveLength(5)
    expect(row?.more).toBe(3)
  })

  test('a few items fold nothing and owe nothing', () => {
    const row = sinceRows(model({ dropped: category(2, [item(1), item(2)]) })).find((r) => r.key === 'dropped')
    expect(row?.shown).toHaveLength(2)
    expect(row?.folded).toEqual([])
    expect(row?.more).toBe(0)
  })

  test('New Issues carry the by-origin breakdown, no other category does', () => {
    const rows = sinceRows(
      model({
        filed: {
          count: 3,
          byOrigin: [
            { origin: 'github', count: 1 },
            { origin: 'you', count: 2 },
          ],
          items: [],
        },
      }),
    )
    expect(rows.find((r) => r.key === 'filed')?.breakdown).toBe('2 you, 1 GitHub')
    expect(rows.filter((r) => r.breakdown !== null)).toHaveLength(1)
  })
})

test('originBreakdown uses origin words, the biggest first, and says nothing for none', () => {
  expect(
    originBreakdown([
      { origin: 'feedback', count: 1 },
      { origin: 'infrastructure', count: 4 },
      { origin: 'factory', count: 0 },
    ]),
  ).toBe('4 infrastructure, 1 feedback')
  expect(originBreakdown([])).toBeNull()
})

test('the band is quiet only when every count is zero', () => {
  expect(isQuiet(sinceRows(model()))).toBe(true)
  expect(isQuiet(sinceRows(model({ incidents: category(1, [item(1)]) })))).toBe(false)
})

test('agoWords and clockOf phrase the time', () => {
  expect(agoWords(10_000)).toBe('just now')
  expect(agoWords(3 * 60 * 60_000)).toBe('3 hours ago')
  expect(agoWords(-5)).toBe('just now')
  expect(clockOf('2026-01-01T09:12:00.000Z')).toMatch(/^\d{2}:\d{2}$/)
})

test('the visit reads as an age and the weekday with the clock', () => {
  const at = '2026-01-01T09:12:00.000Z'
  expect(visitWords(at, Date.parse(at) + 3 * 60 * 60_000)).toMatch(/^3 hours ago \u00b7 \w+ \d{2}:\d{2}$/)
})
