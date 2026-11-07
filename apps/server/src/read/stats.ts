/** The small maths of the read models: percentiles, the window of days, a share. Pure. */

/** The `p`-th percentile (0 to 1) of the values by linear interpolation; null when there are none. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(Math.max(p, 0), 1) * (sorted.length - 1)
  const low = Math.floor(rank)
  const high = Math.ceil(rank)
  const a = sorted[low] ?? 0
  const b = sorted[high] ?? a
  return a + (b - a) * (rank - low)
}

/** The `days` days that end at `now`. */
export function windowOf(now: Date, days: number): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - days * 24 * 3_600_000), to: now }
}

/** `count` per `n`; null when there is nothing to divide by. */
export const per = (count: number, n: number): number | null => (n === 0 ? null : count / n)
