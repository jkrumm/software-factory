import type { FindingClass, FrictionCount, Kpi, KpiKey } from '@software-factory/contract'

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

function formatValue(unit: Kpi['unit'], value: number): string {
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

export const STATUS_LABEL: Record<TargetStatus, string> = {
  met: 'Met',
  missed: 'Missed',
  trend: 'Trend',
  no_target: 'No target',
  no_data: 'No data',
  not_measured: 'Not measured',
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

export const FRICTION_GROUP_LABEL: Record<FrictionCount['group'], string> = {
  avoidable_touch: 'Avoidable touches',
  orchestrator_steer: 'The orchestrator steering leads',
  refusal: 'Refusals',
  stall: 'Stalls',
  lead_gone: 'Leads that went away',
  undelivered_note: 'Notes that never arrived',
  unreviewed_ship: 'Ships without a review',
  regression: 'Regressions',
  decision_settled: 'Decisions settled by default',
  signal: 'Signals',
}

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
