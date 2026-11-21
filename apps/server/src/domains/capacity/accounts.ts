/**
 * Whether an account takes new leads, why not, when it opens again and in what order is decided in one place:
 * `packages/accounts` (the picker's rule, `claude-account status`). The server does not keep limits or a weekly pace of its
 * own for accounts: each poll copies the package's verdict for the lane the factory uses (`RANK_LANE`) onto the reading.
 * What only the server knows stays here: the allowance per account, one new lead per quota sample on an account whose 5-hour
 * window is hot (`pacedBySample`), and the age after which a reading admits nothing.
 */

/** A 5-hour window above this share of its use paces an account: one new lead per quota sample. Below it, and with no 5-hour window, a lead takes a seat at once. */
const SAMPLE_PACE_ABOVE = 70

/**
 * A reading the poll has not renewed for this long says nothing about the account now: a stopped poll, or an account
 * that left the registry, must not keep admitting on old numbers.
 */
export const READING_MAX_AGE_MS = 10 * 60_000

/** The poll runs at most this often; a pass reads again when the newest reading is older. */
export const POLL_EVERY_MS = 60_000

/** The lane whose order of accounts the factory takes from the package: the bulk lane, where leads run. */
export const RANK_LANE = 'bulk'

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
  /** the package's verdict for `RANK_LANE`: the account takes work */
  open: boolean
  /** 1-based place in the lane's order, null when closed */
  position: number | null
  /** the rule's reason for the place, null when closed */
  reason: string | null
  /** why it takes no work, in words; null when open */
  closedWhy: string | null
  /** when it takes work again, as far as the sample says; null when open or unknown */
  opensAt: Date | null
  /** the reset of the window nearest its ceiling when it is within a few points of it: what a lead that hit a wall waits for */
  wallResetAt: Date | null
}

/**
 * Whether an account takes at most one new lead per quota sample: only one with a 5-hour window, and only once that
 * window is above `SAMPLE_PACE_ABOVE`. An account with only a weekly limit has no window to overshoot in minutes.
 */
const pacedBySample = (reading: AccountReading): boolean =>
  reading.fiveHourUsed !== null && reading.fiveHourUsed > SAMPLE_PACE_ABOVE

export const isFresh = (reading: AccountReading, now: Date): boolean =>
  now.getTime() - reading.readAt.getTime() <= READING_MAX_AGE_MS

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
}

export type Pick = { picked: AccountReading } | { picked: null; why: string; opensAt: Date | null; capped: boolean }

/**
 * The first open account of the package's order for the lane, among the fresh readings and below its lead cap. An account
 * with a 5-hour window above `SAMPLE_PACE_ABOVE` takes one new lead per sample: while a lead started after the latest sample
 * is not in it yet, it is not offered again; any other account takes leads up to its cap in one pass.
 * Never spills: with nothing open the answer names why and, when a reading says so, when the first account opens.
 */
export function pickAccount(input: PickInput): Pick {
  const { readings, now } = input
  const fresh = readings.filter((r) => isFresh(r, now))
  if (fresh.length === 0) {
    return { picked: null, why: 'no fresh usage reading of any account', opensAt: null, capped: false }
  }
  const open = fresh.filter((r) => r.open)
  const free = open.filter((r) => !(input.loaded.has(r.account) && pacedBySample(r)))
  const capOf = (account: string) => input.accountCaps?.get(account) ?? input.leadsPerAccount
  const heldBy = (account: string) => input.leads.get(account) ?? 0
  const place = (r: AccountReading) => r.position ?? Number.MAX_SAFE_INTEGER
  const best = free
    .filter((r) => heldBy(r.account) < capOf(r.account))
    .sort((a, b) => place(a) - place(b) || a.account.localeCompare(b.account))[0]
  if (best) return { picked: best }
  if (free.length > 0) {
    const carried = free.map((r) => `${r.account} ${heldBy(r.account)} of ${capOf(r.account)}`).join(', ')
    return { picked: null, why: `every open account is at its lead cap: ${carried}`, opensAt: null, capped: true }
  }
  if (open.length > 0) {
    return { picked: null, why: 'the open accounts took a lead since their last sample', opensAt: null, capped: false }
  }
  const times = fresh.flatMap((r) => (r.opensAt ? [r.opensAt] : [])).sort((a, b) => a.getTime() - b.getTime())
  const why = `every account is closed: ${fresh.map((r) => `${r.account} ${r.closedWhy ?? 'closed'}`).join('; ')}`
  return { picked: null, why, opensAt: times[0] ?? null, capped: false }
}

/** The order of the open accounts as the readings carry it, best first: what `factory capacity get` shows as the rank. */
export function orderOf(readings: readonly AccountReading[]): { account: string; reason: string; weight: null }[] {
  return readings
    .filter((r) => r.open && r.position !== null)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((r) => ({ account: r.account, reason: r.reason ?? '', weight: null }))
}
