import type { ThroughputModel } from '@software-factory/contract'
import type { Tone } from '../components/kit/tone'

/** The windows the page reads, in hours: a day, a week, two weeks (the minute rows are kept 14 days). */
export const THROUGHPUT_WINDOWS = [24, 168, 336] as const
export const DEFAULT_THROUGHPUT_WINDOW = 24

/** A `hours` search value that is one of the windows; anything else is the default. */
export const throughputWindowOf = (value: unknown): number => {
  const hours = Number(value)
  return THROUGHPUT_WINDOWS.find((w) => w === hours) ?? DEFAULT_THROUGHPUT_WINDOW
}

export const windowName = (hours: number): string =>
  hours === 24 ? '24 hours' : hours % 24 === 0 ? `${hours / 24} days` : `${hours} hours`

/** The host's process classes, in the order the page lists them when their figures tie, each with a fixed palette slot (its colour never depends on its rank). */
export const CLASS_ORDER = ['lead', 'step', 'tenant', 'factory', 'system', 'owner', 'other'] as const
export const CLASS_LABEL: Record<string, string> = {
  lead: 'Leads',
  step: 'Check steps',
  tenant: 'Tenants',
  factory: 'The factory',
  system: 'System',
  owner: 'Owner',
  other: 'Other',
}

/** The seven places a lead's wall time goes, in the order a lead lives them, each with a fixed palette slot. */
export const SPLIT_PARTS = [
  { key: 'turnSeconds', label: 'In a turn', slot: 1 },
  { key: 'stepSeconds', label: 'In a check step', slot: 2 },
  { key: 'slotWaitSeconds', label: 'Waiting for a slot', slot: 3 },
  { key: 'ciSeconds', label: 'Waiting for CI', slot: 4 },
  { key: 'mergeLockSeconds', label: 'Waiting for the merge window', slot: 5 },
  { key: 'ownerSeconds', label: 'Waiting for the owner', slot: 7 },
  { key: 'idleSeconds', label: 'Idle', slot: 9 },
] as const satisfies readonly { key: keyof ThroughputModel['lead']['split']; label: string; slot: number }[]

export const mibWords = (mib: number): string =>
  mib < 1024 ? `${Math.round(mib)} MiB` : `${(mib / 1024).toFixed(1)} GiB`

export const percentWords = (share: number): string => {
  const percent = share * 100
  return percent > 0 && percent < 1 ? '<1 %' : `${Math.round(percent)} %`
}

/** Minutes as the page reads them: under an hour in minutes, else hours with one decimal. */
export const minutesWords = (minutes: number): string =>
  minutes < 60 ? `${Math.round(minutes)} min` : `${(minutes / 60).toFixed(1)} h`

export const secondsWords = (seconds: number): string => minutesWords(seconds / 60)

export const msWords = (ms: number | null): string =>
  ms === null
    ? '–'
    : ms < 1000
      ? `${Math.round(ms)} ms`
      : ms < 60_000
        ? `${(ms / 1000).toFixed(1)} s`
        : minutesWords(ms / 60_000)

export const levelWords = (level: number | null): string =>
  level === 4 ? 'Critical' : level === 2 ? 'Warning' : level === 1 ? 'Normal' : 'Not read'

/** The tone of a pressure level: graphite when normal, warn and bad as the kernel says. */
export const levelTone = (level: number | null): Tone => (level === 4 ? 'bad' : level === 2 ? 'warn' : 'neutral')

/** The pressure level as a chart height: 1, 2 and 4 are the kernel's codes; the chart reads 0 (normal), 1 and 2. */
export const levelHeight = (level: number | null): number | null =>
  level === null ? null : level === 4 ? 2 : level === 2 ? 1 : 0

export interface ClassRow {
  class: string
  label: string
  footprintMib: number
  peakMib: number
  cores: number
  procs: number
  share: number
}

/** The classes largest first, then by the fixed order; a class with no footprint stays in the list as zeros. */
export function classRows(model: ThroughputModel): ClassRow[] {
  return [...model.host.byClass]
    .sort(
      (a, b) =>
        b.footprintMib - a.footprintMib ||
        CLASS_ORDER.indexOf(a.class as (typeof CLASS_ORDER)[number]) -
          CLASS_ORDER.indexOf(b.class as (typeof CLASS_ORDER)[number]),
    )
    .map((c) => ({
      class: c.class,
      label: CLASS_LABEL[c.class] ?? c.class,
      footprintMib: c.footprintMib,
      peakMib: c.peakMib,
      cores: c.cores,
      procs: c.procs,
      share: c.share,
    }))
}

export interface SplitRow {
  key: string
  label: string
  slot: number
  seconds: number
  share: number
}

/** A split as rows, in the order a lead lives them; the share is over the parts' sum (0 with none). */
export function splitRows(split: ThroughputModel['lead']['split']): SplitRow[] {
  const total = SPLIT_PARTS.reduce((sum, part) => sum + split[part.key], 0)
  return SPLIT_PARTS.map((part) => ({
    key: part.key,
    label: part.label,
    slot: part.slot,
    seconds: split[part.key],
    share: total === 0 ? 0 : split[part.key] / total,
  }))
}

/** What each finding kind measures, in words, and how a figure of it reads. */
export const KPI_WORDS: Record<string, { label: string; format: (value: number) => string }> = {
  failed_run_minutes: { label: 'Failed run minutes per day', format: (v) => `${Math.round(v)} min` },
  slot_minutes_per_issue: { label: 'Slot minutes per closed Issue', format: (v) => `${Math.round(v)} min` },
  step_peak_mib: { label: 'Peak memory of a step', format: mibWords },
  process_growth_mib: { label: 'Growth of a process', format: mibWords },
  queued_minutes: { label: 'Minutes Issues waited in the queue', format: (v) => minutesWords(v) },
}

export const kpiLabel = (kpi: string): string => KPI_WORDS[kpi]?.label ?? kpi
export const kpiValue = (kpi: string, value: number | null): string =>
  value === null ? '–' : (KPI_WORDS[kpi]?.format(value) ?? String(Math.round(value)))

/** How a finding stands, in words and in a tone from an explicit map. */
export const STATUS: Record<string, { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'accent' },
  shipped: { label: 'Shipped, not measured yet', tone: 'neutral' },
  moved: { label: 'Moved', tone: 'good' },
  flat: { label: 'Did not move', tone: 'warn' },
  worse: { label: 'Got worse', tone: 'bad' },
  dropped: { label: 'Dropped', tone: 'neutral' },
  unmeasured: { label: 'Not measured', tone: 'neutral' },
}

/** The Issue's number from its id ("issue_1082"), for a link. */
export const issueNumber = (id: string): string => id.replace(/^issue_/, '')

/** The share of the way from `before` to `target` that `after` got, 0 to 1 (more than 1 passed it); null with no after or no distance. */
export const progress = (finding: ThroughputModel['improvements'][number]): number | null => {
  if (finding.after === null || finding.before === finding.target) return null
  return (finding.before - finding.after) / (finding.before - finding.target)
}
