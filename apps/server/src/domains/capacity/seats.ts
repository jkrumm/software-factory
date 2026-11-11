/** How many host samples (one per minute) must all say the machine idles. */
export const SEAT_SAMPLES = 5
/** The newest of them may not be older than this, nor the oldest: a gap in the minute samples says nothing. */
export const SEAT_SAMPLE_MAX_AGE_MS = 6 * 60_000
/** What one extra lead is taken to cost when no queued repo has a learned figure. */
export const DEFAULT_TYPICAL_LEAD_MIB = 4096

export interface SeatInputs {
  /** the newest host samples, newest first; fewer than `SEAT_SAMPLES` (or an old one) is passed as what exists and gives 0 */
  recent: readonly { load: number | null; swapUsedPct: number | null }[]
  loadCeiling: number
  swapCeilingPct: number
  /** queue entries a seat would let start: those refused for the account cap */
  queued: number
  freeMib: number | null
  typicalLeadMib: number
  headroomMib: number
  maxBonus: number
}

/**
 * The extra leads per account the machine can take while it idles: 0 unless work is queued behind the cap and each of the
 * newest five minute samples shows a load of at most a quarter of the ceiling and swap below its ceiling; then as many
 * leads of the typical size as fit into the free memory beyond the headroom, never more than the bonus allows or work waits.
 */
export function seatBonus(input: SeatInputs): number {
  if (input.maxBonus <= 0 || input.queued <= 0 || input.freeMib === null) return 0
  if (input.recent.length < SEAT_SAMPLES) return 0
  const idle = input.recent.every(
    (s) =>
      s.load !== null &&
      s.load <= input.loadCeiling / 4 &&
      s.swapUsedPct !== null &&
      s.swapUsedPct < input.swapCeilingPct,
  )
  if (!idle) return 0
  const fit = Math.floor((input.freeMib - input.headroomMib) / Math.max(1, input.typicalLeadMib))
  return Math.max(0, Math.min(fit, input.maxBonus, input.queued))
}
