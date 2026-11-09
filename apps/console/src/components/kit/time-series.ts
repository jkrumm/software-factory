/** Pure helpers of the time charts: where a series breaks and which sample a pointer is nearest to. */

/**
 * The runs of a series between its gaps, as [first index, last index] pairs: a `null` reading breaks the line instead
 * of being drawn as zero.
 */
export function runsOf(values: readonly (number | null)[]): [number, number][] {
  const runs: [number, number][] = []
  let start: number | null = null
  values.forEach((value, i) => {
    if (value === null) {
      if (start !== null) runs.push([start, i - 1])
      start = null
    } else if (start === null) start = i
  })
  if (start !== null) runs.push([start, values.length - 1])
  return runs
}

/** The index of the time nearest to `at` (times ascending); -1 for none. */
export function nearestTime(times: readonly number[], at: number): number {
  let best = -1
  let distance = Infinity
  for (let i = 0; i < times.length; i++) {
    const d = Math.abs((times[i] ?? 0) - at)
    if (d < distance) {
      distance = d
      best = i
    } else if (d > distance) break
  }
  return best
}
