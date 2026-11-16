/**
 * The host's memory pressure, for admission (NL6, Issues 289 and 290). `memory_pressure` and the free-page share lie
 * (65 % free with swap nearly full), so the reading is the two numbers the dev-host heartbeat grades: the swapout RATE,
 * from the cumulative swapout counter, and swap in use as a share of RAM.
 */
export interface MemoryReading {
  /** swapped-out data in the last 300 s, MiB, by the counter's delta scaled to the window */
  swapoutMbPer300s: number
  /** swap in use as a share of RAM, percent */
  swapUsedPct: number
}

export interface MemoryCeilings {
  swapoutMbPer300s: number
  swapUsedPct: number
}

/** The heartbeat's FAIL line, 2 GiB per 300 s. */
export const DEFAULT_SWAPOUT_CEILING_MB = 2048
/** The heartbeat's FAIL line, 75 % of RAM. Swap does not drain when its cause is gone, so only a leak-sized share counts. */
export const DEFAULT_SWAP_CEILING_PCT = 75
/** The 1-minute load average above which no new lead is admitted. */
export const DEFAULT_LOAD_CEILING = 60

/**
 * Memory that leads of a heavy lane are expected to take (a booted simulator is ~18 GiB), which the reading does not
 * show yet when the lead has only just started: the lanes' `memory` of the running leads and of the candidate.
 */
export interface Reserved {
  mib: number
  /** the same as a share of RAM, percent */
  pct: number
}

/** A reservation as a share of RAM (one decimal), or null when nothing is reserved or the RAM is not known. */
export function reservedOf(mib: number, ramMib: number | null): Reserved | null {
  if (mib <= 0 || ramMib === null || ramMib <= 0) return null
  return { mib, pct: Math.round((mib / ramMib) * 1000) / 10 }
}

/**
 * A new lead waits while a reading is above either ceiling; the reserved share of RAM counts as swap in use, so a host
 * that is about to take a heavy lane's memory is already full. Running leads and resumes are never touched.
 */
export const overMemory = (
  reading: MemoryReading,
  ceilings: MemoryCeilings,
  reserved: Reserved | null = null,
): boolean =>
  reading.swapoutMbPer300s > ceilings.swapoutMbPer300s ||
  reading.swapUsedPct + (reserved?.pct ?? 0) > ceilings.swapUsedPct

export const overLoad = (load: number, ceiling: number): boolean => load > ceiling

/**
 * How many minute samples in a row the load must be over its ceiling before admission pulls back (the tripwire). Measured
 * 2026-11-14 to 16 against the ceiling of 36 on 12 cores: 174 runs over it of one minute, 27 of two, 5 of three, 1 of
 * four, none of five. A peak is expected and costs nothing; five minutes is an overshoot unlike any spike of those days.
 */
export const SUSTAINED_LOAD_SAMPLES = 5
/** The oldest of those samples may be at most this old: a gap in the minute samples is no reading. */
const SUSTAINED_SPAN_MS = (SUSTAINED_LOAD_SAMPLES + 1) * 60_000

/** The tripwire's verdict: tripped with the loads that tripped it, clear, or unknown (too few fresh samples). */
export type LoadTrip = { tripped: true; loads: number[] } | { tripped: false } | null

/**
 * Whether the load has been over the ceiling in each of the newest `SUSTAINED_LOAD_SAMPLES` minute samples (newest
 * first) and still is by the reading now (a reading back under it clears the trip at once; an unread one does not).
 * Null when fewer samples are fresh: the caller falls back to the reading of the instant.
 */
export function loadTrip(
  samplesNewestFirst: readonly { at: Date; load: number | null }[],
  ceiling: number,
  now: Date,
  loadNow: number | null,
): LoadTrip {
  const window = samplesNewestFirst.slice(0, SUSTAINED_LOAD_SAMPLES)
  const oldest = window[window.length - 1]
  if (window.length < SUSTAINED_LOAD_SAMPLES || !oldest || now.getTime() - oldest.at.getTime() > SUSTAINED_SPAN_MS)
    return null
  const loads = window.map((s) => s.load)
  if (loads.some((load) => load === null)) return null
  const over = (loads as number[]).every((load) => load > ceiling) && (loadNow === null || loadNow > ceiling)
  return over ? { tripped: true, loads: (loads as number[]).map((l) => Math.round(l * 10) / 10) } : { tripped: false }
}

/** The tripwire's words: `load over 36 in each of the last 5 minutes (41.2, 38, …)`. */
export const describeTrip = (loads: readonly number[], ceiling: number): string =>
  `load over ${ceiling} in each of the last ${loads.length} minutes (${loads.join(', ')})`

/** The load ceiling of the throughput rule, in multiples of the host's cores: no new lead above 3x. */
export const DEFAULT_LOAD_PER_CORE = 3
/**
 * The process count above which no new lead is admitted under the throughput rule. The panic class is a process storm
 * (hundreds of git and test processes), not memory; a quiet host with a few leads runs ~900.
 */
export const DEFAULT_PROCESS_CAP = 1800

/** The load ceiling of the throughput rule for a host of `cores` cores. */
export const loadCeilingOf = (cores: number, perCore: number): number => Math.max(1, Math.round(cores * perCore))

export const overProcesses = (processes: number, cap: number): boolean => processes > cap

export const describeProcesses = (processes: number, cap: number): string => `${processes} processes (cap ${cap})`

/** The reason's numbers: what was read and what the ceilings are. */
export const describeMemory = (
  reading: MemoryReading,
  ceilings: MemoryCeilings,
  reserved: Reserved | null = null,
): string => {
  const read = `swapouts ${reading.swapoutMbPer300s} MiB/300s (ceiling ${ceilings.swapoutMbPer300s}), `
  const swap = `swap ${reading.swapUsedPct}% of RAM (ceiling ${ceilings.swapUsedPct}%)`
  if (!reserved) return `${read}${swap}`
  const gib = Math.round((reserved.mib / 1024) * 10) / 10
  return `${read}${swap}, plus ${gib} GiB reserved by lanes (${reserved.pct}% of RAM)`
}

export const describeLoad = (load: number, ceiling: number): string =>
  `load average ${Math.round(load * 10) / 10} (ceiling ${ceiling})`

/** The span the heartbeat grades swapouts over, and the minute samples that make it up. */
export const SUSTAIN_WINDOW_MS = 300_000

/**
 * The swapouts of the last 300 s from the minute samples (each is one minute's delta scaled to 300 s, so five of them
 * average to the window's real total). Swapouts come in bursts (0, 0, 11349, 0), so the reading of one instant admits
 * a lead between bursts while the host thrashes; the window holds the gate shut until five minutes pass quietly.
 * A sample with no figure or older than the window counts as nothing, a missing minute as 0.
 */
export function sustainedSwapoutMb(
  samples: readonly { at: Date; swapoutMbPer300s: number | null }[],
  now: Date,
): number {
  const inWindow = samples.filter(
    (s) => s.swapoutMbPer300s !== null && now.getTime() - s.at.getTime() <= SUSTAIN_WINDOW_MS,
  )
  const sum = inWindow.reduce((total, s) => total + (s.swapoutMbPer300s ?? 0), 0)
  return Math.round(sum / 5)
}

const MIB = 1024 * 1024
const UNITS: Record<string, number> = { K: 1024, M: MIB, G: 1024 * MIB }
const WINDOW_S = 300

const swapField = (swapusage: string, field: 'total' | 'used'): number | null => {
  const match = new RegExp(`${field}\\s*=\\s*([\\d.]+)\\s*([KMG])`).exec(swapusage)
  const unit = match?.[2] ? UNITS[match[2]] : undefined
  return match?.[1] && unit !== undefined ? Math.round(Number(match[1]) * unit) : null
}

/** The swap in use, in bytes, from `vm.swapusage` (`total = 10240.00M  used = 9012.25M  free = …`); null when not understood. */
export const swapUsedBytes = (swapusage: string): number | null => swapField(swapusage, 'used')

/** The swap's size, in bytes, from the same text; null when not understood. */
export const swapTotalBytes = (swapusage: string): number | null => swapField(swapusage, 'total')

/** One sample of the counters, for the next reading's rate. */
export interface SwapSample {
  swapoutPages: number
  at: number
}

/**
 * The reading from two samples of the cumulative counter: the first has no rate (0), and a counter that fell (a
 * reboot) starts over.
 */
export function memoryReadingOf(input: {
  before: SwapSample | null
  now: SwapSample
  pageSize: number
  ramBytes: number
  swapUsedBytes: number
}): MemoryReading {
  const { before, now } = input
  const seconds = before ? (now.at - before.at) / 1000 : 0
  const rate =
    before && now.swapoutPages >= before.swapoutPages && seconds > 0
      ? (((now.swapoutPages - before.swapoutPages) * input.pageSize) / MIB) * (WINDOW_S / seconds)
      : 0
  return {
    swapoutMbPer300s: Math.round(rate),
    swapUsedPct: Math.round((input.swapUsedBytes / input.ramBytes) * 1000) / 10,
  }
}

/** The boot time in seconds from `kern.boottime` (`{ sec = 1731520000, usec = 1234 } Thu Nov 13 …`); null when not understood. */
export function bootTimeSeconds(boottime: string): number | null {
  const sec = /sec\s*=\s*(\d+)/.exec(boottime)?.[1]
  return sec === undefined ? null : Number(sec)
}
