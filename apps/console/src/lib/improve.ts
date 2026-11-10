import type { FindingClass, FixCommitsModel, FrictionCount, Kpi, KpiKey } from '@software-factory/contract'
import type { Tone } from '../components/kit/tone'
import type { LANGUAGE } from './language.gen'

/** A word `docs/language.md` defines (the kit's `InfoWord`, without importing a component). */
type InfoWord = keyof typeof LANGUAGE

/** One key-value pair of a card footer; `hint` is the domain word its value is hinted by. */
interface FooterPair {
  label: string
  value: string
  hint?: InfoWord
}

export const WINDOW_DAYS = [7, 30, 90] as const
export type WindowDays = (typeof WINDOW_DAYS)[number]
export const DEFAULT_WINDOW: WindowDays = 7

/** `?days=` as the screen reads it: one of the three windows, anything else the default. */
export function windowOf(value: unknown): WindowDays {
  const days = typeof value === 'string' ? Number(value) : value
  return WINDOW_DAYS.find((choice) => choice === days) ?? DEFAULT_WINDOW
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function formatValue(unit: Kpi['unit'], value: number): string {
  switch (unit) {
    case 'per_issue':
      return value.toFixed(2)
    case 'share':
      return `${Math.round(value * 100)}%`
    case 'usd':
      return `$${value.toFixed(2)}`
    case 'points':
      return value.toFixed(1)
    case 'ms':
      if (value < MINUTE) return `${Math.round(value / 1000)} s`
      if (value < HOUR) return `${Math.round(value / MINUTE)} min`
      if (value < DAY) return `${(value / HOUR).toFixed(1)} h`
      return `${(value / DAY).toFixed(1)} d`
  }
}

/** The value as the screen shows it; a missing one says why. */
export function formatKpi(kpi: Pick<Kpi, 'value' | 'unit' | 'measured'>): string {
  if (!kpi.measured) return 'Not measured'
  if (kpi.value === null) return 'No data'
  return formatValue(kpi.unit, kpi.value)
}

export function targetWords(kpi: Pick<Kpi, 'target' | 'unit'>): string {
  const { kind, min, max } = kpi.target
  const show = (n: number) => formatValue(kpi.unit, n)
  if (kind === 'trend') return 'Trend only'
  if (kind === 'between' && min !== null && max !== null) return `${show(min)} to ${show(max)}`
  if (kind === 'at_most' && max !== null) return `at most ${show(max)}`
  if (kind === 'at_least' && min !== null) return `at least ${show(min)}`
  return 'No target'
}

export type TargetStatus = 'met' | 'missed' | 'trend' | 'no_target' | 'no_data' | 'not_measured'

/** Whether `v` meets the target; null when the target judges nothing (trend, unset, or a bound missing). */
function meets({ kind, min, max }: Kpi['target'], v: number): boolean | null {
  if (kind === 'between') return min === null || max === null ? null : v >= min && v <= max
  if (kind === 'at_most') return max === null ? null : v <= max
  if (kind === 'at_least') return min === null ? null : v >= min
  return null
}

export function targetStatus(kpi: Pick<Kpi, 'value' | 'measured' | 'target'>): TargetStatus {
  if (!kpi.measured) return 'not_measured'
  if (kpi.value === null) return 'no_data'
  if (kpi.target.kind === 'trend') return 'trend'
  const met = meets(kpi.target, kpi.value)
  if (met === null) return 'no_target'
  return met ? 'met' : 'missed'
}

/** How many of the KPIs the targets judge are met: only a `met` or `missed` status counts as judged. */
export function targetTally(kpis: readonly Pick<Kpi, 'value' | 'measured' | 'target'>[]): {
  met: number
  judged: number
} {
  const statuses = kpis.map(targetStatus)
  return {
    met: statuses.filter((s) => s === 'met').length,
    judged: statuses.filter((s) => s === 'met' || s === 'missed').length,
  }
}

/** The KPIs the summary strip tiles, in the Console's order: those whose target judges a reading (not a trend). */
const SUMMARY_ORDER: readonly KpiKey[] = [
  'first_verification_passes',
  'avoidable_touches',
  'asks',
  'worth_asking',
  'refusals',
  'queue_wait_p90',
  'queue_wait_p50',
  'cycle_p50',
  'window_points',
  'cost',
]

export function summaryKpis<T extends Pick<Kpi, 'key' | 'target'>>(kpis: readonly T[]): T[] {
  return SUMMARY_ORDER.flatMap((key) =>
    kpis.filter((k) => k.key === key && ['at_least', 'at_most', 'between'].includes(k.target.kind)),
  )
}

/** The one word of a summary tile's lamp. */
export const STATUS_WORD: Record<TargetStatus, string> = {
  met: 'Met',
  missed: 'Missed',
  no_data: 'No data',
  not_measured: 'Not measured',
  no_target: 'No target',
  trend: 'Trend only',
}

/** The lamp's tone: the verdict where there is one, neutral otherwise. */
export function statusTone(status: TargetStatus): Tone {
  return status === 'met' ? 'good' : status === 'missed' ? 'bad' : 'neutral'
}

const SAMPLE_NOUN: Record<KpiKey, readonly [string, string]> = {
  avoidable_touches: ['Issue', 'Issues'],
  asks: ['Issue', 'Issues'],
  worth_asking: ['Decision', 'Decisions'],
  first_verification_passes: ['watch', 'watches'],
  refusals: ['Issue', 'Issues'],
  cycle_p50: ['sample', 'samples'],
  queue_wait_p50: ['sample', 'samples'],
  queue_wait_p90: ['sample', 'samples'],
  fix_commits: ['Issue', 'Issues'],
  window_points: ['Issue', 'Issues'],
  cost: ['Issue', 'Issues'],
}

/** What a KPI's sample was: "13 Issues", "1 Decision". */
export function sampleWords(kpi: Pick<Kpi, 'key' | 'n'>): string {
  const [one, many] = SAMPLE_NOUN[kpi.key]
  return `${kpi.n} ${kpi.n === 1 ? one : many}`
}

/** The domain word each KPI's title carries an InfoHint for. */
export const KPI_HINT = {
  avoidable_touches: 'avoidable touch',
  asks: 'ask',
  worth_asking: 'worth asking',
  first_verification_passes: 'first verification pass',
  refusals: 'refusal',
  cycle_p50: 'cycle',
  queue_wait_p50: 'queue wait',
  queue_wait_p90: 'queue wait',
  fix_commits: 'fix commit',
  window_points: 'window point',
  cost: 'cost',
} as const satisfies Record<KpiKey, InfoWord>

/** The word the sample noun of a KPI is hinted by, where the noun is a domain word of its own ("13 watches"). */
export const SAMPLE_HINT = { first_verification_passes: 'watch' } as const satisfies Partial<Record<KpiKey, InfoWord>>

export const FRICTION_GROUP_LABEL: Record<FrictionCount['group'], string> = {
  avoidable_touch: 'Avoidable touches',
  orchestrator_steer: 'The orchestrator steering leads',
  refusal: 'Refusals',
  stall: 'Stalls',
  lead_gone: 'Leads that went away',
  undelivered_note: 'Notes that never arrived',
  unreviewed_ship: 'Ships without a review',
  unstated_acceptance: 'Ships that state nothing against the acceptance',
  regression: 'Regressions',
  decision_settled: 'Decisions settled by default',
  signal: 'Signals',
}

/** The friction groups whose heading is a domain word a stranger would not know. */
export const FRICTION_GROUP_HINT = {
  avoidable_touch: 'avoidable touch',
  refusal: 'refusal',
} as const satisfies Partial<Record<FrictionCount['group'], InfoWord>>

/** Per Issue closed, two decimals; "—" when none closed. */
export const perIssueWords = (perIssue: number | null): string => (perIssue === null ? '—' : perIssue.toFixed(2))

/** "2026-11-01 to 2026-11-08" */
export const windowWords = (window: { from: string; to: string }): string =>
  `${window.from.slice(0, 10)} to ${window.to.slice(0, 10)}`

/** What a held or probation class says about itself, in the owner's words. */
export function classWords(cls: FindingClass): string {
  const outcomes = `${cls.noise} of ${cls.decided} dropped or cancelled`
  if (cls.status === 'held')
    return `${outcomes}, asked again ${cls.heldUntil === null ? 'later' : cls.heldUntil.slice(0, 10)}`
  return `${outcomes}, one Issue at a time until one closes done`
}

/** The model's weeks as the table reads them, the oldest first (the API sends the newest first). */
export const fixWeeksOldestFirst = (model: Pick<FixCommitsModel, 'weeks'>): FixCommitsModel['weeks'] =>
  [...model.weeks].reverse()

/** A week's column heading: the day its window ends. */
export const fixWeekLabel = (week: Pick<FixCommitsModel['weeks'][number], 'to'>): string => week.to.slice(0, 10)

export interface FixClassRow {
  key: string
  meaning: string
  /** per week, the oldest first */
  counts: number[]
  total: number
}

/** One row per class with a fix commit in any of the weeks, in the API's class order; a class with none is left out. */
export function fixClassRows(model: Pick<FixCommitsModel, 'classes' | 'weeks'>): FixClassRow[] {
  const weeks = [...model.weeks].reverse()
  return model.classes
    .map((c) => {
      const counts = weeks.map((w) => w.byClass[c.key] ?? 0)
      return { key: c.key, meaning: c.meaning, counts, total: counts.reduce((a, b) => a + b, 0) }
    })
    .filter((row) => row.total > 0)
}

/** The total row: fix commits per week, the oldest first. */
export const fixWeekTotals = (model: Pick<FixCommitsModel, 'weeks'>): number[] =>
  [...model.weeks].reverse().map((w) => w.total)

// ---- the KPI cards: distance to the target, change against the window before, the history as a chart ---------------------

/** A size without a sign, in the unit's words: a share differs in points, everything else reads like the figure. */
function sizeWords(unit: Kpi['unit'], size: number): string {
  return unit === 'share' ? `${Math.round(size * 100)} pts` : formatValue(unit, size)
}

/**
 * How far `kpi` is from its target, in words; the verdict first when it is met. A KPI with no target to judge (a trend,
 * an unset one) has no distance: the footer's Target pair says so once, so this is `null` and the card has no sub line.
 */
export function distanceWords(kpi: Pick<Kpi, 'value' | 'unit' | 'measured' | 'target'>): string | null {
  if (!kpi.measured) return 'Not measured'
  if (kpi.value === null) return 'No data'
  const { kind, min, max } = kpi.target
  const met = meets(kpi.target, kpi.value)
  if (met === null) return null
  if (met) return `Met: ${targetWords(kpi)}`
  const outside = kind === 'at_least' || (kind === 'between' && min !== null && kpi.value < min) ? 'below' : 'above'
  const edge = outside === 'below' ? min : max
  return `${sizeWords(kpi.unit, Math.abs(kpi.value - (edge ?? 0)))} ${outside} the target of ${targetWords(kpi)}`
}

export interface Change {
  /** "+0.04", "-3 min", "No change", "no earlier data" */
  text: string
  /** the arrow: 1 up, -1 down, 0 flat or unknown */
  direction: -1 | 0 | 1
  /** the difference, null when either side has no reading */
  difference: number | null
}

/** The change of a reading against the one before it; never NaN, a missing side says so. */
export function changeWords(unit: Kpi['unit'], current: number | null, previous: number | null): Change {
  if (current === null || previous === null) return { text: 'no earlier data', direction: 0, difference: null }
  const difference = current - previous
  const size = sizeWords(unit, Math.abs(difference))
  if (difference === 0 || size === sizeWords(unit, 0)) return { text: 'No change', direction: 0, difference }
  const direction = difference > 0 ? 1 : -1
  return { text: `${direction > 0 ? '+' : '-'}${size}`, direction, difference }
}

/** A KPI's change against the window before it (the history's second to last reading); the tone is the target's, not the sign's. */
export function kpiChange(kpi: Pick<Kpi, 'value' | 'unit' | 'target' | 'history'>): Change & { tone: Tone } {
  const previous = kpi.history.at(-2)?.value ?? null
  const change = changeWords(kpi.unit, kpi.value, previous)
  if (change.difference === null || kpi.value === null || previous === null) return { ...change, tone: 'neutral' }
  return { ...change, tone: changeTone(kpi.target, previous, kpi.value) }
}

/**
 * Whether moving from `previous` to `current` is toward the target: at_least higher is better, at_most lower is better,
 * between nearer to the range; a trend or an unset target judges nothing.
 */
export function changeTone(target: Kpi['target'], previous: number, current: number): Tone {
  const { kind, min, max } = target
  if (current === previous) return 'neutral'
  const toward = (distance: (v: number) => number): Tone =>
    distance(current) < distance(previous) ? 'good' : distance(current) > distance(previous) ? 'bad' : 'neutral'
  if (kind === 'at_least' && min !== null) return toward((v) => Math.max(0, min - v))
  if (kind === 'at_most' && max !== null) return toward((v) => Math.max(0, v - max))
  if (kind === 'between' && min !== null && max !== null) return toward((v) => Math.max(0, min - v, v - max))
  return 'neutral'
}

/** The tone of the line: the target's verdict on the current reading; no verdict, the quiet line. */
export function lineTone(kpi: Pick<Kpi, 'value' | 'measured' | 'target'>): Tone {
  const status = targetStatus(kpi)
  return status === 'met' ? 'good' : status === 'missed' ? 'bad' : 'neutral'
}

/** The target as the chart draws it: one dashed line, two for a range, none for a trend or an unset target. */
export function chartTarget(target: Kpi['target']): number | { min: number; max: number } | undefined {
  const { kind, min, max } = target
  if (kind === 'at_least' && min !== null) return min
  if (kind === 'at_most' && max !== null) return max
  if (kind === 'between' && min !== null && max !== null) return { min, max }
  return undefined
}

/** Readings a line needs to be a trend and not a diagonal between two points. */
const TREND_POINTS = 3

/**
 * Whether the card draws the history. Against a target, any reading is a place on the chart (the dot beside its line);
 * without one the line alone must be a trend, so it takes at least three readings, never one diagonal.
 */
export function drawsHistory(kpi: Pick<Kpi, 'measured' | 'target' | 'history'>): boolean {
  if (!kpi.measured) return false
  const readings = kpi.history.filter((point) => point.value !== null).length
  return chartTarget(kpi.target) === undefined ? readings >= TREND_POINTS : readings > 0
}

/** The history's readings for the chart, oldest first; a window with nothing counted stays a gap (`null`). */
export const historyValues = (kpi: Pick<Kpi, 'history' | 'measured'>): (number | null)[] =>
  kpi.history.map((point) => point.value)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Nov 9" from an ISO time (UTC, as the API says it). */
export function shortDate(iso: string): string {
  const month = MONTHS[Number(iso.slice(5, 7)) - 1] ?? ''
  return `${month} ${Number(iso.slice(8, 10))}`
}

/** Each history point's tooltip line: the window it covers and what was counted in it. */
export function historyLabels(
  kpi: Pick<Kpi, 'key' | 'history'>,
  windows: readonly { from: string; to: string }[],
): string[] {
  return kpi.history.map((point, i) => {
    const window = windows[i]
    const range = window ? `${shortDate(window.from)} to ${shortDate(window.to)}` : `Window ${i + 1}`
    return `${range}, ${sampleWords({ key: kpi.key, n: point.n })}`
  })
}

/** The three x labels of the history chart: where it starts, how long a point is, where it ends. */
export function historyXLabels(
  days: number,
  windows: readonly { from: string; to: string }[],
): [string, string, string] {
  const first = windows[0]
  const last = windows.at(-1)
  return [first ? shortDate(first.from) : '', `${days}-day windows`, last ? shortDate(last.to) : '']
}

/** The subtitle: names the comparison. */
export const comparisonWords = (days: number): string => `Last ${days} days against the ${days} before`

/** The footer pairs of a KPI card. */
export function kpiFooter(kpi: Pick<Kpi, 'key' | 'n' | 'measured' | 'target' | 'unit'>): [FooterPair, FooterPair] {
  const hint = SAMPLE_HINT[kpi.key as keyof typeof SAMPLE_HINT]
  return [
    { label: 'Target', value: targetWords(kpi) },
    {
      label: 'Counted',
      value: kpi.measured ? sampleWords(kpi) : 'The usage schema is not joined here',
      ...(hint && kpi.measured ? { hint } : {}),
    },
  ]
}

// ---- the fix-commit card -----------------------------------------------------------------------------------------------

export interface FixCard {
  /** the newest week's fix commits */
  latest: number
  change: Change
  /** fewer is better: a rise is bad, a fall good */
  tone: Tone
  /** every class in the API's order with its slot (the colour follows the class, not its rank), its total and weekly counts */
  classes: { key: string; meaning: string; slot: number; total: number; counts: number[] }[]
  /** the weeks, oldest first, each with a count per class (same order as `classes`) */
  weeks: { label: string; total: number; counts: number[] }[]
  /** fix commits in the shown weeks */
  total: number
  /** the class with the most fix commits, null when there are none */
  busiest: { key: string; total: number } | null
}

/** The change of a whole count against the week before; fewer fix commits is better, so a rise is bad. */
function countChange(latest: number, previous: number | null): Change {
  if (previous === null) return { text: 'no earlier data', direction: 0, difference: null }
  const difference = latest - previous
  if (difference === 0) return { text: 'No change', direction: 0, difference }
  return {
    text: `${difference > 0 ? '+' : '-'}${Math.abs(difference)}`,
    direction: difference > 0 ? 1 : -1,
    difference,
  }
}

/** The fix-commit card's figures, all from the API's weeks; the page adds only the difference to the week before. */
export function fixCard(model: Pick<FixCommitsModel, 'classes' | 'weeks'>): FixCard {
  const weeks = fixWeeksOldestFirst(model)
  const classes = model.classes.map((c, slot) => {
    const counts = weeks.map((w) => w.byClass[c.key] ?? 0)
    return { key: c.key, meaning: c.meaning, slot, total: counts.reduce((a, b) => a + b, 0), counts }
  })
  const totals = weeks.map((w) => w.total)
  const latest = totals.at(-1) ?? 0
  const previous = totals.length > 1 ? (totals.at(-2) ?? null) : null
  const change = countChange(latest, previous)
  const busiest = classes.reduce<FixCard['busiest']>(
    (best, c) => (c.total > (best?.total ?? 0) ? { key: c.key, total: c.total } : best),
    null,
  )
  return {
    latest,
    change,
    tone: change.difference === null || change.difference === 0 ? 'neutral' : change.difference > 0 ? 'bad' : 'good',
    classes,
    weeks: weeks.map((w, i) => ({
      label: fixWeekLabel(w),
      total: w.total,
      counts: classes.map((c) => c.counts[i] ?? 0),
    })),
    total: totals.reduce((a, b) => a + b, 0),
    busiest,
  }
}
