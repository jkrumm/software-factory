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
  SINCE_SUBTITLE,
  SINCE_TONE,
  sinceRows,
  windowWords,
} from '../src/lib/since.ts'
import { LANGUAGE } from '../src/lib/language.gen.ts'

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
    errands: category(0),
    filed: { count: 0, byOrigin: [], items: [] },
    incidents: category(0),
    ...over,
  },
})

describe('sinceRows', () => {
  const everything = model({
    shipped: category(1, [item(1)]),
    failed: category(1, [item(2)]),
    dropped: category(1, [item(3)]),
    judge: category(1, [item(4)]),
    screen: category(1, [item(5)]),
    errands: category(1, [item(6)]),
    filed: { count: 1, byOrigin: [{ origin: 'you', count: 1 }], items: [item(7)] },
    incidents: category(1, [item(8)]),
  })

  test('what he may act on reads first: Regressed and Incidents, then Dropped, then what settled without him', () => {
    const rows = sinceRows(everything)
    expect(rows.map((r) => r.key)).toEqual([
      'failed',
      'incidents',
      'dropped',
      'shipped',
      'filed',
      'judge',
      'screen',
      'errands',
    ])
    expect(rows.map((r) => r.key)).toEqual([...SINCE_KEYS])
    expect(rows.map((r) => r.label)).toEqual([
      'Regressed',
      'Incidents',
      'Dropped',
      'Shipped and verified',
      'New Issues',
      'Answered by the Judge',
      'Turned away',
      'Errands closed without you',
    ])
    expect(Object.keys(SINCE_LABEL).toSorted()).toEqual(SINCE_KEYS.toSorted())
    expect(Object.keys(SINCE_TONE).toSorted()).toEqual(SINCE_KEYS.toSorted())
    expect(rows.find((r) => r.key === 'failed')?.tone).toBe('bad')
    expect(rows.find((r) => r.key === 'shipped')?.tone).toBe('good')
  })

  test('a category nothing happened in is absent, whatever its neighbours hold', () => {
    const rows = sinceRows(model({ shipped: category(2, [item(1), item(2)]), incidents: category(1, [item(3)]) }))
    expect(rows.map((r) => r.key)).toEqual(['incidents', 'shipped'])
    expect(sinceRows(model())).toEqual([])
  })

  test('every shown category has a plain subtitle and an InfoHint word', () => {
    const rows = sinceRows(everything)
    expect(rows).toHaveLength(SINCE_KEYS.length)
    for (const row of rows) {
      expect(row.subtitle.length, row.key).toBeGreaterThan(20)
      expect(LANGUAGE[row.hint].length, row.key).toBeGreaterThan(10)
    }
    expect(Object.keys(SINCE_SUBTITLE).toSorted()).toEqual(SINCE_KEYS.toSorted())
    expect(rows.find((r) => r.key === 'shipped')?.subtitle).toBe('Live, and its check passed. Nothing to do.')
    expect(rows.map((r) => [r.key, r.hint])).toEqual([
      ['failed', 'regressed'],
      ['incidents', 'incident'],
      ['dropped', 'dropped'],
      ['shipped', 'verified'],
      ['filed', 'filed'],
      ['judge', 'judge'],
      ['screen', 'screen'],
      ['errands', 'closed without you'],
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

test('the head names the window: since when, as a day and a clock, and how long ago', () => {
  const at = '2026-01-01T09:12:00.000Z'
  expect(windowWords(at, Date.parse(at) + 3 * 60 * 60_000)).toMatch(/^Since \w+ \d{2}:\d{2} \u00b7 3 hours ago$/)
})
