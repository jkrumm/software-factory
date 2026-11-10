/** An account takes new leads below 85 % of its 5-hour window and below 95 % of its week: the owner's reserve. */
export const FIVE_HOUR_LIMIT = 85
export const WEEKLY_LIMIT = 95

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
export function elapsedWeekShare(reading: AccountReading, now: Date): number | null {
  if (!reading.weeklyResetsAt || reading.weeklyResetsAt <= now) return null
  const start = reading.weeklyResetsAt.getTime() - WEEK_MS
  return Math.min(100, Math.max(0, ((now.getTime() - start) / WEEK_MS) * 100))
}

/**
 * Whether an account can take a new lead on this reading alone: enabled, auth fine, a sample (a window without a number
 * counts as unused, both without is no sample), not marked exhausted, below both limits. With `pace`, also at or below
 * the elapsed share of its week. A closed account says when it opens if the reading says so: the reset of the window
 * that closed it (both: the later), or for pace the moment the week's elapsed share reaches its use.
 */
export function standing(reading: AccountReading, now: Date, pace = false): Standing {
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
  if (fiveHour >= FIVE_HOUR_LIMIT) {
    reopens.push(ahead(reading.fiveHourResetsAt))
    whys.push(`5-hour window at ${fiveHour}% (limit ${FIVE_HOUR_LIMIT}%)`)
  }
  if (weekly >= WEEKLY_LIMIT) {
    reopens.push(ahead(reading.weeklyResetsAt))
    whys.push(`week at ${weekly}% (limit ${WEEKLY_LIMIT}%)`)
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
  /** most leads one account carries at once */
  leadsPerAccount: number
  now: Date
  pace?: boolean
  /** the picker's order; a missing or stale rank leaves the order to the lowest weekly use */
  rank?: AccountRank | null
}

export type Pick = { picked: AccountReading } | { picked: null; why: string; opensAt: Date | null; capped: boolean }

/**
 * The first open account in the picker's fresh rank (accounts it does not list come after, by least weekly use), else
 * the one with the least weekly use, among the fresh readings, below its lead cap. An account takes one new
 * lead per sample: while a lead started after the latest sample is not in it yet, the account is not offered again.
 * Never spills: with nothing open the answer names why and, when a reading says so, when the first account opens.
 */
export function pickAccount(input: PickInput): Pick {
  const { readings, now } = input
  const fresh = readings.filter((r) => isFresh(r, now))
  if (fresh.length === 0) {
    return { picked: null, why: 'no fresh usage reading of any account', opensAt: null, capped: false }
  }
  const standings = fresh.map((reading) => ({ reading, standing: standing(reading, now, input.pace) }))
  const open = standings.filter((s) => s.standing.open).map((s) => s.reading)
  const free = open.filter((r) => !input.loaded.has(r.account))
  const room = free.filter((r) => (input.leads.get(r.account) ?? 0) < input.leadsPerAccount)
  const byUse = (a: AccountReading, b: AccountReading) =>
    (a.weeklyUsed ?? 0) - (b.weeklyUsed ?? 0) || a.account.localeCompare(b.account)
  const order = input.rank && rankIsFresh(input.rank, now) ? input.rank.order.map((r) => r.account) : null
  const place = (r: AccountReading): number => {
    const index = order ? order.indexOf(r.account) : -1
    return index < 0 ? Number.MAX_SAFE_INTEGER : index
  }
  const best = room.sort((a, b) => place(a) - place(b) || byUse(a, b))[0]
  if (best) return { picked: best }
  if (free.length > 0) {
    return {
      picked: null,
      why: `every open account carries ${input.leadsPerAccount} leads already`,
      opensAt: null,
      capped: true,
    }
  }
  if (open.length > 0) {
    return { picked: null, why: 'the open accounts took a lead since their last sample', opensAt: null, capped: false }
  }
  const closed = standings.flatMap((s) => (s.standing.open ? [] : [s.standing]))
  const times = closed.flatMap((s) => (s.until ? [s.until] : [])).sort((a, b) => a.getTime() - b.getTime())
  const why = `every account is closed: ${standings.map((s) => `${s.reading.account} ${s.standing.open ? 'open' : s.standing.why}`).join('; ')}`
  return { picked: null, why, opensAt: times[0] ?? null, capped: false }
}
