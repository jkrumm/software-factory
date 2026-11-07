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

/** A new lead waits while a reading is above either ceiling. Running leads and resumes are never touched. */
export const overMemory = (reading: MemoryReading, ceilings: MemoryCeilings): boolean =>
  reading.swapoutMbPer300s > ceilings.swapoutMbPer300s || reading.swapUsedPct > ceilings.swapUsedPct

export const overLoad = (load: number, ceiling: number): boolean => load > ceiling

/** The reason's numbers: what was read and what the ceilings are. */
export const describeMemory = (reading: MemoryReading, ceilings: MemoryCeilings): string =>
  `swapouts ${reading.swapoutMbPer300s} MiB/300s (ceiling ${ceilings.swapoutMbPer300s}), ` +
  `swap ${reading.swapUsedPct}% of RAM (ceiling ${ceilings.swapUsedPct}%)`

export const describeLoad = (load: number, ceiling: number): string =>
  `load average ${Math.round(load * 10) / 10} (ceiling ${ceiling})`

const MIB = 1024 * 1024
const UNITS: Record<string, number> = { K: 1024, M: MIB, G: 1024 * MIB }
const WINDOW_S = 300

/** The swap in use, in bytes, from `vm.swapusage` (`total = 10240.00M  used = 9012.25M  free = …`); null when not understood. */
export function swapUsedBytes(swapusage: string): number | null {
  const match = /used\s*=\s*([\d.]+)\s*([KMG])/.exec(swapusage)
  const unit = match?.[2] ? UNITS[match[2]] : undefined
  return match?.[1] && unit !== undefined ? Number(match[1]) * unit : null
}

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
