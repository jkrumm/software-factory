import { REVIEWER_TRIPWIRE_POINTS, REVIEWER_TRIPWIRE_REVIEWS, REVIEWER_WINDOW_MIN_ISSUES } from './roles.ts'

// The reviewer tripwire (Issue 2027), pure: the Improve read and the lead start both ask it, so one function decides.

/** What one seat's reviews and the Issues they reviewed came to; the inputs of the tripwire. */
export interface SeatEvidence {
  /** reviews (threads) on the seat */
  reviews: number
  /** the Issues assigned to the seat whose first watch ended passed or regressed */
  issues: number
  /** of those, the ones whose first watch passed */
  passed: number
  /** of those, the ones with any watch that regressed */
  regressed: number
}

export interface ReviewerTripwire {
  /** each seat has the reviews the owner asked for */
  enough: boolean
  /** the cheap row's first pass rate is no more than the allowed points under the other seat's; null while either has no first watch */
  passOk: boolean | null
  /** the Issues the cheap row reviewed regress no more often than the other seat's; null while either has no first watch */
  regressOk: boolean | null
  /** `enough`, `passOk` and `regressOk` all hold */
  met: boolean
  /** the last days of the cheap row break either test against the other seat's record, with enough Issues to say so */
  windowBreaks: boolean | null
  /** the cheap row takes every non-deep review: `met` and the window does not break it */
  takesAll: boolean
}

const rate = (count: number, of: number): number | null => (of === 0 ? null : count / of)

/** Both tests of the cheap row against the other seat; null where either side has no Issue with a first watch. */
function against(cheap: SeatEvidence, plain: SeatEvidence): { passOk: boolean; regressOk: boolean } | null {
  const cheapPass = rate(cheap.passed, cheap.issues)
  const plainPass = rate(plain.passed, plain.issues)
  const cheapRegress = rate(cheap.regressed, cheap.issues)
  const plainRegress = rate(plain.regressed, plain.issues)
  if (cheapPass === null || plainPass === null || cheapRegress === null || plainRegress === null) return null
  return {
    // in tenths of a point, so that exactly the allowed gap (0.90 against 0.88) is not lost to floating point
    passOk: Math.round((plainPass - cheapPass) * 1000) <= REVIEWER_TRIPWIRE_POINTS * 10,
    regressOk: cheapRegress <= plainRegress,
  }
}

/**
 * The tripwire, in both directions, from stored facts alone (no mode is kept, so none can drift): the cheap row takes
 * every non-deep review when each seat has `REVIEWER_TRIPWIRE_REVIEWS` reviews and the cheap row's Issues regress no more
 * often and pass their first verification within `REVIEWER_TRIPWIRE_POINTS` of the other seat's; it goes back to its
 * starting share while the last `REVIEWER_TRIPWIRE_DAYS` days of the cheap row (`window`, with at least
 * `REVIEWER_WINDOW_MIN_ISSUES` Issues) break either test against the other seat's whole record. With every review on the
 * cheap row the other seat gets no new data, which is why the window is judged against its record and not its own days.
 */
export function reviewerTripwire(input: {
  cheap: SeatEvidence
  plain: SeatEvidence
  window: SeatEvidence
}): ReviewerTripwire {
  const enough = input.cheap.reviews >= REVIEWER_TRIPWIRE_REVIEWS && input.plain.reviews >= REVIEWER_TRIPWIRE_REVIEWS
  const whole = against(input.cheap, input.plain)
  const met = enough && whole !== null && whole.passOk && whole.regressOk
  const recent = input.window.issues >= REVIEWER_WINDOW_MIN_ISSUES ? against(input.window, input.plain) : null
  const windowBreaks = recent === null ? null : !(recent.passOk && recent.regressOk)
  return {
    enough,
    passOk: whole?.passOk ?? null,
    regressOk: whole?.regressOk ?? null,
    met,
    windowBreaks,
    takesAll: met && windowBreaks !== true,
  }
}
