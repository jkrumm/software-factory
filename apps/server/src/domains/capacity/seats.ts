/**
 * A wait that needs no lead at work gives the seat back: a person's wait (a Decision, a review, an Errand), a timer and
 * a dependency. A dependency matters most: a lead that waits for another Issue of the same repo must not hold the one
 * place that Issue needs. A stall (a wall, an unreported stop, a block, a regression) keeps it: the lead is alive and
 * the steward ends the stall.
 */
export const SEAT_FREEING_WAITS: ReadonlySet<string> = new Set(['timer', 'dependency', 'decision', 'review', 'errand'])

/** Whether an Issue in this state is a lead working in its repo, so it holds a seat. */
export function holdsSeat(state: string, waitReason: string | null): boolean {
  if (state === 'working' || state === 'watching') return true
  return state === 'waiting' && waitReason !== null && !SEAT_FREEING_WAITS.has(waitReason)
}
