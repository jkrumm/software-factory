import { TRIPWIRE_MIN_WATCHES, TRIPWIRE_POINTS } from './roles.ts'

// The light seat's gate for triage's `small`, pure so the read side that measures it and the leads that act on it share one rule.
/** What a seat delivered over the tripwire's window, as far as the gate reads it (null: not measured). */
export interface SeatFigures {
  /** first watches of ships by attempts that finished on the seat, and the share that passed */
  finishedWatches: number
  finishedPassRate: number | null
  regressionsPerIssue: number | null
  /** light only: the Issues moved up, of the Issues the rule seated */
  movedUpShare: number | null
}

/** Dollars per attempt (null: unmeasured), light's, the lead row's, and the lead attempt that followed a move-up. */
export interface AttemptCosts {
  lightAttempt: number | null
  leadAttempt: number | null
  followUpAttempt: number | null
}

/**
 * The move-up share at which starting light costs as much as starting on the lead row. Every Issue seated light runs a
 * light attempt, and the moved-up share then runs a lead attempt too: `light + share * followUp` against `lead`, equal at
 * `share = (lead - light) / followUp`. At light 0.15, lead 2.70 and a follow-up of 2.70 that is 94 %: past it the light
 * route costs more than the lead's own, below it the seat saves. Null while a cost is unmeasured, 0 when light costs more
 * than the lead row per attempt.
 */
export function moveUpBound(costs: AttemptCosts): number | null {
  const { lightAttempt, leadAttempt, followUpAttempt } = costs
  if (lightAttempt === null || leadAttempt === null || followUpAttempt === null || followUpAttempt <= 0) return null
  return Math.min(1, Math.max(0, (leadAttempt - lightAttempt) / followUpAttempt))
}

/**
 * Whether triage's `small` starts light now. Met when, over the window, light's pass rate on what it finished is within
 * `TRIPWIRE_POINTS` of lead's, its regressions per Issue are not higher than lead's and its move-up share is under the
 * bound the cost of a move-up sets. A move-up is the designed safety valve, so it is not read as a failed pass: it is
 * priced in the bound. `met` is false when a condition is measured and broken, null when one is not measured (and
 * nothing is broken), and the gate treats null as closed. `failing` names each condition that is broken or unmeasured.
 */
export function judgeLightGate(input: { light: SeatFigures; lead: SeatFigures; bound: number | null }): {
  met: boolean | null
  failing: string[]
} {
  const { light, lead, bound } = input
  const broken: string[] = []
  const unmeasured: string[] = []
  if (light.finishedWatches < TRIPWIRE_MIN_WATCHES) {
    unmeasured.push(`light has ${light.finishedWatches} of ${TRIPWIRE_MIN_WATCHES} finished first watches`)
  } else if (light.finishedPassRate === null || lead.finishedPassRate === null) {
    unmeasured.push('a first pass rate is not measured')
  } else if ((lead.finishedPassRate - light.finishedPassRate) * 100 > TRIPWIRE_POINTS) {
    broken.push(`light's pass rate on what it finished is more than ${TRIPWIRE_POINTS} points under lead's`)
  }
  if (light.regressionsPerIssue === null || lead.regressionsPerIssue === null) {
    unmeasured.push('regressions per Issue are not measured')
  } else if (light.regressionsPerIssue > lead.regressionsPerIssue) {
    broken.push('light regresses more per Issue than lead')
  }
  if (light.movedUpShare === null || bound === null) {
    unmeasured.push('the move-up share or its cost bound is not measured')
  } else if (light.movedUpShare >= bound) {
    broken.push('light moves up more often than the cost of a move-up allows')
  }
  return {
    met: broken.length > 0 ? false : unmeasured.length > 0 ? null : true,
    failing: [...broken, ...unmeasured],
  }
}

/** A hygiene class is judged over its newest Issues whose first lead started: this many. */
export const CLASS_SEAT_WINDOW = 20
/** Fewer light starts in the window than this prove nothing: an unmeasured class stays on the light seat. */
export const CLASS_SEAT_MIN_STARTS = 3

/** One Issue of a hygiene class whose first lead started: on which seat, and whether it was moved up. */
export interface ClassStart {
  light: boolean
  movedUp: boolean
}

export interface ClassSeatVerdict {
  /** light starts in the window, and how many of them moved up */
  starts: number
  movedUp: number
  /** moved up / starts; null under `CLASS_SEAT_MIN_STARTS` starts */
  share: number | null
  /** true: the class's next Issue starts on the standard lead */
  out: boolean
  why: string | null
}

const percent = (share: number): string => `${Math.round(share * 100)} %`

/**
 * Where a hygiene class starts. `starts` are the class's Issues whose first lead started, newest first: the window is the
 * first `CLASS_SEAT_WINDOW` of them, and the move-up share is the move-ups among the light starts in it. A class is out
 * when that share is above the bound the cost of a move-up sets (`moveUpBound`), the same bound that closes the tripwire
 * for triage's `small`, and comes back when it is at or under it: Issues of a class that is out start on the lead row,
 * so they age its light starts out of the window until the share no longer stands on `CLASS_SEAT_MIN_STARTS`. With no
 * bound measured nothing is out.
 */
export function judgeClassSeat(starts: readonly ClassStart[], bound: number | null): ClassSeatVerdict {
  const light = starts.slice(0, CLASS_SEAT_WINDOW).filter((start) => start.light)
  const movedUp = light.filter((start) => start.movedUp).length
  const share = light.length < CLASS_SEAT_MIN_STARTS ? null : movedUp / light.length
  if (share === null || bound === null || share <= bound)
    return { starts: light.length, movedUp, share, out: false, why: null }
  return {
    starts: light.length,
    movedUp,
    share,
    out: true,
    why: `${movedUp} of its last ${light.length} light starts moved up (${percent(share)}), above the bound ${percent(bound)}`,
  }
}
