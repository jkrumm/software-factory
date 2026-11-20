import { expect, test } from 'bun:test'
import { KPI_CATALOG, KPI_KEYS, type FindingClass, type FixCommitsModel, type Kpi } from '@software-factory/contract'
import {
  changeTone,
  changeWords,
  chartTarget,
  drawsHistory,
  classWords,
  closeWords,
  yieldWords,
  comparisonWords,
  besideWords,
  distanceWords,
  fixCard,
  fixWeekLabel,
  fixWeeksOldestFirst,
  formatKpi,
  historyLabels,
  historyXLabels,
  kpiChange,
  partWords,
  KPI_HINT,
  kpiFooter,
  frictionRanking,
  groupKpis,
  KPI_ORDER,
  lineTone,
  MEANING,
  partRows,
  sampleWords,
  subWords,
  targetStatus,
  targetTally,
  targetWords,
  windowOf,
  windowWords,
} from '../src/lib/improve.ts'
import { LANGUAGE } from '../src/lib/language.gen.ts'

const point = (value: number | null, n = 4) => ({ value, n })
const history = (...values: (number | null)[]) => values.map((v) => point(v))

const kpi = (over: Partial<Kpi>): Kpi => ({
  key: 'avoidable_touches',
  label: 'x',
  value: 0.25,
  unit: 'per_issue',
  n: 4,
  count: 1,
  target: { kind: 'between', min: 0.05, max: 0.07 },
  direction: 'lower',
  targetSource: '',
  measured: true,
  reason: null,
  definition: '',
  parts: [],
  beside: [],
  history: history(0.3, 0.28, 0.4, 0.22, 0.2, 0.25),
  ...over,
})

test('drawsHistory: a target gives one reading a place, no target needs a trend of three, nothing measured draws nothing', () => {
  const none = { kind: 'unset', min: null, max: null } as const
  expect(drawsHistory(kpi({ history: history(null, null, null, null, null, 0.2) }))).toBe(true)
  expect(drawsHistory(kpi({ history: history(null, null, null, null, null, null) }))).toBe(false)
  expect(drawsHistory(kpi({ target: none, history: history(null, null, null, null, 0.1, 0.2) }))).toBe(false)
  expect(drawsHistory(kpi({ target: none, history: history(null, null, null, 0.1, 0.2, 0.3) }))).toBe(true)
  expect(drawsHistory(kpi({ measured: false }))).toBe(false)
})

test('windowOf takes 7, 30 or 90 and falls back to 7', () => {
  expect(windowOf('30')).toBe(30)
  expect(windowOf('90')).toBe(90)
  expect(windowOf('7')).toBe(7)
  expect(windowOf('12')).toBe(7)
  expect(windowOf(undefined)).toBe(7)
})

test('formatKpi by unit, and why a value is missing', () => {
  expect(formatKpi(kpi({}))).toBe('0.25')
  expect(formatKpi(kpi({ unit: 'share', value: 0.912 }))).toBe('91%')
  expect(formatKpi(kpi({ unit: 'usd', value: 0.74 }))).toBe('$0.74')
  expect(formatKpi(kpi({ unit: 'points', value: 3.26 }))).toBe('3.3')
  expect(formatKpi(kpi({ unit: 'ms', value: 37 * 60_000 }))).toBe('37 min')
  expect(formatKpi(kpi({ unit: 'ms', value: 8.8 * 3_600_000 }))).toBe('8.8 h')
  expect(formatKpi(kpi({ unit: 'ms', value: 2.1 * 86_400_000 }))).toBe('2.1 d')
  expect(formatKpi(kpi({ value: null }))).toBe('Not measured')
  expect(formatKpi(kpi({ value: null, measured: false }))).toBe('Not measured')
})

test('a card says which way is good the way the catalog does', () => {
  for (const key of KPI_KEYS) {
    const sentence = MEANING[key]
    const higher = /Higher (is better|means)/.test(sentence)
    expect(higher, key).toBe(KPI_CATALOG[key].direction === 'higher')
  }
})

test('targetWords and targetStatus are literal', () => {
  expect(targetWords(kpi({}))).toBe('0.05 to 0.07')
  expect(targetWords(kpi({ target: { kind: 'at_most', min: null, max: 0.25 } }))).toBe('at most 0.25')
  expect(targetWords(kpi({ unit: 'share', target: { kind: 'at_least', min: 0.9, max: null } }))).toBe('at least 90%')
  expect(targetWords(kpi({ target: { kind: 'trend', min: null, max: null } }))).toBe('None yet')
  expect(targetWords(kpi({ target: { kind: 'unset', min: null, max: null } }))).toBe('No target')

  expect(targetStatus(kpi({ value: 0.06 }))).toBe('met')
  expect(targetStatus(kpi({ value: 0.01 }))).toBe('missed')
  expect(targetStatus(kpi({ value: 0.3 }))).toBe('missed')
  expect(targetStatus(kpi({ value: 0.25, target: { kind: 'at_most', min: null, max: 0.25 } }))).toBe('met')
  expect(targetStatus(kpi({ value: 0.8, target: { kind: 'at_least', min: 0.9, max: null } }))).toBe('missed')
  expect(targetStatus(kpi({ target: { kind: 'trend', min: null, max: null } }))).toBe('trend')
  expect(targetStatus(kpi({ target: { kind: 'unset', min: null, max: null } }))).toBe('no_target')
  expect(targetStatus(kpi({ value: null }))).toBe('no_data')
  expect(targetStatus(kpi({ value: null, measured: false }))).toBe('not_measured')
})

test('sampleWords and windowWords', () => {
  expect(sampleWords({ key: 'avoidable_touches', n: 13 })).toBe('13 Issues')
  expect(sampleWords({ key: 'quota_at_reset', n: 1 })).toBe('1 reset')
  expect(sampleWords({ key: 'queue_wait_p90', n: 0 })).toBe('0 samples')
  expect(windowWords({ from: '2026-11-01T00:00:00Z', to: '2026-11-08T10:00:00Z' })).toBe('2026-11-01 to 2026-11-08')
})

test('classWords: a held class says when it is asked again, a probation class how it files', () => {
  const cls: FindingClass = {
    loop: 'hygiene',
    class: 'cochange',
    status: 'held',
    issues: 5,
    decided: 4,
    noise: 3,
    share: 0.75,
    open: 0,
    heldUntil: '2026-11-15T10:00:00.000Z',
  }
  expect(classWords(cls)).toBe('3 of 4 dropped or cancelled, asked again 2026-11-15')
  expect(classWords({ ...cls, status: 'probation' })).toBe(
    '3 of 4 dropped or cancelled, one Issue at a time until one closes done',
  )
})

const week = (to: string, total: number, byClass: Record<string, number>): FixCommitsModel['weeks'][number] => ({
  from: '2026-01-01T00:00:00.000Z',
  to,
  total,
  byClass,
})

test('fix commit weeks read oldest first, empty classes are left out and the totals follow the weeks', () => {
  const model: Pick<FixCommitsModel, 'classes' | 'weeks'> = {
    classes: [
      { key: 'tests', meaning: 'a' },
      { key: 'logic', meaning: 'b' },
      { key: 'docs', meaning: 'c' },
    ],
    // the API sends the newest week first
    weeks: [
      week('2026-11-08T00:00:00.000Z', 3, { tests: 1, logic: 2, docs: 0 }),
      week('2026-11-01T00:00:00.000Z', 0, { tests: 0, logic: 0, docs: 0 }),
      week('2026-10-25T00:00:00.000Z', 1, { tests: 0, logic: 1, docs: 0 }),
      week('2026-10-18T00:00:00.000Z', 0, {}),
    ],
  }
  expect(fixWeeksOldestFirst(model).map(fixWeekLabel)).toEqual(['2026-10-18', '2026-10-25', '2026-11-01', '2026-11-08'])
})

const AT_LEAST: Kpi['target'] = { kind: 'at_least', min: 0.9, max: null }
const AT_MOST: Kpi['target'] = { kind: 'at_most', min: null, max: 0.25 }

test('distanceWords: the verdict in words, the reason when there is none', () => {
  expect(distanceWords(kpi({ value: 0.26 }))).toBe('0.19 above the target of 0.05 to 0.07')
  expect(distanceWords(kpi({ value: 0.01 }))).toBe('0.04 below the target of 0.05 to 0.07')
  expect(distanceWords(kpi({ value: 0.06 }))).toBe('Met: 0.05 to 0.07')
  expect(distanceWords(kpi({ unit: 'share', value: 0.8, target: AT_LEAST }))).toBe(
    '10 pts below the target of at least 90%',
  )
  expect(distanceWords(kpi({ unit: 'share', value: 0.95, target: AT_LEAST }))).toBe('Met: at least 90%')
  expect(distanceWords(kpi({ value: 0.4, target: AT_MOST }))).toBe('0.15 above the target of at most 0.25')
  expect(
    distanceWords(kpi({ unit: 'ms', value: 5 * 3_600_000, target: { kind: 'at_most', min: null, max: 3_600_000 } })),
  ).toBe('4.0 h above the target of at most 1.0 h')
  expect(distanceWords(kpi({ target: { kind: 'trend', min: null, max: null } }))).toBeNull()
  expect(distanceWords(kpi({ target: { kind: 'unset', min: null, max: null } }))).toBeNull()
  expect(distanceWords(kpi({ value: null }))).toBe('Not measured')
  expect(distanceWords({ ...kpi({ value: null, measured: false }), reason: 'Only 2 counted' })).toBe('Only 2 counted')
  expect(distanceWords(kpi({ value: null, measured: false }))).toBe('Not measured')
})

test('changeWords: a signed size in the unit, never NaN, a missing side says so', () => {
  expect(changeWords('per_issue', 0.25, 0.22)).toEqual({ text: '+0.03', direction: 1, difference: expect.any(Number) })
  expect(changeWords('per_issue', 0.2, 0.25).text).toBe('-0.05')
  expect(changeWords('share', 0.95, 0.9).text).toBe('+5 pts')
  expect(changeWords('ms', 10 * 60_000, 25 * 60_000).text).toBe('-15 min')
  expect(changeWords('usd', 1.5, 1).text).toBe('+$0.50')
  expect(changeWords('per_issue', 0.25, 0.25)).toMatchObject({ text: 'No change', direction: 0 })
  expect(changeWords('per_issue', 0.2500001, 0.25).text).toBe('No change')
  expect(changeWords('per_issue', 0.25, null)).toEqual({ text: 'no earlier data', direction: 0, difference: null })
  expect(changeWords('per_issue', null, 0.25).text).toBe('no earlier data')
})

test('changeTone follows the target, not the sign', () => {
  expect(changeTone(AT_LEAST, 0.8, 0.85)).toBe('good')
  expect(changeTone(AT_LEAST, 0.85, 0.8)).toBe('bad')
  expect(changeTone(AT_MOST, 0.3, 0.2)).toBe('good')
  expect(changeTone(AT_MOST, 0.2, 0.3)).toBe('bad')
  // inside the target, a wobble below the bound is not a change of verdict
  expect(changeTone(AT_MOST, 0.1, 0.2)).toBe('neutral')
  const range = { kind: 'between', min: 0.05, max: 0.07 } as const
  expect(changeTone(range, 0.3, 0.2)).toBe('good')
  expect(changeTone(range, 0.01, 0.04)).toBe('good')
  expect(changeTone(range, 0.06, 0.2)).toBe('bad')
  expect(changeTone(range, 0.06, 0.065)).toBe('neutral')
  expect(changeTone({ kind: 'trend', min: null, max: null }, 1, 2)).toBe('neutral')
  expect(changeTone({ kind: 'unset', min: null, max: null }, 2, 1)).toBe('neutral')
})

test('kpiChange compares with the window before and judges it by the target', () => {
  expect(kpiChange(kpi({ value: 0.25 }))).toMatchObject({ text: '+0.05', direction: 1, tone: 'bad' })
  expect(kpiChange(kpi({ value: 0.2, history: history(0.1, 0.1, 0.1, 0.1, 0.3, 0.2) }))).toMatchObject({
    text: '-0.10',
    tone: 'good',
  })
  expect(kpiChange(kpi({ history: history(null, null, null, null, null, 0.25) }))).toMatchObject({
    text: 'no earlier data',
    tone: 'neutral',
  })
  expect(kpiChange(kpi({ history: [] }))).toMatchObject({ text: 'no earlier data', tone: 'neutral' })
  expect(kpiChange(kpi({ value: null, history: history(1, 1, 1, 1, 1, null) })).text).toBe('no earlier data')
})

test('the chart draws the target as the kind says, and the line tone is the verdict', () => {
  expect(chartTarget({ kind: 'between', min: 0.05, max: 0.07 })).toEqual({ min: 0.05, max: 0.07 })
  expect(chartTarget(AT_LEAST)).toBe(0.9)
  expect(chartTarget(AT_MOST)).toBe(0.25)
  expect(chartTarget({ kind: 'trend', min: null, max: null })).toBeUndefined()
  expect(chartTarget({ kind: 'unset', min: null, max: null })).toBeUndefined()
  expect(chartTarget({ kind: 'at_most', min: null, max: null })).toBeUndefined()
  expect(lineTone(kpi({ value: 0.06 }))).toBe('good')
  expect(lineTone(kpi({ value: 0.3 }))).toBe('bad')
  expect(lineTone(kpi({ target: { kind: 'trend', min: null, max: null } }))).toBe('neutral')
  expect(lineTone(kpi({ value: null }))).toBe('neutral')
  expect(lineTone(kpi({ measured: false }))).toBe('neutral')
})

test('history labels, x labels, subtitle and footer', () => {
  const windows = [
    { from: '2026-10-05T00:00:00.000Z', to: '2026-10-12T00:00:00.000Z' },
    { from: '2026-10-12T00:00:00.000Z', to: '2026-10-19T00:00:00.000Z' },
    { from: '2026-10-19T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z' },
    { from: '2026-10-26T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z' },
    { from: '2026-11-02T00:00:00.000Z', to: '2026-11-09T00:00:00.000Z' },
  ]
  const labels = historyLabels(kpi({ key: 'avoidable_touches', history: [point(1, 1), point(null, 0)] }), windows)
  expect(labels).toEqual(['Oct 5 to Oct 12, 1 Issue', 'Oct 12 to Oct 19, 0 Issues'])
  expect(historyXLabels(7, windows)).toEqual(['Oct 5', '7-day windows', 'Nov 9'])
  expect(historyXLabels(7, [])).toEqual(['', '7-day windows', ''])
  expect(comparisonWords(30)).toBe('Last 30 days against the 30 before')
  // a rate says its absolute count first, beside the Issues it stands on
  expect(kpiFooter(kpi({ n: 4 }))).toEqual([
    { label: 'Target', value: '0.05 to 0.07' },
    { label: 'Counted', value: '1 over 4 Issues' },
  ])
  expect(kpiFooter(kpi({ measured: false, n: 2, count: null }))[1]).toEqual({ label: 'Counted', value: '2 Issues' })
  expect(kpiFooter(kpi({ key: 'cycle_p50', unit: 'ms', n: 5, count: null }))[1]).toEqual({
    label: 'Counted',
    value: '5 samples',
  })
})

test('fixCard: the newest week against the one before, fewer is better, classes keep their slot', () => {
  const model: Pick<FixCommitsModel, 'classes' | 'weeks'> = {
    classes: [
      { key: 'tests', meaning: 'a' },
      { key: 'logic', meaning: 'b' },
      { key: 'docs', meaning: 'c' },
    ],
    weeks: [
      week('2026-11-08T00:00:00.000Z', 3, { tests: 1, logic: 2 }),
      week('2026-11-01T00:00:00.000Z', 1, { logic: 1 }),
      week('2026-10-25T00:00:00.000Z', 0, {}),
      week('2026-10-18T00:00:00.000Z', 2, { tests: 1, logic: 1 }),
    ],
  }
  const card = fixCard(model)
  expect(card.latest).toBe(3)
  expect(card.change).toEqual({ text: '+2', direction: 1, difference: 2 })
  expect(card.tone).toBe('bad')
  expect(card.total).toBe(6)
  expect(card.busiest).toEqual({ key: 'logic', total: 4 })
  expect(card.classes.map((c) => [c.key, c.slot, c.total])).toEqual([
    ['tests', 0, 2],
    ['logic', 1, 4],
    ['docs', 2, 0],
  ])
  expect(card.weeks.map((w) => [w.label, w.counts])).toEqual([
    ['2026-10-18', [1, 1, 0]],
    ['2026-10-25', [0, 0, 0]],
    ['2026-11-01', [0, 1, 0]],
    ['2026-11-08', [1, 2, 0]],
  ])
  const [newest, before, ...older] = model.weeks
  const falling = fixCard({ ...model, weeks: [before ?? week('', 0, {}), newest ?? week('', 0, {}), ...older] })
  expect(falling.change.text).toBe('-2')
  expect(falling.tone).toBe('good')
  const none = fixCard({ classes: model.classes, weeks: model.weeks.map((w) => week(w.to, 0, {})) })
  expect(none.busiest).toBeNull()
  expect(none.change).toMatchObject({ text: 'No change', direction: 0 })
  expect(none.tone).toBe('neutral')
  expect(fixCard({ classes: model.classes, weeks: [week('2026-11-08T00:00:00.000Z', 2, {})] }).change.text).toBe(
    'no earlier data',
  )
})

test('every KPI carries a defined InfoHint word', () => {
  expect(Object.keys(KPI_HINT).toSorted()).toEqual([...KPI_KEYS].toSorted())
  for (const word of Object.values(KPI_HINT)) expect(LANGUAGE[word].length).toBeGreaterThan(10)
})

test('the footer hints the watches of the first verification passes, and no other sample', () => {
  const footer = (key: Kpi['key']) =>
    kpiFooter({ key, n: 3, count: 2, measured: true, target: { kind: 'trend', min: null, max: null }, unit: 'share' })
  expect(footer('first_verification_passes')[1]).toMatchObject({ value: '3 watches', hint: 'watch' })
  expect(footer('specs_not_needed')[1].hint).toBeUndefined()
})

test('a KPI with no target yet says why on its card, one with a target how far it is', () => {
  const none = { kind: 'trend', min: null, max: null } as const
  expect(subWords(kpi({ target: none, targetSource: 'No target yet: three full weeks first' }))).toBe(
    'No target yet: three full weeks first',
  )
  expect(subWords(kpi({ value: 0.06 }))).toBe('Met: 0.05 to 0.07')
  expect(subWords(kpi({ measured: false, reason: 'Nothing was counted in the window' }))).toBe(
    'Nothing was counted in the window',
  )
})

test('targetTally counts the met targets of those judged; trends, unset targets and gaps are not judged', () => {
  const met = kpi({ value: 0.06 })
  const missed = kpi({ value: 0.25 })
  const trend = kpi({ target: { kind: 'trend', min: null, max: null } })
  const gap = kpi({ value: null })
  const unmeasured = kpi({ measured: false })
  expect(targetTally([met, missed, met, trend, gap, unmeasured])).toEqual({ met: 2, judged: 3 })
  expect(targetTally([trend, gap])).toEqual({ met: 0, judged: 0 })
})

test('the parts of a breakdown KPI are listed in its own unit', () => {
  const queued = kpi({
    key: 'queue_wait_p90',
    unit: 'ms',
    parts: [
      { key: 'chain', label: 'Held by an after edge', value: 5 * 3_600_000, unit: 'ms' },
      { key: 'capacity', label: 'Capacity', value: 90_000, unit: 'ms' },
    ],
  })
  expect(partWords(queued)).toEqual(['Held by an after edge: 5.0 h', 'Capacity: 2 min'])
  expect(partWords(kpi({}))).toEqual([])
  expect(
    besideWords(kpi({ beside: [{ key: 'asks', label: 'Asks per Issue', value: 0.04, unit: 'per_issue' }] })),
  ).toEqual(['Asks per Issue: 0.04'])
})

test('every KPI has one plain sentence that says which way is good, and the card order lists each card KPI once', () => {
  for (const [key, sentence] of Object.entries(MEANING)) {
    expect(sentence.length, key).toBeGreaterThan(30)
    expect(sentence.endsWith('.'), key).toBe(true)
    expect(sentence.split('. ').length, key).toBeLessThanOrEqual(3)
  }
  expect(new Set(KPI_ORDER).size).toBe(KPI_ORDER.length)
  expect([...KPI_ORDER].toSorted()).toEqual([...KPI_KEYS].toSorted())
})

test('groupKpis puts what is off target first, then what has no figure, what is met, and what no target judges', () => {
  const none = { kind: 'unset', min: null, max: null } as const
  const groups = groupKpis([
    kpi({ key: 'specs_not_needed', value: 0.06 }),
    kpi({ key: 'avoidable_touches', value: 0.9 }),
    kpi({ key: 'quota_at_reset', value: null, measured: false, target: none }),
    kpi({ key: 'cycle_p50', value: 5, target: none }),
    kpi({ key: 'queue_wait_p90', value: null, measured: true, target: { kind: 'at_most', min: null, max: 0.25 } }),
  ])
  expect(groups.off.map((k) => k.key)).toEqual(['avoidable_touches'])
  expect(groups.met.map((k) => k.key)).toEqual(['specs_not_needed'])
  expect(groups.unmeasured.map((k) => k.key)).toEqual(['queue_wait_p90', 'quota_at_reset'])
  expect(groups.trend.map((k) => k.key)).toEqual(['cycle_p50'])
})

test('formatKpi reads a count as a whole number, or one decimal for a rate', () => {
  expect(formatKpi(kpi({ unit: 'count', value: 3 }))).toBe('3')
  expect(formatKpi(kpi({ unit: 'count', value: 1.3333 }))).toBe('1.3')
})

test('partRows: largest first, each with its share; nothing when the parts add up to none', () => {
  const parts = [
    { key: 'chain', label: 'An after edge', value: 1 * 3_600_000, unit: 'ms' as const },
    { key: 'capacity', label: 'Capacity', value: 3 * 3_600_000, unit: 'ms' as const },
  ]
  expect(partRows({ parts })).toEqual([
    { key: 'capacity', label: 'Capacity', value: '3.0 h', share: 0.75 },
    { key: 'chain', label: 'An after edge', value: '1.0 h', share: 0.25 },
  ])
  expect(partRows({ parts: [] })).toEqual([])
})

test('frictionRanking: most first, the totals left out, the top five apart, the change against the window before', () => {
  const row = (key: string, count: number, previous: number | null) => ({ key, label: key, count, previous })
  const ranking = frictionRanking([
    row('refusal:total', 40, 10),
    row('a', 9, 4),
    row('b', 12, 12),
    row('c', 3, 8),
    row('d', 5, 0),
    row('e', 1, null),
    row('f', 2, 2),
    row('g', 0, 3),
  ])
  expect(ranking.top.map((r) => r.key)).toEqual(['b', 'a', 'd', 'c', 'f'])
  expect(ranking.tail.map((r) => r.key)).toEqual(['e'])
  expect(ranking.quiet).toBe(1)
  expect(ranking.compared).toBe(true)
  expect(frictionRanking([row('a', 2, null), row('b', 1, null)]).compared).toBe(false)
  const by = Object.fromEntries([...ranking.top, ...ranking.tail].map((r) => [r.key, r]))
  expect(by.a).toMatchObject({ change: '+5 (4 before)', tone: 'bad', direction: 1, share: 0.75 })
  expect(by.b).toMatchObject({ change: 'same', tone: 'neutral', share: 1 })
  expect(by.c).toMatchObject({ change: '-5 (8 before)', tone: 'good', direction: -1 })
  expect(by.d).toMatchObject({ change: 'new', tone: 'bad' })
  expect(by.e).toMatchObject({ change: 'no earlier window', tone: 'neutral' })
})

test('closeWords: minutes under two hours, hours under two days, days after; a dash for none', () => {
  expect(closeWords(null)).toBe('–')
  expect(closeWords(20)).toBe('1 min')
  expect(closeWords(5_400)).toBe('90 min')
  expect(closeWords(3 * 3_600)).toBe('3 h')
  expect(closeWords(3 * 86_400)).toBe('3 d')
})

test('yieldWords: what a loop’s Issues came to, healed counted as done', () => {
  const base = {
    days: 7,
    passes: 1,
    signals: 5,
    issues: 5,
    done: 2,
    moved: 1,
    movedShare: 0.5,
    healed: 1,
    dropped: 1,
    cancelled: 0,
    open: 1,
    medianCloseSeconds: 60,
    classes: [],
  }
  expect(yieldWords(base)).toBe('3 done, 1 dropped or cancelled, 1 open')
  expect(yieldWords({ ...base, issues: 0 })).toBe('no Issue')
})
