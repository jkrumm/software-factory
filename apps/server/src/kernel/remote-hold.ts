/**
 * The hold a step loses its place off the mini for (issue 2028). A run off the mini that was red where the mini was green
 * is a disagreement. A step's hold is derived from its ledger rows alone (facts stored, state derived): the first
 * disagreement holds it for `FIRST_HOLD_MS`, each further one within `WINDOW_MS` of the end of the last hold doubles the hold up to
 * `MAX_HOLD_MS`, and a green run off the mini after a hold (so it took the place back) halves it.
 */

export const FIRST_HOLD_MS = 3_600_000
export const MAX_HOLD_MS = 7 * 86_400_000
/** A disagreement more than this after the previous hold ended starts again at the first hold. */
export const WINDOW_MS = 7 * 86_400_000
/** The ledger is read this far back: a hold ends within `MAX_HOLD_MS`, a doubling chain reaches back a week more. */
export const HOLD_LOOKBACK_MS = MAX_HOLD_MS + WINDOW_MS

/** One ledger fact of a step: a disagreement on the mini, or a green run on the step host. */
export interface HoldEvent {
  at: Date
  kind: 'disagreed' | 'green'
}

export interface HoldState {
  /** the length of the hold the newest disagreement set, after the greens since (0: none left) */
  holdMs: number
  /** when the newest disagreement happened; null: none in the ledger */
  lastDisagreementAt: Date | null
  /** when the hold ends; null: no hold at all */
  until: Date | null
  /** disagreements in a chain: each within a week of the end of the hold before */
  disagreements: number
  /** a green run off the mini after the newest hold already halved it: one halving per hold */
  eased: boolean
}

export const NO_HOLD: HoldState = { holdMs: 0, lastDisagreementAt: null, until: null, disagreements: 0, eased: false }

/** The hold a step is under at the end of `events`. A hold that has ended still stands for the next doubling. */
export function holdOf(events: readonly HoldEvent[]): HoldState {
  let state = NO_HOLD
  const ordered = [...events].sort((a, b) => a.at.getTime() - b.at.getTime())
  for (const event of ordered) {
    if (event.kind === 'disagreed') {
      // measured from the end of the hold: a disagreement can only come after it, so the seven-day hold stays reachable
      const chained = state.until !== null && event.at.getTime() - state.until.getTime() <= WINDOW_MS
      const holdMs = chained && state.holdMs > 0 ? Math.min(MAX_HOLD_MS, state.holdMs * 2) : FIRST_HOLD_MS
      state = {
        holdMs,
        lastDisagreementAt: event.at,
        until: new Date(event.at.getTime() + holdMs),
        disagreements: chained ? state.disagreements + 1 : 1,
        eased: false,
      }
    } else if (state.until !== null && !state.eased && event.at.getTime() >= state.until.getTime()) {
      // a green run after the hold took the place back: the next hold starts from half
      const half = state.holdMs / 2
      state = { ...state, holdMs: half < FIRST_HOLD_MS ? 0 : half, eased: true }
    }
  }
  return state
}

/** The hold now, or null when the step may go off the mini. */
export function activeHold(state: HoldState, now: Date): { until: Date; holdMs: number } | null {
  if (state.until === null || state.lastDisagreementAt === null || state.until.getTime() <= now.getTime()) return null
  return { until: state.until, holdMs: state.until.getTime() - state.lastDisagreementAt.getTime() }
}

/** A duration as the wait line says it: "1 h", "2 h", "3 d". */
export function holdWords(ms: number): string {
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) return `${ms / 86_400_000} d`
  const hours = Math.round((ms / 3_600_000) * 10) / 10
  return hours >= 1 ? `${hours} h` : `${Math.round(ms / 60_000)} min`
}
