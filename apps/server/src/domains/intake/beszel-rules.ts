import type { Thresholds } from './infra.ts'

/** The rules of the Beszel source: pure, no I/O, one finding per rule. */
export const RULES = ['memory', 'swap', 'swap_growth', 'disk', 'load', 'silent'] as const
export type RuleName = (typeof RULES)[number]

const MIN = 60_000
/** A rule needs this share of the expected one-per-minute samples of its window. */
const COVERAGE = 0.6
/** The newest sample may be this old for a rule to speak (the silent rule excepted). */
const FRESH_MIN = 3

/** One minute of one system, normalized. A metric the sample does not carry is null; swap absent is 0 (the hub omits zeros). */
export interface Sample {
  at: Date
  memPct: number | null
  swapUsedGb: number
  swapTotalGb: number
  diskPct: number | null
  diskUsedGb: number | null
  diskTotalGb: number | null
  load1: number | null
}

export interface SystemView {
  name: string
  /** `up`, `down`, `paused`, `pending` */
  status: string
  /** `info.t`, else `info.c` */
  threads: number | null
  /** the system record's `updated` */
  updated: Date | null
}

export interface Finding {
  rule: RuleName
  state: 'breach' | 'clear' | 'hold'
  /** start of the contiguous breached run, minute resolution */
  since: Date | null
  /** start of the contiguous clear run */
  recovered: Date | null
  /** a short phrase free of values that change every poll: the title's */
  label: string
  numbers: Record<string, number | string | null>
  summary: string
}

/** The series a rule is shown with in the facts. */
export const RULE_METRIC: Record<RuleName, ((s: Sample) => number | null) | null> = {
  memory: (s) => s.memPct,
  swap: (s) => s.swapUsedGb,
  swap_growth: (s) => s.swapUsedGb,
  disk: (s) => s.diskPct,
  load: (s) => s.load1,
  silent: null,
}

const floorMinute = (ms: number): Date => new Date(Math.floor(ms / MIN) * MIN)
const round = (n: number, digits = 1): number => Math.round(n * 10 ** digits) / 10 ** digits

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

const hold = (rule: RuleName): Finding => ({
  rule,
  state: 'hold',
  since: null,
  recovered: null,
  label: rule,
  numbers: {},
  summary: '',
})

const isFresh = (samples: readonly Sample[], now: Date): boolean => {
  const newest = samples.at(-1)
  return newest !== undefined && now.getTime() - newest.at.getTime() <= FRESH_MIN * MIN
}

const covered = (count: number, windowMin: number): boolean => count >= Math.ceil(COVERAGE * windowMin)

interface Level {
  /** the metric, null when the sample has none */
  value: (s: Sample) => number | null
  /** the breach condition on a value */
  breached: (v: number) => boolean
  sustainMin: number
  clearMin: number
}

interface LevelResult {
  state: 'breach' | 'clear' | 'hold'
  since: Date | null
  recovered: Date | null
  latest: number | null
  windowMax: number | null
  windowMin: number | null
  sustainedMin: number
}

/** The start of the run of samples at the end that all have `state` (null values are skipped). */
function runStart(samples: readonly Sample[], value: Level['value'], state: (v: number) => boolean): Date | null {
  let start: Date | null = null
  for (let i = samples.length - 1; i >= 0; i--) {
    const v = value(samples[i] as Sample)
    if (v === null) continue
    if (!state(v)) break
    start = (samples[i] as Sample).at
  }
  return start && floorMinute(start.getTime())
}

function level(samples: readonly Sample[], now: Date, spec: Level): LevelResult {
  const empty: LevelResult = {
    state: 'hold',
    since: null,
    recovered: null,
    latest: null,
    windowMax: null,
    windowMin: null,
    sustainedMin: 0,
  }
  if (!isFresh(samples, now)) return empty
  const inWindow = (min: number): number[] =>
    samples
      .filter((s) => s.at.getTime() > now.getTime() - min * MIN)
      .map(spec.value)
      .filter((v): v is number => v !== null)
  const sustain = inWindow(spec.sustainMin)
  const clear = inWindow(spec.clearMin)
  const latest =
    [...samples]
      .reverse()
      .map(spec.value)
      .find((v) => v !== null) ?? null
  const stats = (values: number[]) => ({
    latest,
    windowMax: values.length ? Math.max(...values) : null,
    windowMin: values.length ? Math.min(...values) : null,
  })
  if (covered(sustain.length, spec.sustainMin) && sustain.every(spec.breached)) {
    const since = runStart(samples, spec.value, spec.breached)
    return {
      ...empty,
      ...stats(sustain),
      state: 'breach',
      since,
      sustainedMin: since ? Math.round((now.getTime() - since.getTime()) / MIN) : spec.sustainMin,
    }
  }
  if (covered(clear.length, spec.clearMin) && clear.every((v) => !spec.breached(v))) {
    return {
      ...empty,
      ...stats(clear),
      state: 'clear',
      recovered: runStart(samples, spec.value, (v) => !spec.breached(v)),
    }
  }
  return empty
}

interface Trend {
  /** null: not enough samples to say */
  met: boolean | null
  newest: number
  oldest: number
  perHour: number
  hoursToFull: number | null
}

/** The medians of the oldest and newest `n` samples of the `windowMin` ending at `end`, and whether `judge` holds for them. */
function trendAt(
  samples: readonly Sample[],
  end: number,
  windowMin: number,
  n: number,
  value: (s: Sample) => number | null,
  judge: (t: {
    newest: number
    oldest: number
    perHour: number
    last: Sample
    points: Sample[]
  }) => Pick<Trend, 'met' | 'hoursToFull'>,
): Trend {
  const stop = (samples[end] as Sample).at.getTime()
  const points = samples.slice(0, end + 1).filter((s) => s.at.getTime() > stop - windowMin * MIN && value(s) !== null)
  if (points.length < 2 * n) return { met: null, newest: 0, oldest: 0, perHour: 0, hoursToFull: null }
  const old = points.slice(0, n)
  const recent = points.slice(-n)
  const oldest = median(old.map((s) => value(s) as number))
  const newest = median(recent.map((s) => value(s) as number))
  const timeOf = (group: Sample[]) => (group[Math.floor(group.length / 2)] as Sample).at.getTime()
  const hours = (timeOf(recent) - timeOf(old)) / (60 * MIN)
  const perHour = hours > 0 ? (newest - oldest) / hours : 0
  const verdict = judge({ newest, oldest, perHour, last: points.at(-1) as Sample, points })
  return { ...verdict, newest, oldest, perHour }
}

interface TrendSpec {
  windowMin: number
  n: number
  clearMin: number
  value: (s: Sample) => number | null
  judge: Parameters<typeof trendAt>[5]
}

function trend(samples: readonly Sample[], now: Date, spec: TrendSpec) {
  const at = (i: number) => trendAt(samples, i, spec.windowMin, spec.n, spec.value, spec.judge)
  const none = {
    state: 'hold' as 'breach' | 'clear' | 'hold',
    since: null as Date | null,
    recovered: null as Date | null,
  }
  if (!isFresh(samples, now) || samples.length === 0) return { ...none, last: null }
  const lastIndex = samples.length - 1
  const last = at(lastIndex)
  if (last.met === null) return { ...none, last }
  // Walks back while the verdict stays the same; the first sample where it flips (or cannot be said) ends the run.
  const startOf = (want: boolean): Date => {
    let found = samples[lastIndex] as Sample
    for (let i = lastIndex - 1; i >= 0; i--) {
      if (at(i).met !== want) break
      found = samples[i] as Sample
    }
    return floorMinute(found.at.getTime())
  }
  if (last.met) return { state: 'breach' as const, since: startOf(true), recovered: null, last }
  const clearIndex = samples.findLastIndex((s) => s.at.getTime() <= now.getTime() - spec.clearMin * MIN)
  if (clearIndex < 0 || at(clearIndex).met !== false) return { ...none, last }
  return { state: 'clear' as const, since: null, recovered: startOf(false), last }
}

const gb = (n: number): string => `${round(n)} GB`

function swapGrowth(samples: readonly Sample[], now: Date, t: Thresholds['swap_growth']): Finding {
  const result = trend(samples, now, {
    windowMin: t.windowMin,
    n: t.medianN,
    clearMin: t.clearMin,
    value: (s) => s.swapUsedGb,
    judge: ({ newest, oldest }) => ({ met: newest - oldest >= t.growthGb && newest >= t.minGb, hoursToFull: null }),
  })
  if (result.state === 'hold' || !result.last) return hold('swap_growth')
  const grown = result.last.newest - result.last.oldest
  return {
    rule: 'swap_growth',
    state: result.state,
    since: result.since,
    recovered: result.recovered,
    label: `swap growing by ${t.growthGb} GB in ${t.windowMin} min`,
    numbers: {
      latest: round(result.last.newest, 2),
      windowMax: round(Math.max(...samples.map((s) => s.swapUsedGb)), 2),
      growthGb: round(grown, 2),
      threshold: t.growthGb,
      minGb: t.minGb,
      minutesSustained: result.since ? Math.round((now.getTime() - result.since.getTime()) / MIN) : 0,
    },
    summary: `swap grew ${gb(grown)} over ${t.windowMin} min, now ${gb(result.last.newest)}`,
  }
}

/** The medians of the window's three equal parts, oldest first; null when a part has too few samples to say. */
function thirdMedians(points: readonly Sample[], value: (s: Sample) => number | null): [number, number, number] | null {
  const size = Math.floor(points.length / 3)
  if (size < 1) return null
  const part = (i: number) =>
    median(points.slice(i * size, i === 2 ? points.length : (i + 1) * size).map((s) => value(s) as number))
  return [part(0), part(1), part(2)]
}

/** Each third of a window must carry at least this share of the net growth: a burst at one end, or a swing that came back, does not. */
const SUSTAINED_SHARE = 0.25

/**
 * Fills toward full: the net growth over the window is sustained (each third of it carries a share, so a short burst or
 * a reversed swing is not a fill), the disk is past the free-space floor (`minPct`), and at that rate it is full within `fillHours`.
 */
function diskFill(samples: readonly Sample[], now: Date, t: Thresholds['disk']) {
  const used = (s: Sample) => (s.diskUsedGb !== null && s.diskTotalGb !== null ? s.diskUsedGb : null)
  return trend(samples, now, {
    windowMin: t.windowMin,
    n: t.medianN,
    clearMin: t.clearMin,
    value: used,
    judge: ({ newest, oldest, perHour, last, points }) => {
      const total = last.diskTotalGb
      const pct = last.diskPct
      if (total === null || pct === null || perHour <= t.growthGbPerHour || pct < t.minPct)
        return { met: false, hoursToFull: null }
      const thirds = thirdMedians(points, used)
      const net = newest - oldest
      const sustained =
        thirds !== null &&
        thirds[1] - thirds[0] >= SUSTAINED_SHARE * net &&
        thirds[2] - thirds[1] >= SUSTAINED_SHARE * net
      if (!sustained) return { met: false, hoursToFull: null }
      const hoursToFull = Math.max(0, total - newest) / perHour
      return { met: hoursToFull < t.fillHours, hoursToFull }
    },
  })
}

function disk(samples: readonly Sample[], now: Date, t: Thresholds['disk']): Finding {
  const level_ = level(samples, now, {
    value: (s) => s.diskPct,
    breached: (v) => v >= t.pct,
    sustainMin: t.sustainMin,
    clearMin: t.clearMin,
  })
  const fill = diskFill(samples, now, t)
  const base = { rule: 'disk' as const }
  const fillNumbers = {
    growthGbPerHour: fill.last ? round(fill.last.perHour, 2) : null,
    hoursToFull: fill.last?.hoursToFull != null ? round(fill.last.hoursToFull) : null,
  }
  const numbers = {
    latest: level_.latest,
    windowMax: level_.windowMax,
    windowMin: level_.windowMin,
    threshold: t.pct,
    minutesSustained: level_.sustainedMin,
    ...fillNumbers,
  }
  if (level_.state === 'breach') {
    const since =
      fill.state === 'breach' && fill.since && level_.since && fill.since < level_.since ? fill.since : level_.since
    return {
      ...base,
      state: 'breach',
      since,
      recovered: null,
      label: `disk above ${t.pct}%`,
      numbers,
      summary: `disk ${level_.latest}%, above ${t.pct}% for ${level_.sustainedMin} min`,
    }
  }
  if (fill.state === 'breach') {
    const minutes = fill.since ? Math.round((now.getTime() - fill.since.getTime()) / MIN) : 0
    return {
      ...base,
      state: 'breach',
      since: fill.since,
      recovered: null,
      label: `disk filling fast`,
      numbers: { ...numbers, minutesSustained: minutes },
      summary: `disk ${level_.latest}%, growing ${fillNumbers.growthGbPerHour} GB/h, full in ${fillNumbers.hoursToFull} h`,
    }
  }
  if (level_.state === 'clear' && fill.state === 'clear') {
    const recovered = [level_.recovered, fill.recovered].filter((d): d is Date => d !== null)
    return {
      ...base,
      state: 'clear',
      since: null,
      recovered: recovered.length ? new Date(Math.max(...recovered.map((d) => d.getTime()))) : null,
      label: `disk back below ${t.pct}%`,
      numbers,
      summary: `disk ${level_.latest}%, below ${t.pct}% and not filling fast`,
    }
  }
  return hold('disk')
}

function silent(samples: readonly Sample[], system: SystemView, now: Date, t: Thresholds['silent']): Finding {
  const newest = samples.at(-1)
  const ageMin = newest ? (now.getTime() - newest.at.getTime()) / MIN : null
  const downMin = system.status === 'down' && system.updated ? (now.getTime() - system.updated.getTime()) / MIN : null
  const label = `silent for over ${t.staleMin} min`
  if ((ageMin !== null && ageMin >= t.staleMin) || (downMin !== null && downMin >= t.staleMin)) {
    const staleSince = newest && ageMin !== null && ageMin >= t.staleMin ? newest.at : null
    const downSince = downMin !== null && downMin >= t.staleMin ? system.updated : null
    const since = [staleSince, downSince]
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0]
    const silentMin = Math.round(Math.max(ageMin ?? 0, downMin ?? 0))
    return {
      rule: 'silent',
      state: 'breach',
      since: since ? floorMinute(since.getTime()) : null,
      recovered: null,
      label,
      numbers: {
        latest: ageMin === null ? null : round(ageMin),
        windowMax: silentMin,
        threshold: t.staleMin,
        minutesSustained: silentMin,
        status: system.status,
      },
      summary: `no data for ${silentMin} min (status ${system.status})`,
    }
  }
  if (!isFresh(samples, now) || system.status === 'down') return hold('silent')
  const recent = samples.filter((s) => s.at.getTime() > now.getTime() - t.clearMin * MIN)
  if (!covered(recent.length, t.clearMin)) return hold('silent')
  // The run of samples with no gap longer than the freshness limit.
  let start = (samples.at(-1) as Sample).at
  for (let i = samples.length - 2; i >= 0; i--) {
    const at = (samples[i] as Sample).at
    if (start.getTime() - at.getTime() > FRESH_MIN * MIN) break
    start = at
  }
  return {
    rule: 'silent',
    state: 'clear',
    since: null,
    recovered: floorMinute(start.getTime()),
    label: `reporting again`,
    numbers: { latest: ageMin === null ? null : round(ageMin), threshold: t.staleMin, status: system.status },
    summary: `reporting again`,
  }
}

/** One finding per rule; `hold` means nothing to say. A paused system has none. */
export function evaluate(samples: readonly Sample[], system: SystemView, thresholds: Thresholds, now: Date): Finding[] {
  if (system.status === 'paused') return []
  const t = thresholds

  const memory = ((): Finding => {
    const r = level(samples, now, {
      value: (s) => s.memPct,
      breached: (v) => v >= t.memory.pct,
      sustainMin: t.memory.sustainMin,
      clearMin: t.memory.clearMin,
    })
    return levelFinding('memory', r, {
      label: `memory above ${t.memory.pct}%`,
      cleared: `memory back below ${t.memory.pct}%`,
      threshold: t.memory.pct,
      text: (v) => `memory ${v}%, above ${t.memory.pct}% for ${r.sustainedMin} min`,
    })
  })()

  const swap = ((): Finding => {
    const r = level(samples, now, {
      value: (s) => s.swapUsedGb,
      breached: (v) => v >= t.swap.usedGb,
      sustainMin: t.swap.sustainMin,
      clearMin: t.swap.clearMin,
    })
    return levelFinding('swap', r, {
      label: `swap above ${t.swap.usedGb} GB`,
      cleared: `swap back below ${t.swap.usedGb} GB`,
      threshold: t.swap.usedGb,
      text: (v) => `swap ${gb(v)}, above ${t.swap.usedGb} GB for ${r.sustainedMin} min`,
    })
  })()

  const load = ((): Finding => {
    const limit = system.threads ? t.load.perThread * system.threads : t.load.fallbackAbsolute
    const r = level(samples, now, {
      value: (s) => s.load1,
      breached: (v) => v >= limit,
      sustainMin: t.load.sustainMin,
      clearMin: t.load.clearMin,
    })
    return levelFinding('load', r, {
      label: system.threads ? `load above ${t.load.perThread} per thread` : `load above ${t.load.fallbackAbsolute}`,
      cleared: `load back below ${round(limit)}`,
      threshold: round(limit),
      text: (v) => `load ${v}, above ${round(limit)} for ${r.sustainedMin} min`,
      extra: { threads: system.threads },
    })
  })()

  return [
    memory,
    swap,
    swapGrowth(samples, now, t.swap_growth),
    disk(samples, now, t.disk),
    load,
    silent(samples, system, now, t.silent),
  ]
}

function levelFinding(
  rule: RuleName,
  r: LevelResult,
  o: {
    label: string
    cleared: string
    threshold: number
    text: (latest: number) => string
    extra?: Record<string, number | null>
  },
): Finding {
  if (r.state === 'hold') return hold(rule)
  const latest = r.latest === null ? null : round(r.latest, 2)
  return {
    rule,
    state: r.state,
    since: r.since,
    recovered: r.recovered,
    label: r.state === 'breach' ? o.label : o.cleared,
    numbers: {
      latest,
      windowMax: r.windowMax === null ? null : round(r.windowMax, 2),
      windowMin: r.windowMin === null ? null : round(r.windowMin, 2),
      threshold: o.threshold,
      minutesSustained: r.sustainedMin,
      ...o.extra,
    },
    summary: r.state === 'breach' && latest !== null ? o.text(latest) : o.cleared,
  }
}
