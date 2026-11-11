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

/** A host sample older than this says nothing about the memory now. */
export const SAMPLE_MAX_AGE_MS = 5 * 60_000
const MIB_HEADROOM_FLOOR = 2048
const HEADROOM_SHARE = 0.08

/** The memory kept free for the host itself: 2 GiB, or 8 % of RAM when that is more. */
export const headroomMib = (ramMib: number | null): number =>
  Math.max(MIB_HEADROOM_FLOOR, Math.round((ramMib ?? 0) * HEADROOM_SHARE))

/** The memory free by the newest host sample (not older than five minutes) and the machine's RAM; null when either is unknown. */
export function freeMibOf(
  sample: { at: Date; memoryUsedPct: number | null } | null,
  ramMib: number | null,
  now: Date,
): number | null {
  if (!sample || sample.memoryUsedPct === null || ramMib === null) return null
  if (now.getTime() - sample.at.getTime() > SAMPLE_MAX_AGE_MS) return null
  return Math.round(ramMib * (1 - sample.memoryUsedPct / 100))
}
