// The picker's rule (docs/accounts.md §The picker, rule v1.9) as pure functions over a snapshot of the registry, the
// quota samples, the marks and the clock. No file, process, network or clock access lives here: the adapters sit behind
// the ports in ports.ts and the files in registry.ts and store.ts, so a test (or a simulation) hands in the snapshot.

/** Account whose config dir is the default ~/.claude (CLAUDE_CONFIG_DIR unset). */
export const DEFAULT_ACCOUNT_ID = 'iu'
/** pick() result when no account is usable: the caller spills to its IU path (not an account id). */
export const SPILL = 'spill'
export const SESSION_MAX = 90
/** 5h% from which an account only takes work when nothing cooler is eligible (SESSION_MAX stays the hard stop). */
export const SESSION_SOFT_MAX = 80
/** Home 5h% from which the session move ignores the other's weekly pace: a filling 5h window is a wall, over-pace weekly only a preference. */
export const SESSION_PRESSURE = 60
export const WEEKLY_MAX = 95
/** Weekly ceiling while the window resets within EXPIRING_S: the last points are use-it-or-lose-it, so squeeze them. */
export const WEEKLY_MAX_EXPIRING = 98
/** Weekly ceiling in the last FINAL_S before the reset: nothing left to protect, so the window is run to the wall. */
export const WEEKLY_MAX_FINAL = 100
export const FINAL_S = 3 * 3600
export const FRESH_MS = 10 * 60_000
export const STALE_OK_MS = 6 * 3600_000
/** a dead login is re-probed (in the background) at most this often */
export const AUTH_RETRY_MS = 30 * 60_000
export const REFRESH_MIN_MS = 5 * 60_000
/** Horizon of the expiring-capacity step (earliest reset first): v1.9 widened it from 24 h after the simulation (scripts/claude-account-sim.test.ts). */
export const EXPIRING_S = 72 * 3600
/** The 98 % weekly ceiling applies this close to the reset. */
export const CEILING_EXPIRING_S = 24 * 3600
/** Weekly% may run this many points ahead of the elapsed share of the 7-day window before an account counts as over pace. */
export const PACE_MARGIN = 15
/** Session% points the home account may run ahead of the other before a spawn moves to the emptier 5h window. */
export const SESSION_MARGIN = 20
const WEEK_S = 7 * 24 * 3600
/** How much more a sooner reset weighs than a later one when sharing work (1 = pure spare-per-hour, higher = harder front-loading of the expiring account). */
export const URGENCY_EXP = 1.5

export interface Account {
  dir: string | null
  plan: string
  /** Capacity units; optional, defaults from the plan (see accountUnits). */
  units?: { session: number; weekly: number }
  homeLanes: string[]
  /** macOS app (as `open -a` names it) signed in to this account; where `claude-relogin` opens the authorize URL. Absent = system default. */
  loginBrowser?: string
  enabled: boolean
}
export interface Registry {
  accounts: Record<string, Account>
  /**
   * Fable mode: the account `cf` launches on. Every other pick treats it as the last resort (used only when no
   * other account is eligible), so its weekly room stays for Fable. Absent or null = off (`cf` on the default account).
   */
  fable?: string | null
  /**
   * Drain mode: accounts filled first, in every lane, up to a weekly ceiling of 100 (the owner wants them at the wall,
   * e.g. ahead of a reset he triggers himself). A drain account with a hot 5h window (SESSION_SOFT_MAX) falls back to
   * the plain rule. Absent or empty = off. Never the Fable account.
   */
  drain?: string[] | null
}

/**
 * One account's quota sample. Percent 0-100, resets epoch seconds. Each window carries its own timestamp (epoch ms):
 * s/s_reset belong to the 5h window (s_ts), w/w_reset to the weekly one (w_ts), so a carried-over window is never
 * judged fresher than it is.
 */
export interface Sample {
  s: number | null
  w: number | null
  s_reset: number | null
  w_reset: number | null
  s_ts: number | null
  w_ts: number | null
  src: string
}
/** In-memory view assembled from the per-account files under cacheDir(). */
export interface Cache {
  samples: Record<string, Sample>
  /** Exhausted marks: account id -> epoch seconds until which it is out. */
  exhausted: Record<string, number>
  /** Accounts whose last refresh found no usable login. */
  auth_failed: Record<string, boolean>
  /** epoch ms of the last auth failure per id (the retry cooldown starts there) */
  auth_failed_at: Record<string, number>
}
/** `stale`: the picked account was chosen on a sample older than FRESH_MS (reason keeps the routing rule). */
export interface PickResult {
  picked: string
  reason: string
  stale: boolean
}

export const emptyCache = (): Cache => ({ samples: {}, exhausted: {}, auth_failed: {}, auth_failed_at: {} })

export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
export const numOrNull = (v: unknown) => v === null || isNum(v)

/** An account id: letters, digits, `_` and `-` (it names cache files). */
export const ID = /^[A-Za-z0-9_-]+$/

/**
 * Canonical plan tier. Anthropic sells Max (5 h session + weekly limit) and Ultra (weekly limit only). The registry
 * used to name the Max multiples (`max5x`, `max20x`); those keep their meaning, a Max with a session window, and read
 * as `max`. Only an explicit `ultra` drops the session dimension. Anything else passes through lowercased.
 */
export function planTier(plan: string): string {
  const p = plan.trim().toLowerCase()
  return /^max\s*\d+x$/.test(p) ? 'max' : p
}

/** False for a plan without a 5 h session limit (Ultra): its session window is never judged, shown or kept. */
export const hasSessionLimit = (a: Account): boolean => planTier(a.plan) !== 'ultra'

/** Capacity units of an account: the registry's own, else from the plan (ultra 4 / 2, max 1 / 1; legacy maxNx: session N/5, weekly 1 + (N/5 - 1)/3, so max20x is 4 / 2; measured ratios, docs/claude-accounts.md). */
export const accountUnits = (a: Account): { session: number; weekly: number } => {
  if (a.units) return a.units
  // legacy maxNx: the 5h window scales with N/5; the weekly one grows slower (20x measured at 2x a 5x), interpolated linearly between
  const n = /^max\s*(\d+)x$/.exec(a.plan.trim().toLowerCase())?.[1]
  if (n) {
    const k = Math.max(1, Number(n) / 5)
    return { session: k, weekly: 1 + (k - 1) / 3 }
  }
  return planTier(a.plan) === 'ultra' ? { session: 4, weekly: 2 } : { session: 1, weekly: 1 }
}

export const defaultAccountId = (reg: Registry) =>
  Object.entries(reg.accounts).find(([, a]) => a.dir === null)?.[0] ?? DEFAULT_ACCOUNT_ID

export function isSample(v: unknown): v is Sample {
  const x = v as Sample | null
  return (
    !!x &&
    typeof x === 'object' &&
    numOrNull(x.s) &&
    numOrNull(x.w) &&
    numOrNull(x.s_reset) &&
    numOrNull(x.w_reset) &&
    numOrNull(x.s_ts) &&
    numOrNull(x.w_ts) &&
    typeof x.src === 'string'
  )
}

const hasS = (x: Sample) => x.s !== null
const hasW = (x: Sample) => x.w !== null

/**
 * Field-wise merge, per window: an incoming window that is absent (null) keeps what we know; a present one wins
 * unless the stored one has a newer timestamp. Exception: a full endpoint answer (`src: "oauth"`) that carries a
 * weekly window but no 5 h one means the account has no session window now (Ultra, or an idle Max), so the stored
 * session value is dropped instead of living on frozen, unless that session reading is newer than the answer (a delayed reply).
 */
export function mergeSample(prev: Sample | null, inc: Sample): Sample {
  if (!prev) return inc
  const takeS = hasS(inc) && !(hasS(prev) && (prev.s_ts ?? 0) > (inc.s_ts ?? 0))
  const takeW = hasW(inc) && !(hasW(prev) && (prev.w_ts ?? 0) > (inc.w_ts ?? 0))
  const dropS = inc.src === 'oauth' && !hasS(inc) && hasW(inc) && (inc.w_ts ?? 0) >= (prev.s_ts ?? 0)
  return {
    s: takeS ? inc.s : dropS ? null : prev.s,
    s_reset: takeS ? inc.s_reset : dropS ? null : prev.s_reset,
    s_ts: takeS ? inc.s_ts : dropS ? null : prev.s_ts,
    w: takeW ? inc.w : prev.w,
    w_reset: takeW ? inc.w_reset : prev.w_reset,
    w_ts: takeW ? inc.w_ts : prev.w_ts,
    src: takeS || takeW ? inc.src : prev.src,
  }
}

export const noSession = (x: Sample): Sample => ({ ...x, s: null, s_reset: null, s_ts: null })

/** The cache as the picker must see it: a plan without a 5 h window carries no session half, whatever an older file or feed left behind. */
export function withoutSessionWindows(reg: Registry, cache: Cache): Cache {
  const stale = Object.entries(cache.samples).filter(
    ([id, x]) => Object.hasOwn(reg.accounts, id) && !hasSessionLimit(reg.accounts[id]) && hasS(x),
  )
  return stale.length
    ? { ...cache, samples: { ...cache.samples, ...Object.fromEntries(stale.map(([id, x]) => [id, noSession(x)])) } }
    : cache
}

/** ISO string or epoch (s or ms) -> epoch seconds. */
export function toEpochS(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v > 1e12 ? v / 1000 : v)
  if (typeof v === 'string' && v) {
    if (/^\d+$/.test(v)) return toEpochS(Number(v))
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : Math.round(t / 1000)
  }
  return null
}

type Window = { utilization?: number; resets_at?: unknown } | null | undefined

/** Parse `cachedUsageUtilization` out of a `.claude.json` blob; a window the payload omits stays null (merge keeps what we know). */
export function sampleFromClaudeJson(json: unknown, src = 'usage'): Sample | null {
  const c = (json as { cachedUsageUtilization?: { fetchedAtMs?: number; utilization?: Record<string, Window> } })
    ?.cachedUsageUtilization
  if (!c || typeof c.fetchedAtMs !== 'number' || !c.utilization) return null
  const pct = (x: Window) => (typeof x?.utilization === 'number' ? x.utilization : null)
  const f = c.utilization.five_hour
  const d = c.utilization.seven_day
  const s = pct(f)
  const w = pct(d)
  if (s === null && w === null) return null
  return {
    s,
    s_reset: s === null ? null : toEpochS(f?.resets_at),
    s_ts: s === null ? null : c.fetchedAtMs,
    w,
    w_reset: w === null ? null : toEpochS(d?.resets_at),
    w_ts: w === null ? null : c.fetchedAtMs,
    src,
  }
}

/** WARN at or below this many ms of refresh-token life left. */
export const LOGIN_WARN_MS = 7 * 86400_000
/** FAIL at or below this many ms left (or when already past). */
export const LOGIN_FAIL_MS = 2 * 86400_000

export type LoginGrade = 'PASS' | 'WARN' | 'FAIL'

/** PASS > 7 d, WARN <= 7 d, FAIL <= 2 d or past; no timestamp (unreadable item) is a WARN, never a FAIL. */
export function gradeLogin(refreshTokenExpiresAt: number | null, nowMs: number): LoginGrade {
  if (refreshTokenExpiresAt === null) return 'WARN'
  const left = refreshTokenExpiresAt - nowMs
  return left <= LOGIN_FAIL_MS ? 'FAIL' : left <= LOGIN_WARN_MS ? 'WARN' : 'PASS'
}

export interface LoginRow {
  id: string
  /** the account owns the default ~/.claude (CLAUDE_CONFIG_DIR unset) */
  default: boolean
  /** what the login's remaining life says */
  grade: LoginGrade
  /**
   * What the graders (verify rows, heartbeat) act on: the grade, except that a non-default account never reaches FAIL
   * (the picker routes around a dead one, as auth/<id> already treats it). The default account keeps its grade.
   */
  severity: LoginGrade
  /** epoch ms of the refresh token's end of life; null when the item could not be read */
  refresh_expires_at: number | null
  access_expires_at: number | null
  /** the Keychain item's raw rateLimitTier, null when absent or unreadable */
  tier: string | null
  /** plan parsed from the tier (`ultra` / `max`), null when undetectable */
  plan_detected: string | null
  days_left: number | null
  expired: boolean
  detail: string
}

export interface ReloginCandidate {
  id: string
  reason: string
}

/**
 * Accounts that need a human: a refresh that ended `auth-failed`, or a login whose known end of life crossed the WARN
 * line (<= 7 d, incl. already expired). An unreadable item (no date) never asks: that proves nothing about the login.
 */
export function reloginCandidates(results: Record<string, RefreshResult>, logins: LoginRow[]): ReloginCandidate[] {
  const out: ReloginCandidate[] = []
  for (const [id, r] of Object.entries(results)) if (r === 'auth-failed') out.push({ id, reason: 'login is dead' })
  for (const l of logins) {
    if (l.grade === 'PASS' || l.refresh_expires_at === null || out.some((c) => c.id === l.id)) continue
    out.push({ id: l.id, reason: l.expired ? 'login expired' : `login ends in ${l.days_left} d` })
  }
  return out
}

/**
 * Refresh of already-claimed accounts. The login verdict is decoupled from samples: the OAuth usage endpoint gives
 * a sample (which also proves the login); without one, `claude auth status` decides. Each result touches only that
 * account's own files. A binary that could not start gives the claim back (it was not an attempt); a timeout or an
 * unparsable answer keeps it and leaves the auth mark alone.
 * Outcome per account: `fresh` (sample fetched this run), `auth-ok` / `auth-failed` (verdict recorded), `stale`
 * (logged in, but the endpoint gave no sample and the stored one is older than STALE_OK_MS: the feed is silently
 * dying, so the keepalive must go red) or `unresolved`.
 */
export type RefreshResult = 'fresh' | 'auth-ok' | 'stale' | 'auth-failed' | 'unresolved' | 'deferred'

/** Age (ms) of each window the sample actually has; a window without a timestamp counts as infinitely old. */
const windowAges = (x: Sample | undefined, nowMs: number): number[] => {
  if (!x) return []
  const age = (ts: number | null) => (ts === null ? Infinity : nowMs - ts)
  return [...(hasS(x) ? [age(x.s_ts)] : []), ...(hasW(x) ? [age(x.w_ts)] : [])]
}
/** Oldest window (the sample is only as fresh as its stalest window); Infinity when there is none. */
export const sampleAge = (x: Sample | undefined, nowMs: number) =>
  windowAges(x, nowMs).length ? Math.max(...windowAges(x, nowMs)) : Infinity
/** Newest window, for display. */
export const newestAge = (x: Sample | undefined, nowMs: number) =>
  windowAges(x, nowMs).length ? Math.min(...windowAges(x, nowMs)) : Infinity
/** True when at least one window is young enough to judge by. */
export const usable = (x: Sample | undefined, nowMs: number) => windowAges(x, nowMs).some((a) => a < STALE_OK_MS)

const matchesLane = (pattern: string, lane: string) =>
  pattern === lane || (pattern.endsWith(':*') && lane.startsWith(pattern.slice(0, -1)))

/** Accounts whose home lanes claim `lane`: exact matches win outright, wildcards only count when nobody matches exactly. */
export function homeIds(reg: Registry, lane: string): string[] {
  const ids = Object.keys(reg.accounts)
  const exact = ids.filter((id) => reg.accounts[id].homeLanes.includes(lane))
  return exact.length ? exact : ids.filter((id) => reg.accounts[id].homeLanes.some((h) => matchesLane(h, lane)))
}

/** The pick rests on a sample with a window older than FRESH_MS. */
export const isStaleOk = (cache: Cache, id: string, nowMs: number) =>
  usable(cache.samples[id], nowMs) && sampleAge(cache.samples[id], nowMs) >= FRESH_MS

/** True for an enabled account the registry names in `drain`. */
export const isDrain = (reg: Registry, id: string): boolean => !!reg.drain?.includes(id) && !!reg.accounts[id]?.enabled

const weeklyMax = (x: Sample, nowMs: number, drain = false) => {
  if (drain) return WEEKLY_MAX_FINAL
  const msLeft = x.w_reset === null ? null : x.w_reset * 1000 - nowMs
  if (msLeft === null || msLeft <= 0) return WEEKLY_MAX
  return msLeft < FINAL_S * 1000
    ? WEEKLY_MAX_FINAL
    : msLeft < CEILING_EXPIRING_S * 1000
      ? WEEKLY_MAX_EXPIRING
      : WEEKLY_MAX
}

/**
 * The account's 5 h percent when it can be judged: the plan has a session limit and the window is younger than
 * STALE_OK_MS. Null otherwise: a plan without a session window (Ultra) is never limited by a leftover sample.
 */
function sessionPct(reg: Registry, cache: Cache, id: string, nowMs: number): number | null {
  const x = cache.samples[id]
  const a = Object.hasOwn(reg.accounts, id) ? reg.accounts[id] : undefined
  return a && hasSessionLimit(a) && x && hasS(x) && nowMs - (x.s_ts ?? 0) < STALE_OK_MS ? x.s : null
}

/** Enabled, logged in, not exhausted, and every window young enough to judge (< 6 h) is below its threshold. Each window is judged by its own timestamp. */
export function eligible(reg: Registry, cache: Cache, id: string, nowMs: number): boolean {
  const a = Object.hasOwn(reg.accounts, id) ? reg.accounts[id] : undefined
  if (!a?.enabled || cache.auth_failed[id]) return false
  const x = cache.samples[id]
  if (!x || !usable(x, nowMs)) return false
  if ((sessionPct(reg, cache, id, nowMs) ?? 0) >= SESSION_MAX) return false
  if (hasW(x) && nowMs - (x.w_ts ?? 0) < STALE_OK_MS && x.w! >= weeklyMax(x, nowMs, isDrain(reg, id))) return false
  const until = cache.exhausted[id]
  if (until && until * 1000 > nowMs) return false
  return true
}

/** Percent of x's 7-day window already elapsed (0..100); null without a weekly reset to measure against. */
export function pace(x: Sample | undefined, nowMs: number): number | null {
  if (!x || !hasW(x) || x.w_reset === null) return null
  return 100 * Math.min(1, Math.max(0, 1 - (x.w_reset * 1000 - nowMs) / (WEEK_S * 1000)))
}

/** Eligible and burning weekly capacity faster than the window elapses (by more than PACE_MARGIN). */
export function overPace(reg: Registry, cache: Cache, id: string, nowMs: number): boolean {
  if (!eligible(reg, cache, id, nowMs)) return false
  const x = cache.samples[id]
  const p = pace(x, nowMs)
  return p !== null && x.w! > p + PACE_MARGIN
}

/**
 * Rule v1.5 (docs/claude-accounts.md §The picker). Among several candidates the highest weight wins (ties follow
 * registry order); with `rng` the candidates share the work in proportion to their weights instead.
 */
export function pick(reg: Registry, cache0: Cache, lane: string, nowMs: number, rng?: () => number): PickResult {
  const cache = withoutSessionWindows(reg, cache0)
  const r = pickRaw(reg, cache, lane, nowMs, rng)
  return { ...r, stale: r.reason !== 'interactive-fallback' && r.picked !== SPILL && isStaleOk(cache, r.picked, nowMs) }
}

/** Weekly capacity left under the account's own ceiling (scaled by its plan) per hour to its own reset, sharpened by URGENCY_EXP. */
export function accountWeight(reg: Registry, cache: Cache, id: string, nowMs: number): number {
  const x = cache.samples[id]
  const hasWeek = !!x && hasW(x)
  // a reset that already passed means the cached % predates the rollover: judge it as a fresh week
  const rolled = hasWeek && x.w_reset !== null && x.w_reset * 1000 <= nowMs
  const spare = hasWeek && !rolled ? weeklyMax(x, nowMs, isDrain(reg, id)) - x.w! : WEEKLY_MAX
  const hoursLeft =
    hasWeek && !rolled && x.w_reset !== null ? Math.max(1, (x.w_reset * 1000 - nowMs) / 3600_000) : WEEK_S / 3600
  return (spare * accountUnits(reg.accounts[id]).weekly) / hoursLeft ** URGENCY_EXP
}

/** The Fable account, held back from every pick; null when Fable mode is off or that account is disabled. */
export function fableReserve(reg: Registry): string | null {
  const id = reg.fable ?? null
  return id !== null && Object.hasOwn(reg.accounts, id) && reg.accounts[id].enabled ? id : null
}

/** The account `cf` launches on: the Fable account, else the default one. */
export const fableAccount = (reg: Registry): string => fableReserve(reg) ?? defaultAccountId(reg)

function pickRaw(
  reg: Registry,
  cache: Cache,
  lane: string,
  nowMs: number,
  rng?: () => number,
): Omit<PickResult, 'stale'> {
  const reserve = fableReserve(reg)
  if (reserve === null) return pickRule(reg, cache, lane, nowMs, rng)
  // Fable mode: the rule runs without the Fable account first; only when that finds nothing does it get the work
  const spared = pickRule(withoutAccount(reg, reserve), cache, lane, nowMs, rng)
  if (spared.picked !== SPILL && spared.reason !== 'interactive-fallback') return spared
  const r = pickRule(reg, cache, lane, nowMs, rng)
  return r.picked === reserve ? { ...r, reason: 'fable-reserve' } : r
}

function pickRule(
  reg: Registry,
  cache: Cache,
  lane: string,
  nowMs: number,
  rng?: () => number,
): Omit<PickResult, 'stale'> {
  const ids = Object.keys(reg.accounts)
  const eligibleIds = ids.filter((id) => eligible(reg, cache, id, nowMs))
  const hot = (id: string) => (sessionPct(reg, cache, id, nowMs) ?? 0) >= SESSION_SOFT_MAX
  // an account near the end of its 5h window is the last choice, not an excluded one
  const cool = eligibleIds.filter((id) => !hot(id))
  const ok = cool.length ? cool : eligibleIds
  const bulk = lane !== 'interactive'

  // Weight = weekly capacity left under the account's own ceiling (scaled by its plan) per hour to its own reset,
  // sharpened by URGENCY_EXP: the account whose window closes soonest with room left is the one whose points would
  // otherwise be lost. Everything is read from the registry and the sample, nothing names an account.
  const weight = (id: string) => accountWeight(reg, cache, id, nowMs)
  const choose = (cands: string[]): string | undefined => {
    if (!rng || cands.length < 2)
      return cands.reduce<string | undefined>(
        (best, id) => (best === undefined || weight(id) > weight(best) ? id : best),
        undefined,
      )
    let r = rng() * cands.reduce((sum, id) => sum + weight(id), 0)
    return cands.find((id) => (r -= weight(id)) < 0) ?? cands[cands.length - 1]
  }
  // drain mode: the owner's chosen accounts go first in every lane while their 5h window is cool
  const draining = cool.filter((id) => isDrain(reg, id))
  if (draining.length) return { picked: choose(draining)!, reason: 'drain' }

  if (bulk) {
    const expiring = ok
      .filter((id) => {
        const x = cache.samples[id]
        const msLeft = x.w_reset === null || !hasW(x) ? null : x.w_reset * 1000 - nowMs
        return msLeft !== null && msLeft > 0 && msLeft < EXPIRING_S * 1000
      })
      .sort((p, q) => cache.samples[p].w_reset! - cache.samples[q].w_reset!)
    if (expiring.length) return { picked: expiring[0], reason: 'expiring-capacity' }
  }
  const homes = homeIds(reg, lane)
  const home = choose(ok.filter((id) => homes.includes(id)))
  if (home && overPace(reg, cache, home, nowMs)) {
    const calm = choose(ok.filter((id) => id !== home && !overPace(reg, cache, id, nowMs)))
    if (calm) return { picked: calm, reason: 'pace' }
  }
  if (home) {
    const hs = sessionPct(reg, cache, home, nowMs)
    const movable = ok.filter((id) => {
      const xs = sessionPct(reg, cache, id, nowMs)
      return (
        id !== home &&
        xs !== null &&
        hs !== null &&
        (hs >= SESSION_PRESSURE || !overPace(reg, cache, id, nowMs)) &&
        hs - xs > SESSION_MARGIN
      )
    })
    // a sibling that shares the lane beats an outsider (iu keeps its room for interactive work)
    const siblings = movable.filter((id) => homes.includes(id))
    const emptier = (siblings.length ? siblings : movable).reduce<string | undefined>((best, id) => {
      if (best === undefined) return id
      const d = sessionPct(reg, cache, id, nowMs)! - sessionPct(reg, cache, best, nowMs)!
      return d < 0 || (d === 0 && weight(id) > weight(best)) ? id : best
    }, undefined)
    if (emptier) return { picked: emptier, reason: 'session' }
    return { picked: home, reason: 'home' }
  }
  // spill: an over-pace account only takes it when every candidate is over pace (v1.7), so a lead or a homeless lane
  // cannot front-load a Max week that the 5h and weekly walls then freeze for days
  const calmOk = ok.filter((id) => !overPace(reg, cache, id, nowMs))
  const other = choose(calmOk.length ? calmOk : ok)
  if (other) return { picked: other, reason: 'spill' }
  if (!bulk) return { picked: defaultAccountId(reg), reason: 'interactive-fallback' }
  return { picked: SPILL, reason: 'no-eligible-account' }
}

/** The registry with one account switched off: how the rule is asked for the next-best choice. */
const withoutAccount = (reg: Registry, id: string): Registry => ({
  ...reg,
  accounts: { ...reg.accounts, [id]: { ...reg.accounts[id], enabled: false } },
})

export interface RankEntry {
  account: string
  reason: string
  weight?: number
}

/** Every eligible account in the order rule v1.6 would hand them out: `pick` (deterministic) iterated, the winner removed each round. */
export function rank({
  reg,
  cache,
  lane,
  nowMs,
}: {
  reg: Registry
  cache: Cache
  lane: string
  nowMs: number
}): RankEntry[] {
  const out: RankEntry[] = []
  const live = withoutSessionWindows(reg, cache)
  let rest = reg
  for (let i = Object.keys(reg.accounts).length; i > 0; i--) {
    const p = pick(rest, cache, lane, nowMs)
    if (p.picked === SPILL || p.reason === 'interactive-fallback') break
    out.push({ account: p.picked, reason: p.reason, weight: accountWeight(reg, live, p.picked, nowMs) })
    rest = withoutAccount(rest, p.picked)
  }
  return out
}

export interface PickLine {
  ts: string
  lane: string
  picked: string
  reason: string
  stale: boolean
  [account: string]: unknown
}

/** One JSONL line per pick; per-account {s,w} keyed by registry id. */
export function pickLine(reg: Registry, cache: Cache, lane: string, p: PickResult, nowMs: number): PickLine {
  const accounts = Object.fromEntries(
    Object.keys(reg.accounts).map((id) => [id, { s: cache.samples[id]?.s ?? null, w: cache.samples[id]?.w ?? null }]),
  )
  return { ts: new Date(nowMs).toISOString(), lane, picked: p.picked, reason: p.reason, stale: p.stale, ...accounts }
}

/** Enabled accounts whose sample is missing or has a window older than 10 min (the budget is checked at claim time). */
export function dueIds(reg: Registry, cache0: Cache, nowMs: number, ignoreAuthMark = false): string[] {
  const cache = withoutSessionWindows(reg, cache0)
  // An auth-failed account is re-probed only after AUTH_RETRY_MS (a dead login must not be hammered every pick);
  // a successful refresh or a statusline record clears the mark. `refresh --ids` bypasses it (manual retry).
  const authBlocked = (id: string) =>
    !ignoreAuthMark && cache.auth_failed[id] && nowMs - (cache.auth_failed_at[id] ?? 0) <= AUTH_RETRY_MS
  return Object.keys(reg.accounts).filter(
    (id) => reg.accounts[id].enabled && !authBlocked(id) && sampleAge(cache.samples[id], nowMs) > FRESH_MS,
  )
}
