/**
 * A hold: the answer to a stall that says "wait for it". The factory turns a hold into a timed wait instead of waking
 * the lead, who would only find the same cause and block again. The first hold waits `HOLD_BASE_MS`; each later one of the
 * same attempt waits twice as long, up to `HOLD_MAX_MS`.
 */
export const HOLD_BASE_MS = 60 * 60_000
export const HOLD_MAX_MS = 12 * 60 * 60_000

/** An option label that reads as a hold: it begins with one of these words (`Hold until the update lands`). */
const HOLD_LABEL = /^\s*(hold|wait|pause|defer|keep\s+(holding|waiting)|stay\s+(on\s+hold|blocked))\b/i

export const isHold = (answer: string): boolean => HOLD_LABEL.test(answer)

/** How long the next hold waits, given the holds this attempt already had. */
export const holdFor = (priorHolds: number): number =>
  Math.min(HOLD_MAX_MS, HOLD_BASE_MS * 2 ** Math.min(Math.max(0, priorHolds), 16))

/** The time the next hold ends. */
export const holdUntil = (now: Date, priorHolds: number): string =>
  new Date(now.getTime() + holdFor(priorHolds)).toISOString()

interface Recorded {
  kind: string
  payload: unknown
  actor: string
}

const has = (payload: unknown, name: string): boolean =>
  typeof payload === 'object' && payload !== null && Boolean((payload as Record<string, unknown>)[name])

/**
 * The holds an attempt had: a Decision answered as a hold, and a repeated stall the steward held, both timed waits.
 * `records` is the attempt's events, oldest first.
 */
export function holdsIn(records: readonly Recorded[]): number {
  const from = records.findLastIndex((record) => record.kind === 'admitted')
  return records
    .slice(from + 1)
    .filter(
      (record) =>
        (record.kind === 'answered' && has(record.payload, 'hold')) ||
        (record.kind === 'deferred' && record.actor === 'steward' && has(record.payload, 'until')),
    ).length
}
