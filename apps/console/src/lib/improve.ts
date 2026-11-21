import {
  type Finder,
  type FixCommitsModel,
  type FrictionCount,
  type Kpi,
  type KpiKey,
  type LoopYieldWindow,
  type SeatDelivery,
  type SeatKpiRow,
  type ReviewerKpiRow,
  type ReviewerKpis,
  type SeatKpis,
  meetsTarget,
} from '@software-factory/contract'
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
    case 'per_100_issues':
      return value.toFixed(1)
    case 'per_day':
      return value.toFixed(1)
    case 'share':
      return `${Math.round(value * 100)}%`
    case 'usd':
      return `$${value.toFixed(2)}`
    case 'points':
      return value.toFixed(1)
    case 'count':
      return Number.isInteger(value) ? String(value) : value.toFixed(1)
    case 'ms':
      if (value < MINUTE) return `${Math.round(value / 1000)} s`
      if (value < HOUR) return `${Math.round(value / MINUTE)} min`
      if (value < DAY) return `${(value / HOUR).toFixed(1)} h`
      return `${(value / DAY).toFixed(1)} d`
  }
}

/** The value as the screen shows it; one the factory has no figure for says so, never a zero. */
export function formatKpi(kpi: Pick<Kpi, 'value' | 'unit' | 'measured'>): string {
  if (!kpi.measured || kpi.value === null) return 'Not measured'
  return formatValue(kpi.unit, kpi.value)
}

export function targetWords(kpi: Pick<Kpi, 'target' | 'unit'>): string {
  const { kind, min, max } = kpi.target
  const show = (n: number) => formatValue(kpi.unit, n)
  if (kind === 'trend') return 'None yet'
  if (kind === 'between' && min !== null && max !== null) return `${show(min)} to ${show(max)}`
  if (kind === 'at_most' && max !== null) return `at most ${show(max)}`
  if (kind === 'at_least' && min !== null) return `at least ${show(min)}`
  return 'No target'
}

export type TargetStatus = 'met' | 'missed' | 'trend' | 'no_target' | 'no_data' | 'not_measured'

/** Whether `v` meets the target; null when the target judges nothing (trend, unset, or a bound missing): the contract's rule, the one the friction loop judges by. */
const meets = meetsTarget

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

const SAMPLE_NOUN: Record<KpiKey, readonly [string, string]> = {
  avoidable_touches: ['Issue', 'Issues'],
  first_verification_passes: ['watch', 'watches'],
  specs_not_needed: ['Spec verdict', 'Spec verdicts'],
  errands_reached_per_100: ['Issue', 'Issues'],
  cycle_p50: ['sample', 'samples'],
  queue_wait_p90: ['sample', 'samples'],
  quota_at_reset: ['reset', 'resets'],
}

/** What a KPI's sample was: "13 Issues", "1 Decision". */
export function sampleWords(kpi: Pick<Kpi, 'key' | 'n'>): string {
  const [one, many] = SAMPLE_NOUN[kpi.key]
  return `${kpi.n} ${kpi.n === 1 ? one : many}`
}

/** The domain word each KPI's title carries an InfoHint for. */
export const KPI_HINT = {
  avoidable_touches: 'avoidable touch',
  first_verification_passes: 'first verification pass',
  specs_not_needed: 'needed me',
  errands_reached_per_100: 'errand',
  cycle_p50: 'cycle',
  queue_wait_p90: 'queue wait',
  quota_at_reset: 'quota used at reset',
} as const satisfies Record<KpiKey, InfoWord>

/** The fix-commit card's word: fix commits have a band of their own, not a KPI card. */
export const FIX_HINT: InfoWord = 'fix commit'

/** The breakdown of a KPI as the "what is counted" popover lists it: one line per part, in the KPI's unit. */
export const partWords = (kpi: Pick<Kpi, 'parts'>): string[] =>
  kpi.parts.map((part) => `${part.label}: ${formatValue(part.unit, part.value)}`)

/** The figures read beside a KPI, as the popover lists them: one line each, in its own unit. */
export const besideWords = (kpi: Pick<Kpi, 'beside'>): string[] =>
  kpi.beside.map((figure) => `${figure.label}: ${formatValue(figure.unit, figure.value)}`)

/** The word the sample noun of a KPI is hinted by, where the noun is a domain word of its own ("13 watches"). */
const SAMPLE_HINT = { first_verification_passes: 'watch' } as const satisfies Partial<Record<KpiKey, InfoWord>>

/** How many friction rows the ranking names in words; the rest are the folded tail. */
const FRICTION_TOP = 5

export interface FrictionRow {
  key: string
  label: string
  count: number
  /** the same count in the window just before; null when that window is not comparable */
  previous: number | null
  /** "+3 (4 before)", "new", "same", "no earlier window" */
  change: string
  /** more friction is worse: a rise is bad, a fall good */
  tone: Tone
  direction: -1 | 0 | 1
  /** its count over the largest count shown, 0 to 1: the bar */
  share: number
}

function frictionChange(count: number, previous: number | null): Pick<FrictionRow, 'change' | 'tone' | 'direction'> {
  if (previous === null) return { change: 'no earlier window', tone: 'neutral', direction: 0 }
  if (previous === 0) return { change: 'new', tone: 'bad', direction: 1 }
  const difference = count - previous
  if (difference === 0) return { change: 'same', tone: 'neutral', direction: 0 }
  return {
    change: `${difference > 0 ? '+' : '-'}${Math.abs(difference)} (${previous} before)`,
    tone: difference > 0 ? 'bad' : 'good',
    direction: difference > 0 ? 1 : -1,
  }
}

/**
 * The friction counts as a ranking: the rows that counted anything, most first (the totals that only repeat their own
 * rows are left out), the top `FRICTION_TOP` apart from the tail, and how many kinds counted nothing.
 */
export function frictionRanking(
  counts: readonly Pick<FrictionCount, 'key' | 'label' | 'count' | 'previous'>[],
  top = FRICTION_TOP,
): { top: FrictionRow[]; tail: FrictionRow[]; quiet: number; compared: boolean } {
  const measured = counts.filter((c) => !c.key.endsWith(':total'))
  const ranked = measured
    .filter((c) => c.count > 0)
    .toSorted((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  const largest = ranked[0]?.count ?? 1
  const rows = ranked.map((c) => ({
    key: c.key,
    label: c.label,
    count: c.count,
    previous: c.previous,
    ...frictionChange(c.count, c.previous),
    share: c.count / largest,
  }))
  return {
    top: rows.slice(0, top),
    tail: rows.slice(top),
    quiet: measured.length - ranked.length,
    // no row has a window before to be read against (counting began inside it): the column would say so on every row
    compared: measured.some((c) => c.previous !== null),
  }
}

/** "2026-11-01 to 2026-11-08" */
export const windowWords = (window: { from: string; to: string }): string =>
  `${window.from.slice(0, 10)} to ${window.to.slice(0, 10)}`

/** Whether a finder is muted or on probation: the finders the Improve page lists. */
export const finderIsQuiet = (finder: Finder): boolean => finder.status !== 'open'

/** What a muted or probation finder says about itself, in the owner's words. */
export function finderWords(finder: Finder): string {
  const outcomes = `${finder.noise} of ${finder.decided} dropped or cancelled`
  if (finder.status === 'muted')
    return `${outcomes}, asked again ${finder.mutedUntil === null ? 'later' : finder.mutedUntil.slice(0, 10)}`
  return `${outcomes}, one Issue at a time until one closes done`
}

/** A span of seconds as the owner reads it: minutes under two hours, hours under two days, else days; a dash for none. */
export function closeWords(seconds: number | null): string {
  if (seconds === null) return '–'
  if (seconds < 7_200) return `${Math.max(1, Math.round(seconds / 60))} min`
  if (seconds < 172_800) return `${Math.round(seconds / 3_600)} h`
  return `${Math.round(seconds / 86_400)} d`
}

/** What a loop's signals led to over one window, in one line: done, dropped or cancelled, still open. */
export function yieldWords(window: LoopYieldWindow): string {
  if (window.issues === 0) return 'no Issue'
  const parts = [
    `${window.done + window.healed} done`,
    `${window.dropped + window.cancelled} dropped or cancelled`,
    `${window.open} open`,
  ]
  return parts.join(', ')
}

/** The model's weeks as the table reads them, the oldest first (the API sends the newest first). */
export const fixWeeksOldestFirst = (model: Pick<FixCommitsModel, 'weeks'>): FixCommitsModel['weeks'] =>
  [...model.weeks].reverse()

/** A week's column heading: the day its window ends. */
export const fixWeekLabel = (week: Pick<FixCommitsModel['weeks'][number], 'to'>): string => week.to.slice(0, 10)

// ---- the KPI cards: distance to the target, change against the window before, the history as a chart ---------------------

/** A size without a sign, in the unit's words: a share differs in points, everything else reads like the figure. */
function sizeWords(unit: Kpi['unit'], size: number): string {
  return unit === 'share' ? `${Math.round(size * 100)} pts` : formatValue(unit, size)
}

/**
 * How far `kpi` is from its target, in words; the verdict first when it is met. A KPI with no target to judge (a trend,
 * an unset one) has no distance: the footer's Target pair says so once, so this is `null` and the card has no sub line.
 */
export function distanceWords(
  kpi: Pick<Kpi, 'value' | 'unit' | 'measured' | 'target'> & { reason?: string | null },
): string | null {
  if (!kpi.measured || kpi.value === null) return kpi.reason ?? 'Not measured'
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
export function kpiFooter(
  kpi: Pick<Kpi, 'key' | 'n' | 'count' | 'measured' | 'target' | 'unit'>,
): [FooterPair, FooterPair] {
  const hint = SAMPLE_HINT[kpi.key as keyof typeof SAMPLE_HINT]
  return [
    { label: 'Target', value: targetWords(kpi) },
    { label: 'Counted', value: countedWords(kpi), ...(hint ? { hint } : {}) },
  ]
}

/** What a rate stands on, the absolute count first: "58 over 1,263 Issues"; a share or a duration says its sample alone. */
function countedWords(kpi: Pick<Kpi, 'key' | 'n' | 'count' | 'unit'>): string {
  const rate = kpi.unit === 'per_issue' || kpi.unit === 'per_100_issues'
  return rate && kpi.count !== null ? `${kpi.count} over ${sampleWords(kpi)}` : sampleWords(kpi)
}

/** The card's sub line: how far the KPI is from its target, or, with no number for one yet, why. */
export const subWords = (
  kpi: Pick<Kpi, 'value' | 'unit' | 'measured' | 'target' | 'reason' | 'targetSource'>,
): string | null => distanceWords(kpi) ?? (kpi.target.kind === 'trend' ? kpi.targetSource : null)

// ---- what a card says in plain words, and the order of the page --------------------------------------------------------

/** One sentence per KPI, for a reader who knows none of the words: what it is, then which way is good. */
export const MEANING: Record<KpiKey, string> = {
  avoidable_touches:
    'How often you had to step in on something the factory should have settled, per Issue a person, an agent or an alert filed. Lower is better.',
  first_verification_passes: 'Of the first checks after a ship, how many passed. Higher is better.',
  specs_not_needed: 'Of the Specs sent to you, how many you said did not need you. Lower is better.',
  errands_reached_per_100:
    'How many Errands got through to you per 100 Issues: a device, a portal or a secret only you can supply. Lower is better.',
  cycle_p50: 'How long a typical Issue takes from filed to closed. Shorter is better.',
  queue_wait_p90: 'How long the slowest tenth of Issues wait before a lead starts on them. Shorter is better.',
  quota_at_reset:
    'How much of its weekly quota each account had used when its week reset, weighted by plan size. Higher means less went unused.',
}

/** The fix-commit card's sentence: fix commits have a band of their own, not a KPI card. */
export const FIX_MEANING = 'How many fix commits landed per week, each one a mistake that shipped. Fewer is better.'

/** The KPIs the page lists as cards, in the order each group keeps (fix commits have their own band). */
export const KPI_ORDER: readonly KpiKey[] = [
  'avoidable_touches',
  'first_verification_passes',
  'specs_not_needed',
  'errands_reached_per_100',
  'cycle_p50',
  'queue_wait_p90',
  'quota_at_reset',
]

export interface KpiGroups<T> {
  /** a target that judged the figure and it is outside */
  off: T[]
  /** no figure: nothing counted, too few samples, or the source is not there */
  unmeasured: T[]
  /** a target that judged the figure and it is inside */
  met: T[]
  /** a figure with no target to judge: a trend to read, not a verdict */
  trend: T[]
}

/** The KPIs sorted by what needs attention: those off target, those with no figure, those on target, those with no target to judge. */
export function groupKpis<T extends Pick<Kpi, 'key' | 'value' | 'measured' | 'target'>>(
  kpis: readonly T[],
): KpiGroups<T> {
  const groups: KpiGroups<T> = { off: [], unmeasured: [], met: [], trend: [] }
  for (const key of KPI_ORDER) {
    for (const kpi of kpis.filter((k) => k.key === key)) {
      const status = targetStatus(kpi)
      if (status === 'missed') groups.off.push(kpi)
      else if (status === 'not_measured' || status === 'no_data') groups.unmeasured.push(kpi)
      else if (status === 'met') groups.met.push(kpi)
      else groups.trend.push(kpi)
    }
  }
  return groups
}

export interface PartRow {
  key: string
  label: string
  /** the part in the KPI's unit, in words */
  value: string
  /** its share of the parts together, 0 to 1 */
  share: number
}

/** The parts of a KPI as rows, largest first, each with its share of the whole; none when the parts add up to nothing. */
export function partRows(kpi: Pick<Kpi, 'parts'>): PartRow[] {
  const total = kpi.parts.reduce((sum, part) => sum + part.value, 0)
  if (total <= 0) return []
  return kpi.parts
    .toSorted((a, b) => b.value - a.value)
    .map((part) => ({
      key: part.key,
      label: part.label,
      value: formatValue(part.unit, part.value),
      share: part.value / total,
    }))
}

/** The KPIs whose card shows what the figure is made of (the others keep that in the popover). */
export const PARTS_ON_CARD: ReadonlySet<KpiKey> = new Set([
  'avoidable_touches',
  'errands_reached_per_100',
  'queue_wait_p90',
])

// ---- the fix-commit card -----------------------------------------------------------------------------------------------

export interface FixCard {
  /** the newest week's fix commits */
  latest: number
  change: Change
  /** fewer is better: a rise is bad, a fall good */
  tone: Tone
  /** every cause in the API's order with its slot (the colour follows the cause, not its rank), its total and weekly counts */
  causes: { key: string; meaning: string; slot: number; total: number; counts: number[] }[]
  /** the weeks, oldest first, each with a count per cause (same order as `causes`) */
  weeks: { label: string; total: number; counts: number[] }[]
  /** fix commits in the shown weeks */
  total: number
  /** the cause with the most fix commits, null when there are none */
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
export function fixCard(model: Pick<FixCommitsModel, 'causes' | 'weeks'>): FixCard {
  const weeks = fixWeeksOldestFirst(model)
  const causes = model.causes.map((c, slot) => {
    const counts = weeks.map((w) => w.byCause[c.key] ?? 0)
    return { key: c.key, meaning: c.meaning, slot, total: counts.reduce((a, b) => a + b, 0), counts }
  })
  const totals = weeks.map((w) => w.total)
  const latest = totals.at(-1) ?? 0
  const previous = totals.length > 1 ? (totals.at(-2) ?? null) : null
  const change = countChange(latest, previous)
  const busiest = causes.reduce<FixCard['busiest']>(
    (best, c) => (c.total > (best?.total ?? 0) ? { key: c.key, total: c.total } : best),
    null,
  )
  return {
    latest,
    change,
    tone: change.difference === null || change.difference === 0 ? 'neutral' : change.difference > 0 ? 'bad' : 'good',
    causes,
    weeks: weeks.map((w, i) => ({
      label: fixWeekLabel(w),
      total: w.total,
      counts: causes.map((c) => c.counts[i] ?? 0),
    })),
    total: totals.reduce((a, b) => a + b, 0),
    busiest,
  }
}

// ---- words the seat tables and the Overview share ------------------------------------------------------------

/** A wait or duration: milliseconds under a second, else the KPI duration words. */
const msWords = (ms: number | null): string =>
  ms === null ? '–' : ms < 1000 ? `${Math.round(ms)} ms` : formatValue('ms', ms)

const QUEUE_REASON_WORDS: Record<string, string> = {
  memory: 'Host memory',
  memory_fit: 'Memory: the lead does not fit',
  claim: "The repo's claim",
  lane: "A lane's cap",
  window: "An account's window",
  cap: "An account's lead cap",
  load: 'Host load',
  tests: 'The test line',
  boot: 'Host boot grace',
  drain: 'The queue is draining',
  chain: 'An after edge',
  line: 'A stopped line',
  finalizing: 'Another Issue finalizing',
  spec: 'A Spec at the owner',
  unknown_project: 'An unknown project',
  doctor: "The project's doctor check",
  unrecorded: 'No reason recorded',
}

/** A queue reason kind in words; a kind the Console does not know reads as itself. */
export const queueReasonWords = (kind: string): string => QUEUE_REASON_WORDS[kind] ?? kind

/** The seat rows of the "By seat" table, in the words the Console shows. */
export const SEAT_LABEL: Record<SeatKpiRow['seat'], string> = { light: 'Light', lead: 'Lead', filed: 'Filed seat' }

const rateWords = (rate: number | null): string => (rate === null ? '–' : formatValue('share', rate))

/** A seat row's cells as text: Issues with their share, the rates, the medians and the cost; none is an en dash. */
export function seatCells(row: SeatKpiRow) {
  return {
    issues: row.share === null ? `${row.issues}` : `${row.issues} (${rateWords(row.share)})`,
    firstPass: row.firstPassRate === null ? '–' : `${rateWords(row.firstPassRate)} of ${row.firstWatches}`,
    regressions: `${row.regressions}`,
    refusals: `${row.refusals}`,
    cycle: msWords(row.cycleP50Ms),
    working: msWords(row.workingP50Ms),
    cost: row.costPerIssue === null ? '–' : formatValue('usd', row.costPerIssue),
    movedUp: row.seat === 'light' ? `${row.movedUp}` : '–',
  }
}

/** The tripwire line under the seat table: whether triage's small starts light now, the inputs, and why not. */
export function tripwireWords(tripwire: SeatKpis['tripwire']): string {
  const { points, days, minWatches, light, lead, bound, met, failing, passGap, regressionGap, confidence } = tripwire
  const state =
    met === true
      ? "Triage's small starts on the light seat"
      : met === false
        ? "Triage's small stays on the lead row"
        : "Triage's small stays on the lead row until it is measured"
  const rates =
    light.finishedPassRate === null || lead.finishedPassRate === null
      ? `light has ${light.finishedWatches} finished first watches (${minWatches} needed), lead ${lead.finishedWatches}`
      : `light passed ${rateWords(light.finishedPassRate)} of ${light.finishedWatches} finished first watches, lead ${rateWords(lead.finishedPassRate)} of ${lead.finishedWatches}`
  const moves =
    bound === null || light.movedUpShare === null
      ? 'move-up bound not measured'
      : `${rateWords(light.movedUpShare)} moved up, bound ${rateWords(bound.share)}`
  const gap =
    passGap === null
      ? ''
      : passGap.points < 0
        ? `; light's pass rate is ${(-passGap.points).toFixed(1)} points over lead's`
        : `; lead's pass rate is ${passGap.points.toFixed(1)} points over light's, at least ${passGap.lower.toFixed(1)} at ${Math.round(confidence * 100)} % (shown only above ${points})`
  const regressions =
    regressionGap === null
      ? ''
      : `, light ${regressionGap.perIssue >= 0 ? '+' : ''}${perIssueWords(regressionGap.perIssue)} on lead's (at least ${perIssueWords(regressionGap.lower)})`
  const why = failing.length === 0 ? '' : ` Not met: ${failing.join('; ')}.`
  return `${state}. Last ${days} days: ${rates}${gap}; regressions per Issue ${perIssueWords(light.regressionsPerIssue)} against ${perIssueWords(lead.regressionsPerIssue)}${regressions}, shown and not a condition; ${moves}.${why}`
}

const perIssueWords = (value: number | null): string => (value === null ? '–' : value.toFixed(3))

/** The four delivery figures as rows of the light and lead cells, each with its one-line definition. */
export function deliveryRows(delivery: SeatKpis['delivery']) {
  const { light, lead, definitions } = delivery
  const usd = (value: number | null) => (value === null ? '–' : formatValue('usd', value))
  const passWords = (d: SeatDelivery) =>
    d.finishedPassRate === null ? '–' : `${rateWords(d.finishedPassRate)} of ${d.finishedWatches}`
  const movedWords =
    light.movedUpShare === null
      ? '–'
      : `${rateWords(light.movedUpShare)} (${light.movedUp} of ${light.issues}), ${usd(light.movedUpCost)} and ${msWords(light.movedUpMs)} each before it moved`
  return [
    {
      key: 'finishedPass',
      label: 'First pass of what finished',
      light: passWords(light),
      lead: passWords(lead),
      definition: definitions.finishedPass,
    },
    { key: 'movedUp', label: 'Moved up', light: movedWords, lead: '–', definition: definitions.movedUp },
    {
      key: 'regressions',
      label: 'Regressions per Issue',
      light: `${perIssueWords(light.regressionsPerIssue)} (${light.regressions})`,
      lead: `${perIssueWords(lead.regressionsPerIssue)} (${lead.regressions})`,
      definition: definitions.regressions,
    },
    {
      key: 'cost',
      label: 'Cost per Issue',
      light: usd(light.costPerIssue),
      lead: usd(lead.costPerIssue),
      definition: definitions.cost,
    },
  ]
}

/** The reviewer rows of the "Reviewers" table, in the words the Console shows. */
export const REVIEWER_LABEL: Record<ReviewerKpiRow['seat'], string> = { plain: 'Reviewer', cheap: 'Cheap reviewer' }

const oneDecimal = (value: number | null): string => (value === null ? '–' : value.toFixed(1))

/** A reviewer row's cells as text: the seat's words, its reviews, what they found and what became of the Issues; none is an en dash. */
export function reviewerCells(row: ReviewerKpiRow) {
  return {
    seat: row.tier && row.effort ? `${row.tier} · ${row.effort}` : row.role,
    reviews: row.deepReviews === 0 ? `${row.reviews}` : `${row.reviews} (+${row.deepReviews} deep)`,
    findings: oneDecimal(row.findingsPerReview),
    applied: row.appliedShare === null ? '–' : `${rateWords(row.appliedShare)} of ${row.applied + row.declined}`,
    rounds: oneDecimal(row.roundsPerReview),
    firstPass: row.firstPassRate === null ? '–' : `${rateWords(row.firstPassRate)} of ${row.firstWatches}`,
    regressions: row.regressionRate === null ? '–' : `${rateWords(row.regressionRate)} (${row.regressedIssues})`,
    cost: row.costPerReview === null ? '–' : formatValue('usd', row.costPerReview),
    wall: msWords(row.wallP50Ms),
  }
}

/** The tripwire lines under the reviewer table: its inputs for both seats, the last days of the cheap one, and the verdict. */
export function reviewerTripwireWords(reviewers: ReviewerKpis): string[] {
  const { tripwire: t, startShare } = reviewers
  const seat = (name: string, e: ReviewerKpis['tripwire']['cheap']) =>
    `${name}: ${e.reviews} reviews, first pass ${rateWords(e.firstPassRate)}, regressed ${rateWords(e.regressionRate)} of ${e.issues} Issues`
  const test = (ok: boolean | null) => (ok === null ? 'not measured yet' : ok ? 'holds' : 'fails')
  const verdict = t.takesAll
    ? 'The cheap reviewer takes every non-deep review.'
    : `The cheap reviewer has the light-seat Issues and ${rateWords(startShare)} of the others.`
  return [
    `${seat('Cheap', t.cheap)}; ${seat('Reviewer', t.plain)}; ${seat(`Cheap, last ${t.windowDays} days`, t.window)}.`,
    `It takes all reviews at ${t.minReviews} reviews each (${t.enough ? 'reached' : 'not reached'}), regressions no more often (${test(t.regressOk)}), first pass within ${t.points} points (${test(t.passOk)}), and goes back if its last ${t.windowDays} days (at least ${t.windowMinIssues} Issues) break either (${t.windowBreaks === null ? 'too few Issues to say' : t.windowBreaks ? 'broken' : 'not broken'}). ${verdict}`,
  ]
}
