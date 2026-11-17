/**
 * The line production's pressure on the step host is measured against (issue 2028): shared by the placement
 * (`domains/capacity/remote.ts`) and the Throughput read, which shows it.
 */

/**
 * Production stalled more than this share of the last 10 s on memory or io: no new step goes to the VPS until it settles.
 * Until a day of probe samples with no step running exists, the line is `DEFAULT_PRESSURE_PCT`; after it, just above the
 * baseline's p99 (`pressureThreshold`), never above `MAX_PRESSURE_PCT`. At rest the VPS reads 0.00 for both (2026-11-17), so
 * the old flat 10 meant production already stalled a tenth of the time.
 */
export const DEFAULT_PRESSURE_PCT = 1
export const MAX_PRESSURE_PCT = 10
/** The baseline needs this much time between its first and its newest sample, and this many samples in it. */
export const BASELINE_MIN_SPAN_MS = 24 * 3_600_000
export const BASELINE_MIN_SAMPLES = 200
/** The samples a baseline reads, and how long a sample is kept. */
export const BASELINE_WINDOW_MS = 3 * 86_400_000
/** The line sits this far above the p99: the larger of half a point and a quarter of the p99. */
export const THRESHOLD_MARGIN_PCT = 0.5
export const THRESHOLD_MARGIN_SHARE = 0.25

/** The probe samples taken with no step running on the VPS: how many, over how long, and the 99th percentile of each pressure. */
export interface PressureBaseline {
  samples: number
  spanMs: number
  memoryP99: number
  ioP99: number
}

export interface PressureThreshold {
  memory: number
  io: number
  from: 'default' | 'baseline'
}

/** The line just above a p99: its margin on top, one decimal, at most `MAX_PRESSURE_PCT`. */
export const aboveP99 = (p99: number): number => {
  const line = p99 + Math.max(THRESHOLD_MARGIN_PCT, p99 * THRESHOLD_MARGIN_SHARE)
  // hundredths first: 0.7 * 10 is 7.000000000000001, which would round the line up to 0.8
  return Math.min(MAX_PRESSURE_PCT, Math.ceil(Math.round(line * 1000) / 100) / 10)
}

/** The pressure lines: from the baseline when it holds a day of samples, else `DEFAULT_PRESSURE_PCT`. */
export function pressureThreshold(baseline: PressureBaseline | null): PressureThreshold {
  if (baseline === null || baseline.spanMs < BASELINE_MIN_SPAN_MS || baseline.samples < BASELINE_MIN_SAMPLES)
    return { memory: DEFAULT_PRESSURE_PCT, io: DEFAULT_PRESSURE_PCT, from: 'default' }
  return { memory: aboveP99(baseline.memoryP99), io: aboveP99(baseline.ioP99), from: 'baseline' }
}
