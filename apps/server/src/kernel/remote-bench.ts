/**
 * The bench a step loses its place off the mini for (issue 2028). A run off the mini that was red where the mini was green
 * is a disagreement. A step's bench is derived from its ledger rows alone (facts stored, state derived): the first
 * disagreement benches it for `FIRST_BENCH_MS`, each further one within `WINDOW_MS` of the end of the last bench doubles the bench up to
 * `MAX_BENCH_MS`, and a green run off the mini after a bench (so it took the place back) halves it.
 */

export const FIRST_BENCH_MS = 3_600_000
export const MAX_BENCH_MS = 7 * 86_400_000
/** A disagreement more than this after the previous bench ended starts again at the first bench. */
const WINDOW_MS = 7 * 86_400_000
/**
 * The ledger is read this far back: a chain that doubles to the cap spans nine disagreements, each up to a week after the
 * last bench, so a shorter read would restart a long chain at its oldest visible event and shorten the bench.
 */
export const BENCH_LOOKBACK_MS = 90 * 86_400_000

/** One ledger fact of a step: a disagreement on the mini, or a green run on the step host. */
export interface BenchEvent {
  at: Date
  kind: 'disagreed' | 'green'
}

export interface BenchState {
  /** the length of the bench the newest disagreement set, after the greens since (0: none left) */
  benchMs: number
  /** when the newest disagreement happened; null: none in the ledger */
  lastDisagreementAt: Date | null
  /** when the bench ends; null: no bench at all */
  until: Date | null
  /** disagreements in a chain: each within a week of the end of the bench before */
  disagreements: number
  /** a green run off the mini after the newest bench already halved it: one halving per bench */
  eased: boolean
}

export const NO_BENCH: BenchState = {
  benchMs: 0,
  lastDisagreementAt: null,
  until: null,
  disagreements: 0,
  eased: false,
}

/** The bench a step is under at the end of `events`. A bench that has ended still stands for the next doubling. */
export function benchOf(events: readonly BenchEvent[]): BenchState {
  let state = NO_BENCH
  const ordered = [...events].sort((a, b) => a.at.getTime() - b.at.getTime())
  for (const event of ordered) {
    if (event.kind === 'disagreed') {
      // measured from the end of the bench: a disagreement can only come after it, so the seven-day bench stays reachable
      // a bench halved away by green runs starts a new chain
      const chained =
        state.until !== null && state.benchMs > 0 && event.at.getTime() - state.until.getTime() <= WINDOW_MS
      const benchMs = chained ? Math.min(MAX_BENCH_MS, state.benchMs * 2) : FIRST_BENCH_MS
      state = {
        benchMs,
        lastDisagreementAt: event.at,
        until: new Date(event.at.getTime() + benchMs),
        disagreements: chained ? state.disagreements + 1 : 1,
        eased: false,
      }
    } else if (state.until !== null && !state.eased && event.at.getTime() >= state.until.getTime()) {
      // a green run after the bench took the place back: the next bench starts from half
      const half = state.benchMs / 2
      state = { ...state, benchMs: half < FIRST_BENCH_MS ? 0 : half, eased: true }
    }
  }
  return state
}

/** The bench now, or null when the step may go off the mini. */
export function activeBench(state: BenchState, now: Date): { until: Date; benchMs: number } | null {
  if (state.until === null || state.lastDisagreementAt === null || state.until.getTime() <= now.getTime()) return null
  return { until: state.until, benchMs: state.until.getTime() - state.lastDisagreementAt.getTime() }
}

/** A duration as the wait line says it: "1 h", "2 h", "3 d". */
export function benchWords(ms: number): string {
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) return `${ms / 86_400_000} d`
  const hours = Math.round((ms / 3_600_000) * 10) / 10
  return hours >= 1 ? `${hours} h` : `${Math.round(ms / 60_000)} min`
}
