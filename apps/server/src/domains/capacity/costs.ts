/** How many of a step's newest peaks its learned peak is taken from. */
export const LEARNED_RUNS = 8

/** The largest of the newest peaks (newest first) that were measured; null when none was. */
export function learnedPeakMib(peaksNewestFirst: readonly (number | null)[]): number | null {
  const peaks = peaksNewestFirst.slice(0, LEARNED_RUNS).filter((peak): peak is number => peak !== null)
  return peaks.length === 0 ? null : Math.max(...peaks)
}

/** The memory the running steps will still take on: what each is learned to peak at, less what it holds now. */
export function growthMib(
  holders: readonly { name: string; rssMib: number | null }[],
  learned: ReadonlyMap<string, number | null>,
): number {
  return holders.reduce((sum, h) => sum + Math.max(0, (learned.get(h.name) ?? 0) - (h.rssMib ?? 0)), 0)
}
