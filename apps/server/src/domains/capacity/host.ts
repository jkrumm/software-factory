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
