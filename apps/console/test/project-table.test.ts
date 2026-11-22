import { expect, test } from 'bun:test'
import { emptyWorkCounts, type ProjectIndexRow, type WorkCounts } from '@software-factory/contract'
import {
  ageShort,
  busiest,
  DEFAULT_PREFS,
  durationShort,
  groupRows,
  hygieneTone,
  matchesQuick,
  parsePrefs,
  productionOf,
  productionRank,
  trendOf,
} from '../src/lib/project-table.ts'

const NOW = Date.parse('2026-11-17T12:00:00Z')
const H = 3_600_000
const ago = (hours: number) => new Date(NOW - hours * H).toISOString()
const work = (over: Partial<Pick<WorkCounts, 'running' | 'paused' | 'ready' | 'held' | 'checking'>>) => ({
  ...emptyWorkCounts(),
  ...over,
})

function row(name: string, over: Partial<ProjectIndexRow> = {}): ProjectIndexRow {
  return {
    name,
    work: false,
    source: 'file',
    branch: 'master',
    group: 'Tooling',
    counts: { done7d: 0, work: work({}) },
    hygiene: { lastPassAt: ago(2), outcome: 'answered', findings: 0, clean: 8, run: 8, oldestFindingAt: null },
    shipped: { hours: Array<number>(168).fill(0), lastAt: null },
    cycle: { ms: null, n: 0, beforeMs: null, beforeN: 0 },
    queueWait: { ms: null, n: 0, beforeMs: null, beforeN: 0 },
    production: { incidents: 0, incidentAt: null, regressionAt: null },
    plan: { done: 0, total: 0 },
    leads: { running: 0, cap: null },
    queue: { state: 'run', prio: 0 },
    digest: null,
    ...over,
  }
}

test('durations and ages read short, with a unit', () => {
  expect(durationShort(30_000)).toBe('1 min')
  expect(durationShort(45 * 60_000)).toBe('45 min')
  expect(durationShort(3.24 * H)).toBe('3.2 h')
  expect(durationShort(50 * H)).toBe('2.1 d')
  expect(ageShort(10_000)).toBe('now')
  expect(ageShort(5 * H)).toBe('5 h')
})

test('a shorter median than the week before is good, a longer one bad, within 10 % flat', () => {
  expect(trendOf({ ms: 2 * H, n: 3, beforeMs: 4 * H, beforeN: 2 })).toMatchObject({ direction: 'down', tone: 'good' })
  expect(trendOf({ ms: 6 * H, n: 3, beforeMs: 4 * H, beforeN: 2 })).toMatchObject({ direction: 'up', tone: 'bad' })
  expect(trendOf({ ms: 4.2 * H, n: 3, beforeMs: 4 * H, beforeN: 2 })).toMatchObject({ direction: 'flat' })
  expect(trendOf({ ms: 4 * H, n: 3, beforeMs: null, beforeN: 0 })).toBeNull()
})

test('the lamp shows the worst of production, and severity sorts before age', () => {
  const incident = row('a', { production: { incidents: 1, incidentAt: ago(3), regressionAt: ago(1) } })
  const oldIncident = row('b', { production: { incidents: 2, incidentAt: ago(30), regressionAt: null } })
  const regressed = row('c', { production: { incidents: 0, incidentAt: null, regressionAt: ago(1) } })
  const checking = row('d', { counts: { done7d: 0, work: work({ checking: 1 }) } })
  const quiet = row('e')
  expect(productionOf(incident)).toEqual({ lamp: 'incident', since: ago(3) })
  expect(productionOf(regressed).lamp).toBe('regressed')
  expect(productionOf(checking)).toEqual({ lamp: 'checking', since: null })
  expect(productionOf(quiet).lamp).toBe('quiet')
  const ranked = [quiet, regressed, incident, checking, oldIncident].sort(
    (x, y) => productionRank(y) - productionRank(x),
  )
  expect(ranked.map((r) => r.name)).toEqual(['b', 'a', 'c', 'd', 'e'])
})

test('the quick filters: red, hygiene gaps, moving and idle', () => {
  const hours = Array<number>(168).fill(0)
  hours[160] = 2
  const red = row('red', { production: { incidents: 0, incidentAt: null, regressionAt: ago(5) } })
  const gap = row('gap', {
    hygiene: { lastPassAt: ago(2), outcome: 'answered', findings: 1, clean: 6, run: 7, oldestFindingAt: ago(2) },
  })
  const stale = row('stale', {
    hygiene: { lastPassAt: ago(2), outcome: 'answered', findings: 1, clean: 7, run: 7, oldestFindingAt: ago(24 * 9) },
  })
  const moving = row('moving', { shipped: { hours, lastAt: ago(8) } })
  const busy = row('busy', { counts: { done7d: 0, work: work({ running: 1 }) } })
  const idle = row('idle')
  const all = [red, gap, stale, moving, busy, idle]
  const names = (filter: Parameters<typeof matchesQuick>[1]) =>
    all.filter((r) => matchesQuick(r, filter, NOW)).map((r) => r.name)
  expect(names('all')).toHaveLength(6)
  expect(names('alarm')).toEqual(['red'])
  expect(names('hygiene')).toEqual(['gap', 'stale'])
  expect(names('moving')).toEqual(['moving'])
  expect(names('idle')).toEqual(['red', 'gap', 'stale', 'idle'])
  expect(hygieneTone(stale, NOW)).toBe('bad')
  expect(hygieneTone(gap, NOW)).toBe('warn')
})

test('with no sort chosen, the busiest come first', () => {
  const a = row('a', { counts: { done7d: 0, work: work({ ready: 2, held: 1 }) } })
  const b = row('b', { counts: { done7d: 0, work: work({ running: 2 }) } })
  const c = row('c')
  expect([c, a, b].sort(busiest).map((r) => r.name)).toEqual(['b', 'a', 'c'])
})

test('stored choices read field by field; anything else is the default', () => {
  expect(parsePrefs(null)).toEqual(DEFAULT_PREFS)
  expect(parsePrefs('not json')).toEqual(DEFAULT_PREFS)
  expect(
    parsePrefs(
      JSON.stringify({
        hidden: ['plan', 'name', 'nope'],
        sort: [
          { id: 'shipped', desc: true },
          { id: 'x', desc: true },
        ],
        grouped: false,
        density: 'comfortable',
      }),
    ),
  ).toEqual({ hidden: ['plan'], sort: [{ id: 'shipped', desc: true }], grouped: false, density: 'comfortable' })
  expect(parsePrefs(JSON.stringify({ grouped: 'yes', density: 'huge' }))).toEqual(DEFAULT_PREFS)
})

test('groups follow the server order, keep the rows in order and drop an empty group', () => {
  const rows = [
    { group: 'Apps', name: 'x' },
    { group: 'Infra', name: 'y' },
    { group: 'Apps', name: 'z' },
    { group: 'Stray', name: 'w' },
  ]
  expect(groupRows(rows, ['Infra', 'Tooling', 'Apps', 'Other'])).toEqual([
    { group: 'Infra', rows: [{ group: 'Infra', name: 'y' }] },
    {
      group: 'Apps',
      rows: [
        { group: 'Apps', name: 'x' },
        { group: 'Apps', name: 'z' },
      ],
    },
    { group: 'Stray', rows: [{ group: 'Stray', name: 'w' }] },
  ])
})
