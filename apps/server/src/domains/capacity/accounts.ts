/**
 * An account takes new leads until a window is reached: below 100 % of its 5-hour window and of its week by default. A
 * lead that runs into the wall continues when the window resets (`wall` stall), so a reserve only leaves usage unused.
 * `FACTORY_FIVE_HOUR_LIMIT` and `FACTORY_WEEKLY_LIMIT` set a lower limit.
 */
export const DEFAULT_WINDOW_LIMIT = 100

/** The limits an account's windows close it at, in percent of the window. */
export interface WindowLimits {
  fiveHour: number
  weekly: number
}

export const DEFAULT_LIMITS: WindowLimits = { fiveHour: DEFAULT_WINDOW_LIMIT, weekly: DEFAULT_WINDOW_LIMIT }

/** A 5-hour window above this share of its use paces an account: one new lead per quota sample. Below it, and with no 5-hour window, a lead takes a seat at once. */
const SAMPLE_PACE_ABOVE = 70

export const WEEK_MS = 7 * 24 * 3_600_000

/**
 * A reading the poll has not renewed for this long says nothing about the account now: a stopped poll, or an account
 * that left the registry, must not keep admitting on old numbers.
 */
export const READING_MAX_AGE_MS = 10 * 60_000

/** The poll runs at most this often; a pass reads again when the newest reading is older. */
export const POLL_EVERY_MS = 60_000

/** One account as one poll saw it. Percentages are of the window; null is "no sample". */
export interface AccountReading {
  account: string
  /** when the poll took it */
  readAt: Date
  /** when the picker sampled the account (the poll's time minus the sample's age) */
  sampledAt: Date | null
  enabled: boolean
  authOk: boolean
  fiveHourUsed: number | null
  weeklyUsed: number | null
  fiveHourResetsAt: Date | null
  weeklyResetsAt: Date | null
  exhaustedUntil: Date | null
}

/**
 * Whether an account takes at most one new lead per quota sample: only one with a 5-hour window, and only once that
 * window is above `SAMPLE_PACE_ABOVE`. An account with only a weekly limit has no window to overshoot in minutes.
 */
const pacedBySample = (reading: AccountReading): boolean =>
  reading.fiveHourUsed !== null && reading.fiveHourUsed > SAMPLE_PACE_ABOVE

export const isFresh = (reading: AccountReading, now: Date): boolean =>
  now.getTime() - reading.readAt.getTime() <= READING_MAX_AGE_MS

/** The lane whose order of accounts the factory takes from the picker's rank. */
export const RANK_LANE = 'bulk'

export interface RankedAccount {
  account: string
  reason: string
  weight: number | null
}

/** The picker's order of the accounts that may take work in a lane, best first. Ineligible accounts are absent. */
export interface AccountRank {
  lane: string
  order: RankedAccount[]
  /** when the picker computed it */
  at: Date
  /** when the poll read it */
  readAt: Date
}

export const rankIsFresh = (rank: AccountRank, now: Date): boolean =>
  now.getTime() - rank.readAt.getTime() <= READING_MAX_AGE_MS

/** Where an account stands: open now, or closed until a time, or closed with no time anyone can name. */
export type Standing = { open: true } | { open: false; until: Date | null; why: string }

/** The share of its week an account's window has elapsed, in percent. Null when the window's end is unknown or past. */
function elapsedWeekShare(reading: AccountReading, now: Date): number | null {
  if (!reading.weeklyResetsAt || reading.weeklyResetsAt <= now) return null
  const start = reading.weeklyResetsAt.getTime() - WEEK_MS
  return Math.min(100, Math.max(0, ((now.getTime() - start) / WEEK_MS) * 100))
}

/**
 * How much of its tightest window an account has left, in percentage points of its limit; windows with no number do not
 * count; an account with none (which `standing` closes first, so it never reaches the pick) has 0. A point of the 5-hour window weighs as much as a point of the week: the
 * smaller room decides, so an account is never the roomiest by a window that is not its tightest.
 */
export function roomLeft(reading: AccountReading, limits: WindowLimits = DEFAULT_LIMITS): number {
  const rooms = [
    reading.fiveHourUsed === null ? null : limits.fiveHour - reading.fiveHourUsed,
    reading.weeklyUsed === null ? null : limits.weekly - reading.weeklyUsed,
  ].filter((room): room is number => room !== null)
  return rooms.length === 0 ? 0 : Math.min(...rooms)
}

/** A wall the reading does not show yet is believed only when a window is this close to its limit: a rate limit at 10 % use is a throttle, not a window. */
const NEAR_LIMIT_POINTS = 10

/**
 * The reset of the window nearest its limit (a 5-hour window wins a tie: it opens sooner), when that window is within
 * `NEAR_LIMIT_POINTS` of its limit and the reset is ahead; null otherwise. For a lead that ran into a wall the reading
 * has not caught up with: it waits for that reset.
 */
export function tightestReset(reading: AccountReading, now: Date, limits: WindowLimits = DEFAULT_LIMITS): Date | null {
  const fiveHourLeft = reading.fiveHourUsed === null ? null : limits.fiveHour - reading.fiveHourUsed
  const weeklyLeft = reading.weeklyUsed === null ? null : limits.weekly - reading.weeklyUsed
  const left = Math.min(fiveHourLeft ?? Number.POSITIVE_INFINITY, weeklyLeft ?? Number.POSITIVE_INFINITY)
  if (left > NEAR_LIMIT_POINTS) return null
  const weekly = weeklyLeft !== null && (fiveHourLeft === null || weeklyLeft < fiveHourLeft)
  const at = weekly ? reading.weeklyResetsAt : reading.fiveHourResetsAt
  return at && at > now ? at : null
}

/**
 * Whether an account can take a new lead on this reading alone: enabled, auth fine, a sample (a window without a number
 * counts as unused, both without is no sample), not marked exhausted, below both limits. With `options.pace`, also at or below
 * the elapsed share of its week. A closed account says when it opens if the reading says so: the reset of the window
 * that closed it (both: the later), or for pace the moment the week's elapsed share reaches its use.
 */
export function standing(
  reading: AccountReading,
  now: Date,
  options: { pace?: boolean; limits?: WindowLimits } = {},
): Standing {
  const pace = options.pace ?? false
  const limits = options.limits ?? DEFAULT_LIMITS
  if (!reading.enabled) return { open: false, until: null, why: 'disabled' }
  if (!reading.authOk) return { open: false, until: null, why: 'not signed in' }
  if (!reading.sampledAt || (reading.fiveHourUsed === null && reading.weeklyUsed === null)) {
    return { open: false, until: null, why: 'no usage sample' }
  }
  const fiveHour = reading.fiveHourUsed ?? 0
  const weekly = reading.weeklyUsed ?? 0
  const reopens: (Date | null)[] = []
  const whys: string[] = []
  const ahead = (at: Date | null) => (at && at > now ? at : null)
  if (reading.exhaustedUntil && reading.exhaustedUntil > now) {
    reopens.push(reading.exhaustedUntil)
    whys.push('exhausted')
  }
  if (fiveHour >= limits.fiveHour) {
    reopens.push(ahead(reading.fiveHourResetsAt))
    whys.push(`5-hour window at ${fiveHour}% (limit ${limits.fiveHour}%)`)
  }
  if (weekly >= limits.weekly) {
    reopens.push(ahead(reading.weeklyResetsAt))
    whys.push(`week at ${weekly}% (limit ${limits.weekly}%)`)
  }
  if (pace) {
    const share = elapsedWeekShare(reading, now)
    if (share === null) {
      reopens.push(null)
      whys.push('no week to pace against')
    } else if (weekly > share && reading.weeklyResetsAt) {
      reopens.push(new Date(reading.weeklyResetsAt.getTime() - WEEK_MS + (weekly / 100) * WEEK_MS))
      whys.push(`week at ${weekly}% is ahead of its pace (${Math.round(share)}%)`)
    }
  }
  if (reopens.length === 0) return { open: true }
  const why = whys.join(', ')
  if (reopens.includes(null)) return { open: false, until: null, why }
  return { open: false, until: new Date(Math.max(...reopens.map((d) => d?.getTime() ?? 0))), why }
}

export interface PickInput {
  readings: readonly AccountReading[]
  /** leads started on an account after its latest sample: the sample does not show them yet */
  loaded: ReadonlySet<string>
  /** leads that hold a claim on each account now */
  leads: ReadonlyMap<string, number>
  /** most leads an account carries at once when `accountCaps` does not name it */
  leadsPerAccount: number
  /** an account's own cap (the raise of an idle host already in it); an account not named takes `leadsPerAccount` */
  accountCaps?: ReadonlyMap<string, number>
  now: Date
  pace?: boolean
  /** the windows' limits; absent: 100 % */
  limits?: WindowLimits
  /** the picker's order, which decides when fresh; a missing or stale rank leaves the order to the most room, then the lowest weekly use */
  rank?: AccountRank | null
}

export type Pick = { picked: AccountReading } | { picked: null; why: string; opensAt: Date | null; capped: boolean }

/**
 * The open account first in the picker's fresh rank, among the fresh readings and below its lead cap: the rank carries
 * reset timing, Fable and drain mode and the weekly pace, so it decides, and `roomLeft` then the lowest weekly use only
 * break a tie and order the accounts the rank does not list, which go after every ranked one. An account the rank lists
 * is not closed by the factory's own pace rule (the picker applied pace already; a drain account runs ahead of it on
 * purpose); the window limits stay. With no rank or a stale one the open account with the most room left in its
 * tightest window (`roomLeft`) is taken, then the lowest weekly use: a nearly full account so gets a lead only when the
 * roomier ones are at their caps, and every account is used up to its limit. An account with a
 * 5-hour window above `SAMPLE_PACE_ABOVE` takes one new lead per sample: while a lead started after the latest sample is
 * not in it yet, it is not offered again; any other account takes leads up to its cap in one pass.
 * Never spills: with nothing open the answer names why and, when a reading says so, when the first account opens.
 */
export function pickAccount(input: PickInput): Pick {
  const { readings, now } = input
  const fresh = readings.filter((r) => isFresh(r, now))
  if (fresh.length === 0) {
    return { picked: null, why: 'no fresh usage reading of any account', opensAt: null, capped: false }
  }
  const limits = input.limits ?? DEFAULT_LIMITS
  const order = input.rank && rankIsFresh(input.rank, now) ? input.rank.order.map((r) => r.account) : null
  const standings = fresh.map((reading) => ({
    reading,
    standing: standing(reading, now, { pace: (input.pace ?? false) && !order?.includes(reading.account), limits }),
  }))
  const open = standings.filter((s) => s.standing.open).map((s) => s.reading)
  const free = open.filter((r) => !(input.loaded.has(r.account) && pacedBySample(r)))
  const capOf = (account: string) => input.accountCaps?.get(account) ?? input.leadsPerAccount
  const heldBy = (account: string) => input.leads.get(account) ?? 0
  const withRoom = free.filter((r) => heldBy(r.account) < capOf(r.account))
  const byUse = (a: AccountReading, b: AccountReading) =>
    (a.weeklyUsed ?? 0) - (b.weeklyUsed ?? 0) || a.account.localeCompare(b.account)
  const place = (r: AccountReading): number => {
    const index = order ? order.indexOf(r.account) : -1
    return index < 0 ? Number.MAX_SAFE_INTEGER : index
  }
  const best = withRoom.sort(
    (a, b) => place(a) - place(b) || roomLeft(b, limits) - roomLeft(a, limits) || byUse(a, b),
  )[0]
  if (best) return { picked: best }
  if (free.length > 0) {
    const carried = free.map((r) => `${r.account} ${heldBy(r.account)} of ${capOf(r.account)}`).join(', ')
    return { picked: null, why: `every open account is at its lead cap: ${carried}`, opensAt: null, capped: true }
  }
  if (open.length > 0) {
    return { picked: null, why: 'the open accounts took a lead since their last sample', opensAt: null, capped: false }
  }
  const closed = standings.flatMap((s) => (s.standing.open ? [] : [s.standing]))
  const times = closed.flatMap((s) => (s.until ? [s.until] : [])).sort((a, b) => a.getTime() - b.getTime())
  const why = `every account is closed: ${standings.map((s) => `${s.reading.account} ${s.standing.open ? 'open' : s.standing.why}`).join('; ')}`
  return { picked: null, why, opensAt: times[0] ?? null, capped: false }
}
