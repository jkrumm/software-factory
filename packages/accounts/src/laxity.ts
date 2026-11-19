// The laxity of an account (docs/accounts.md §The policy lab): the hours to its weekly reset minus the hours it needs to
// fill what is left of its week at the rate it can absorb. Pure: the load model is handed in.
import { type LoadModel, bulkShare, curveAt } from './load-model.ts'

const HOUR_MS = 3600_000

export interface LaxityInput {
  /** weekly percent used now */
  w: number
  /** the weekly reset, epoch ms */
  resetMs: number
  nowMs: number
  /** the account's weekly capacity units */
  weeklyUnits: number
  /** units of weekly capacity one full 5 h window holds (ratio × session units); null for a plan without a 5 h window */
  windowUnits: number | null
  /** the weekly capacity units of every enabled account: the pool the demand is a share of */
  poolUnits: number
  load: LoadModel
}

/**
 * Hours of slack before the account can no longer reach 100 % at its reset; null when its reset is not ahead. The rate it
 * absorbs, hour by hour, is the smaller of what its 5 h window lets through (a full window every 5 h) and the bulk lanes'
 * share of the pool's demand on the measured curve: all the movable work, if it were sent there. Negative slack is the
 * shortfall in hours at the mean rate it could absorb until the reset.
 */
export function laxityHours(i: LaxityInput): number | null {
  const hoursLeft = (i.resetMs - i.nowMs) / HOUR_MS
  if (!(hoursLeft > 0)) return null
  const remainder = Math.max(0, 100 - i.w)
  if (remainder === 0) return hoursLeft
  const cap = i.windowUnits === null ? Number.POSITIVE_INFINITY : i.windowUnits / 5
  const perHour = (i.load.demand * i.poolUnits * bulkShare(i.load)) / 168
  let filled = 0
  for (let h = 0; h < hoursLeft; h++) {
    const dt = Math.min(1, hoursLeft - h)
    const rate = (Math.min(cap, perHour * curveAt(i.load, i.nowMs + h * HOUR_MS)) * 100) / i.weeklyUnits
    if (filled + rate * dt >= remainder) return hoursLeft - (h + (remainder - filled) / rate)
    filled += rate * dt
  }
  const mean = filled / hoursLeft
  return mean > 0 ? -(remainder - filled) / mean : Number.NEGATIVE_INFINITY
}
