/**
 * What GitHub's check conclusions and commit-status states say of the code, in one place: intake's incidents, the Watch,
 * the ship's CI evidence and the self-watch all read a failing check through it, so none can call green what another
 * calls red. Pure.
 */

/** A check run that ended in one of these is red. `cancelled`, `skipped` and `neutral` say nothing of the code. */
export const RED_CONCLUSIONS: ReadonlySet<string> = new Set(['failure', 'timed_out', 'startup_failure'])
/** A commit status in one of these states is red; `pending` (or anything unknown) has not concluded. */
export const RED_STATES: ReadonlySet<string> = new Set(['failure', 'error'])

export type CheckVerdict = 'red' | 'green'

export const isRedConclusion = (conclusion: string | null | undefined): boolean =>
  !!conclusion && RED_CONCLUSIONS.has(conclusion)

/** A finished check run's verdict; undefined when it says nothing of the code. */
export function conclusionVerdict(conclusion: string | null | undefined): CheckVerdict | undefined {
  if (conclusion === 'success') return 'green'
  return isRedConclusion(conclusion) ? 'red' : undefined
}

/** A commit status's verdict; undefined while it is pending (or a state this does not know). */
export function statusVerdict(state: string): CheckVerdict | undefined {
  if (state === 'success') return 'green'
  return RED_STATES.has(state) ? 'red' : undefined
}
