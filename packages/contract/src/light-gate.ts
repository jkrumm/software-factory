import {
  TRIPWIRE_DAYS,
  TRIPWIRE_MAX_DAYS,
  TRIPWIRE_MIN_WATCHES,
  TRIPWIRE_POINTS,
  TRIPWIRE_TARGET_WATCHES,
  TRIPWIRE_Z,
} from './roles.ts'

// The light seat's gate for triage's `small`, pure so the read side that measures it and the leads that act on it share one rule.
/** What a seat delivered over the tripwire's window, as far as the gate reads it (null: not measured). */
export interface SeatFigures {
  /** first watches of ships by attempts that finished on the seat, and the share that passed */
  finishedWatches: number
  finishedPassRate: number | null
  /** light only: the Issues moved up, of the Issues the rule seated */
  movedUpShare: number | null
}

/** Dollars per attempt (null: unmeasured), light's, the lead row's, and the lead attempt that followed a move-up. */
export interface AttemptCosts {
  lightAttempt: number | null
  leadAttempt: number | null
  followUpAttempt: number | null
}

/** Median milliseconds (null: unmeasured): a light attempt that finished, one that moved up before it did, and the lead row's Issue. */
export interface AttemptTimes {
  lightFinishMs: number | null
  movedMs: number | null
  leadMs: number | null
}

/** A gap between two seats' rates and the lower bound it clears at `TRIPWIRE_Z`, in the unit of the rates. */
export interface Gap {
  gap: number
  lower: number
}

/** The Wilson score interval of `count` in `n` (a share) at `z`. */
function wilson(count: number, n: number, z: number): { low: number; high: number } {
  const p = count / n
  const denominator = 1 + (z * z) / n
  const centre = p + (z * z) / (2 * n)
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return { low: (centre - half) / denominator, high: (centre + half) / denominator }
}

/** The score interval of a rate of `count` events over `n` Issues at `z`. */
function rateInterval(count: number, n: number, z: number): { low: number; high: number } {
  const centre = count + (z * z) / 2
  const half = z * Math.sqrt(count + (z * z) / 4)
  return { low: Math.max(0, (centre - half) / n), high: (centre + half) / n }
}

/**
 * How far lead's first pass rate is above light's, with the lower bound that gap clears: Newcombe's hybrid score interval
 * (a Wilson interval on each rate, combined by square-and-add). A bound under zero says the gap is not shown at all. Counts
 * come from a rate and its watches; null when either seat has none.
 */
export function passGap(input: { light: SeatFigures; lead: SeatFigures; z?: number }): Gap | null {
  const { light, lead, z = TRIPWIRE_Z } = input
  if (light.finishedPassRate === null || lead.finishedPassRate === null) return null
  if (light.finishedWatches === 0 || lead.finishedWatches === 0) return null
  const lightPassed = Math.round(light.finishedPassRate * light.finishedWatches)
  const leadPassed = Math.round(lead.finishedPassRate * lead.finishedWatches)
  const gap = lead.finishedPassRate - light.finishedPassRate
  const leadLow = wilson(leadPassed, lead.finishedWatches, z).low
  const lightHigh = wilson(lightPassed, light.finishedWatches, z).high
  const lower = gap - Math.sqrt((lead.finishedPassRate - leadLow) ** 2 + (lightHigh - light.finishedPassRate) ** 2)
  return { gap, lower }
}

/** How far light's regressions per Issue are above lead's, with the lower bound of that gap (the same square-and-add). Shown, never a condition. */
export function regressionGap(input: {
  light: { regressions: number; issues: number }
  lead: { regressions: number; issues: number }
  z?: number
}): Gap | null {
  const { light, lead, z = TRIPWIRE_Z } = input
  if (light.issues === 0 || lead.issues === 0) return null
  const lightRate = light.regressions / light.issues
  const leadRate = lead.regressions / lead.issues
  const lightLow = rateInterval(light.regressions, light.issues, z).low
  const leadHigh = rateInterval(lead.regressions, lead.issues, z).high
  const gap = lightRate - leadRate
  return { gap, lower: gap - Math.sqrt((lightRate - lightLow) ** 2 + (leadHigh - leadRate) ** 2) }
}

/**
 * Where the tripwire's window starts: `TRIPWIRE_DAYS` days back, reaching further (to at most `TRIPWIRE_MAX_DAYS`) until
 * light has `TRIPWIRE_TARGET_WATCHES` finished first watches. `watchAts` is when each finished light first watch's Issue
 * started its first lead. With fewer than the target in the longest window, that window.
 */
export function tripwireFrom(input: { now: Date; watchAts: readonly Date[] }): Date {
  const day = 24 * 3_600_000
  const shortest = input.now.getTime() - TRIPWIRE_DAYS * day
  const longest = input.now.getTime() - TRIPWIRE_MAX_DAYS * day
  const newest = input.watchAts.map((at) => at.getTime()).sort((a, b) => b - a)
  const target = newest[TRIPWIRE_TARGET_WATCHES - 1]
  return new Date(target === undefined ? longest : Math.max(longest, Math.min(shortest, target)))
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
 * The same bound in minutes: the move-up share at which a light start takes as long as a start on the lead row. A light
 * attempt that finishes takes `finish` minutes where the lead row's median Issue takes `lead`, so it saves
 * `lead - finish`; one that moves up has spent `moved` minutes before the lead attempt that follows takes the lead row's
 * time anyway. Per Issue the light route takes `(1 - share) * finish + share * (moved + lead)` against `lead`, equal at
 * `share = (lead - finish) / (lead - finish + moved)`. Dollars alone cap the bound at 1 (a share cannot pass it), so a
 * class that moves up every time looked affordable while each move-up cost a seat and a slot for those minutes. 0 when a
 * light attempt that finishes is no faster than the lead row, 1 when a move-up wastes none; null while a time is unmeasured.
 */
export function moveUpTimeBound(times: AttemptTimes): number | null {
  const { lightFinishMs, movedMs, leadMs } = times
  if (lightFinishMs === null || movedMs === null || leadMs === null) return null
  const saved = leadMs - lightFinishMs
  if (saved <= 0) return 0
  return saved / (saved + Math.max(0, movedMs))
}

/**
 * The bound a hygiene class leaves the light seat at: the lower of the dollar bound and the time bound, so a class is out
 * when moving up costs more than the seat saves in either. With no time measured, the dollar bound alone.
 */
export function classMoveUpBound(input: { dollars: number | null; time: number | null }): number | null {
  const { dollars, time } = input
  if (dollars === null) return null
  return time === null ? dollars : Math.min(dollars, time)
}
/**
 * Whether triage's `small` starts light now. Met unless light is shown worse: its first pass rate on what it finished is
 * not shown more than `TRIPWIRE_POINTS` under lead's (the lower bound of the gap, `passGap`, is at or under them: a small
 * count widens the interval and reads as "not shown worse", not as "worse"), and its move-up share is under the bound the
 * cost of a move-up sets. A move-up is the designed safety valve, so it is not read as a failed pass: it is priced in the
 * bound. Regressions are not a condition: a first-watch regression is already in the pass rate and its follow-up attempt in
 * the cost the bound reads. `met` is false when a condition is measured and broken, null when one is not measured (and
 * nothing is broken), and the gate treats null as closed. `failing` names each condition that is broken or unmeasured.
 */
export function judgeLightGate(input: { light: SeatFigures; lead: SeatFigures; bound: number | null }): {
  met: boolean | null
  failing: string[]
  /** lead's pass rate over light's and the lower bound of that gap, in points; null while a rate is unmeasured */
  passGap: { points: number; lower: number } | null
} {
  const { light, lead, bound } = input
  const broken: string[] = []
  const unmeasured: string[] = []
  const gap = passGap({ light, lead })
  if (light.finishedWatches < TRIPWIRE_MIN_WATCHES) {
    unmeasured.push(`light has ${light.finishedWatches} of ${TRIPWIRE_MIN_WATCHES} finished first watches`)
  } else if (gap === null) {
    unmeasured.push('a first pass rate is not measured')
  } else if (gap.lower * 100 > TRIPWIRE_POINTS) {
    broken.push(
      `light's pass rate on what it finished is shown more than ${TRIPWIRE_POINTS} points under lead's (at least ${(gap.lower * 100).toFixed(1)})`,
    )
  }
  if (light.movedUpShare === null || bound === null) {
    unmeasured.push('the move-up share or its cost bound is not measured')
  } else if (light.movedUpShare >= bound) {
    broken.push('light moves up more often than the cost of a move-up allows')
  }
  return {
    met: broken.length > 0 ? false : unmeasured.length > 0 ? null : true,
    failing: [...broken, ...unmeasured],
    passGap: gap && { points: gap.gap * 100, lower: gap.lower * 100 },
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
 * when that share is above the bound the cost of a move-up sets in dollars and in minutes (`classMoveUpBound`), and comes back when it is at or under it: Issues of a class that is out start on the lead row,
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
