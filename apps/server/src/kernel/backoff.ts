/**
 * A backoff: the Judge's answer to a stall that says "wait for it". The factory turns it into a timed wait instead of waking
 * the lead, who would only find the same cause and block again. The first backoff waits `BACKOFF_BASE_MS`; each later one of
 * the same attempt waits twice as long, up to `BACKOFF_MAX_MS`. The answer is stored under the payload key `hold`.
 */
const BACKOFF_BASE_MS = 60 * 60_000
const BACKOFF_MAX_MS = 12 * 60 * 60_000

/** An option label that reads as a backoff: it begins with one of these words (`Hold until the update lands`). */
const BACKOFF_LABEL = /^\s*(hold|wait|pause|defer|keep\s+(holding|waiting)|stay\s+(on\s+hold|blocked))\b/i

export const isBackoff = (answer: string): boolean => BACKOFF_LABEL.test(answer)

/** How long the next backoff waits, given the backoffs this attempt already had. */
const backoffFor = (prior: number): number =>
  Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(Math.max(0, prior), 16))

/** The time the next backoff ends. */
export const backoffUntil = (now: Date, prior: number): string =>
  new Date(now.getTime() + backoffFor(prior)).toISOString()

interface Recorded {
  kind: string
  payload: unknown
  actor: string
}

const has = (payload: unknown, name: string): boolean =>
  typeof payload === 'object' && payload !== null && Boolean((payload as Record<string, unknown>)[name])

/**
 * The backoffs an attempt had: a Decision answered as one, and a repeated stall the steward deferred, both timed waits.
 * `records` is the attempt's events, oldest first.
 */
export function backoffsIn(records: readonly Recorded[]): number {
  const from = records.findLastIndex((record) => record.kind === 'admitted')
  return records
    .slice(from + 1)
    .filter(
      (record) =>
        (record.kind === 'answered' && has(record.payload, 'hold')) ||
        (record.kind === 'deferred' && record.actor === 'steward' && has(record.payload, 'until')),
    ).length
}
