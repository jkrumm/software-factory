import type { ThroughputModel } from '@software-factory/contract'
import { meterTone, type Tone } from '../components/kit/tone'

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

const GIB = 1024 ** 3

/** Bytes as the number of GB (1024 x 1024 x 1024, as Activity Monitor counts), one decimal under 100: "41.2", "64". */
export const gbNumber = (bytes: number): string => {
  const gb = bytes / GIB
  return String(gb >= 100 ? Math.round(gb) : Number(gb.toFixed(1)))
}

/** An amount in GB beside the whole it is part of: "41.2 of 64 GB". */
export const gbOf = (used: number, total: number): string => `${gbNumber(used)} of ${gbNumber(total)} GB`

const whole = (value: number): string => String(Math.round(value))
const one = (value: number): string => String(Math.round(value * 10) / 10)

/** One card of the host row: the figure as the page reads it, why it is a dash, the line under it and the bar's fill (0 to 1). */
export interface HostFigure {
  value: string | null
  valueNote: string
  sub: string
  /** 0 to 1; null draws no bar */
  fill: number | null
  tone: Tone
}

/**
 * The host as amounts, from the newest minute of the window (`host.now`) and the window's typical and peak figures
 * (`host.signals`). A figure the host did not read is `null` with its reason, never zero.
 */
export function hostFigures(
  model: ThroughputModel,
): Record<'cpu' | 'memory' | 'swap' | 'pressure' | 'load', HostFigure> {
  const { now, signals } = model.host
  const over = `over ${windowName(model.hours)}`
  const unread = (what: string) => `The host did not read ${what} in its newest minute`
  const range = (p50: number | null, max: number | null, say: (v: number) => string): string =>
    p50 === null || max === null ? '' : `Typical ${say(p50)}, peak ${say(max)} ${over}.`
  const join = (...parts: string[]) => parts.filter((part) => part !== '').join(' ')
  const share = (part: number | null, total: number | null) =>
    part === null || total === null || total <= 0 ? null : part / total

  const busy = now?.cpuBusyPct ?? null
  const cpu: HostFigure = {
    value: busy === null ? null : `${whole(busy)} %`,
    valueNote: unread('the CPU'),
    sub: range(signals.cpuBusyPct.p50, signals.cpuBusyPct.max, (v) => `${whole(v)} %`),
    fill: busy === null ? null : busy / 100,
    tone: busy === null ? 'neutral' : meterTone(busy / 100),
  }

  const ram = now?.ramBytes ?? null
  const mem = now?.memoryUsedBytes ?? null
  const memShare = share(mem, ram)
  const memory: HostFigure = {
    value: mem === null || ram === null ? null : gbOf(mem, ram),
    valueNote: unread('the memory in use'),
    sub: join(
      memShare === null ? '' : `${whole(memShare * 100)} % of the RAM.`,
      range(signals.memoryUsedBytes.p50, signals.memoryUsedBytes.max, (v) => `${gbNumber(v)} GB`),
    ),
    fill: memShare,
    tone: memShare === null ? 'neutral' : meterTone(memShare),
  }

  const swapUsed = now?.swapUsedBytes ?? null
  const swapTotal = now?.swapTotalBytes ?? null
  const swapShare = share(swapUsed, ram)
  const swap: HostFigure = {
    value:
      swapUsed === null
        ? null
        : swapTotal === null || swapTotal <= 0
          ? `${gbNumber(swapUsed)} GB`
          : gbOf(swapUsed, swapTotal),
    valueNote: unread('the swap'),
    sub: join(
      swapShare === null ? '' : `${one(swapShare * 100)} % of the RAM.`,
      range(signals.swapUsedBytes.p50, signals.swapUsedBytes.max, (v) => `${gbNumber(v)} GB`),
    ),
    // the bar is the share of RAM: the swap's own size grows on demand, so full against it is ordinary
    fill: swapShare,
    tone: 'neutral',
  }

  const level = now?.pressureLevel ?? null
  const { normal, warning, critical } = signals.pressureMinutes
  const pressure: HostFigure = {
    value: level === null ? null : levelWords(level),
    valueNote: 'The host read no pressure level in its newest minute',
    sub:
      normal + warning + critical === 0
        ? ''
        : `${warning + critical} of ${normal + warning + critical} minutes at warning or critical ${over}.`,
    fill: null,
    tone: levelTone(level),
  }

  const load = now?.load ?? null
  const ceiling = now?.loadCeiling ?? null
  const cores = now?.cores ?? null
  const loadShare = share(load, ceiling)
  const loadFigure: HostFigure = {
    value: load === null ? null : ceiling === null ? one(load) : `${one(load)} of ${whole(ceiling)}`,
    valueNote: unread('the load'),
    sub: join(
      load !== null && cores !== null
        ? `${cores} cores, so ${whole((load / cores) * 100)} % of one thread each.`
        : ceiling === null
          ? ''
          : 'Ceiling is where no new lead is admitted.',
      range(signals.load.p50, signals.load.max, one),
    ),
    fill: loadShare,
    tone: loadShare === null ? 'neutral' : meterTone(loadShare),
  }
  return { cpu, memory, swap, pressure, load: loadFigure }
}

/** What the host cards' sparklines span, as the cards label it (the server reads `host.recent` over this many minutes). */
export const RECENT_SPAN = 'last 15 min'

/** One card's short trend: a value per sampled minute, a time label for each, and how a value reads (as the card's figure does). */
export interface HostTrend {
  values: (number | null)[]
  labels: string[]
  format: (value: number) => string
}

/**
 * The last minutes of CPU, memory, swap and load from `host.recent`, one point per sampled minute. The newest point is
 * the minute `host.now` reads, and `format` writes it exactly as the card's figure (`hostFigures`), so the dot on the
 * line and the number above it are the same reading.
 */
export function hostTrends(model: ThroughputModel): Record<'cpu' | 'memory' | 'swap' | 'load', HostTrend> {
  const { now, recent } = model.host
  const labels = recent.map((p) => new Date(p.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))
  const ram = now?.ramBytes ?? null
  const swapTotal = now?.swapTotalBytes ?? null
  const ceiling = now?.loadCeiling ?? null
  return {
    cpu: { values: recent.map((p) => p.cpuBusyPct), labels, format: (v) => `${whole(v)} %` },
    memory: {
      values: recent.map((p) => p.memoryUsedBytes),
      labels,
      format: (v) => (ram === null ? `${gbNumber(v)} GB` : gbOf(v, ram)),
    },
    swap: {
      values: recent.map((p) => p.swapUsedBytes),
      labels,
      format: (v) => (swapTotal === null || swapTotal <= 0 ? `${gbNumber(v)} GB` : gbOf(v, swapTotal)),
    },
    load: {
      values: recent.map((p) => p.load),
      labels,
      format: (v) => (ceiling === null ? one(v) : `${one(v)} of ${whole(ceiling)}`),
    },
  }
}

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
  tenant_class_mib: { label: 'Standing memory of the tenant class', format: mibWords },
  tenant_growth_mib: { label: 'Standing memory of a tenant that grew', format: mibWords },
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
export const progress = (
  finding: Pick<ThroughputModel['improvements'][number], 'before' | 'target' | 'after'>,
): number | null => {
  if (finding.after === null || finding.before === finding.target) return null
  return (finding.before - finding.after) / (finding.before - finding.target)
}

/** What a queue reason is, as a name for a table row (the kind's own word is `queued for` plus this). */
export const QUEUE_WORDS: Record<string, string> = {
  memory: 'Host memory',
  load: 'Host load',
  window: 'An account whose window is closed',
  cap: 'An account at its lead cap',
  lane: "A lane's cap",
  claim: 'A free claim in the repo',
  drain: 'A drain',
  boot: 'The boot grace',
}
export const queueWords = (kind: string): string => QUEUE_WORDS[kind] ?? kind

/** Hours with one decimal: "9.0 h". */
export const hoursWords = (hours: number): string => `${hours.toFixed(1)} h`

/** A UTC day ("2026-11-13") as the page labels it: "13 Nov". */
export const dayWords = (day: string): string =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

/** The counting epoch's start as a line: "Counting since 14 Nov, 18:00", and what the window picked loses when it cuts it. */
export function epochLine(model: ThroughputModel): string | null {
  if (!model.epoch) return null
  const at = new Date(model.epoch.at)
  // two calls, not one with both styles: the date and time of one call are joined by "at" in one engine and a comma in another
  const since = `${at.toLocaleDateString('en-GB', { dateStyle: 'medium' })}, ${at.toLocaleTimeString('en-GB', { timeStyle: 'short' })}`
  return model.epoch.cut
    ? `Counting since ${since}: the ${windowName(model.hours)} window starts there, and a median over earlier days waits for 3 days.`
    : `Counting since ${since}.`
}
