// The picker's rule (docs/accounts.md §The picker, rule v1.9) as pure functions over a snapshot of the registry, the
// quota samples, the marks and the clock. No file, process, network or clock access lives here: the adapters sit behind
// the ports in ports.ts and the files in registry.ts and store.ts, so a test (or a simulation) hands in the snapshot.
import { laxityHours } from './laxity.ts'
import { type LoadModel, MEASURED, sessionRatio } from './load-model.ts'

/** Account whose config dir is the default ~/.claude (CLAUDE_CONFIG_DIR unset). */
export const DEFAULT_ACCOUNT_ID = 'iu'
/** pick() result when no account is usable: the caller spills to its IU path (not an account id). */
export const SPILL = 'spill'
/** The rule's name as the ledger and `status` carry it: v1.9 plus the modes of registry v2 (docs/accounts.md §Modes). */
export const RULE_VERSION = 'v1.10'
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

/** What a reserve holds: `account` (last resort for every pick but its model's launcher, v1's Fable mode) or `allowance` (the model's unused weekly allowance only). */
export const HOLDS = ['account', 'allowance'] as const
export type Hold = (typeof HOLDS)[number]

/** The four modes of an account (docs/accounts.md §Modes). */
export const MODE_KINDS = ['normal', 'drain', 'reserve', 'paused'] as const
export type ModeKind = (typeof MODE_KINDS)[number]
/**
 * One account's mode. `for`: the model a reserve holds its allowance for (matched against the endpoint's scoped limit).
 * `until`: an ISO time, `reset` (an override only: until the account's weekly window was observed to reset) or absent.
 */
export interface Mode {
  kind: ModeKind
  for?: string | null
  /** reserve only: what it holds back (reserveHold); absent = the account */
  hold?: Hold | null
  until?: string | null
  why?: string | null
}

export interface Account {
  dir: string | null
  plan: string
  /** Capacity units; optional, defaults from the plan (see accountUnits). */
  units?: { session: number; weekly: number }
  homeLanes: string[]
  /** macOS app (as `open -a` names it) signed in to this account; where `claude-relogin` opens the authorize URL. Absent = system default. */
  loginBrowser?: string
  enabled: boolean
  /** Registry v2: the account's standing mode; a live override replaces it (applyModes). */
  mode?: Mode
}
/** The ssh-reachable peer machine whose quota samples this machine imports and whose health `health` reads. */
export interface HostPeer {
  /** Name in health rows. */
  name: string
  /** ssh arguments naming the peer (host alias, user@host, -p ...); read with BatchMode, 5 s connect. */
  ssh: string[]
  /** The peer's claude-account (default `$HOME/.local/bin/claude-account`), as the peer's shell resolves it. */
  bin?: string
  /** The peer's ssh key runs fixed verbs only (`account-usage`, `account-snapshot`, `account-snapshot-core`) instead of a shell command. */
  fixedVerbs?: boolean
  /** `health` reads the peer through its herdr-core (this machine's, else one ssh hop to the peer's own) before plain ssh. */
  herdrCore?: boolean
}
/** What `health --wake` does on a machine: a command run on the peer over ssh per pending re-login ask ({id}), a local notification command ({message}). */
export interface HostWake {
  push?: string
  notify?: string
}
/** One machine of the host block: the entry whose `match` (a case-insensitive regex over the hostname) fits, else the first without one. */
export interface HostMachine {
  match?: string
  /** This machine's name in audit lines and health rows. */
  name: string
  peer?: HostPeer
  wake?: HostWake
}
/**
 * The registry's optional `host` block: everything the package does beyond one machine with plain logins. No block, no
 * adapter: no peer import, no re-login ask, no setup command. Commands are shell templates; {placeholders} are filled with quoted values.
 */
export interface HostConfig {
  machines?: HostMachine[]
  /** Run detached for a dead or soon-dead login ({id}, {reason}); the human's click lives in the command. */
  reloginAsk?: string
  /** The repair hint a `health` row shows ({id}, {machine}); absent = the plain login command of this machine's own rows. */
  reloginFix?: string
  /** Run once after `add` wrote the entry and created the directory ({id}, {dir}, {plan}); machine setup (rendered settings, MCP registration). */
  afterAdd?: string
}
export interface Registry {
  /** Absent or 1: the v1 file; 2: v1 plus the per-account `mode`. Any other version is refused at load. */
  version?: number
  /** Optional adapters for the machines this registry serves (HostConfig). */
  host?: HostConfig
  accounts: Record<string, Account>
  /** v1 Fable mode: reads as mode reserve for fable on that account (modeOf). Absent or null = off. */
  fable?: string | null
  /** v1 drain mode: reads as mode drain on these accounts (modeOf). Absent or empty = off. Never the fable account. */
  drain?: string[] | null
  /** The live picking policy, a key of POLICIES (docs/accounts.md §The policy lab). Absent = DEFAULT_POLICY. */
  policy?: string
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
  /** The usage endpoint's `limits[]` and `weekly_scoped_shares[]` as it gave them, and when (epoch ms); no other feed carries them. */
  limits?: Record<string, unknown>[]
  scoped_shares?: Record<string, unknown>[]
  limits_ts?: number
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
  /** The latest observed weekly reset per id (`<id>.reset.json`); absent when none was seen. */
  resets?: Record<string, ObservedReset>
}
/** A weekly reset seen in the samples: when (epoch ms) and the weekly reset time after it (epoch s, null when unknown). */
export interface ObservedReset {
  at: number
  w_before: number | null
  w_reset_before: number | null
  w_reset_after: number | null
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
    typeof x.src === 'string' &&
    (x.limits === undefined || isObjectList(x.limits)) &&
    (x.scoped_shares === undefined || isObjectList(x.scoped_shares)) &&
    (x.limits_ts === undefined || isNum(x.limits_ts))
  )
}

const isObjectList = (v: unknown): v is Record<string, unknown>[] =>
  Array.isArray(v) && v.every((e) => !!e && typeof e === 'object' && !Array.isArray(e))

/** The endpoint's limit set of whichever side fetched it later; nothing when neither has one (a v1 sample stays as it was). */
function newerLimits(prev: Sample, inc: Sample): Pick<Sample, 'limits' | 'scoped_shares' | 'limits_ts'> {
  const from = isNum(inc.limits_ts) && !(isNum(prev.limits_ts) && prev.limits_ts > inc.limits_ts) ? inc : prev
  if (!isNum(from.limits_ts)) return {}
  return {
    limits: from.limits ?? [],
    ...(from.scoped_shares ? { scoped_shares: from.scoped_shares } : {}),
    limits_ts: from.limits_ts,
  }
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
    ...newerLimits(prev, inc),
  }
}

/** A weekly window moved forward by more than this (s) between two samples: it reset. */
export const RESET_JUMP_S = 24 * 3600
/** Or its percent fell by at least this many points (a manual reset can keep the old time for a moment). */
export const RESET_DROP = 50

/** True when `next` shows a weekly reset against `prev` (docs/accounts.md §Expiry). */
export function observedReset(prev: Sample | null, next: Sample): boolean {
  if (!prev) return false
  const moved = prev.w_reset !== null && next.w_reset !== null && next.w_reset - prev.w_reset > RESET_JUMP_S
  const fell = prev.w !== null && next.w !== null && prev.w - next.w >= RESET_DROP
  return moved || fell
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

/**
 * The account's mode at `nowMs`: its own `mode` (the registry's, or the live override applyModes put there) unless its
 * ISO `until` has passed, else the v1 keys (`drain` → drain, `fable` → reserve for fable), else normal.
 */
export function modeOf(reg: Registry, id: string, nowMs: number): Mode {
  const a = Object.hasOwn(reg.accounts, id) ? reg.accounts[id] : undefined
  const m = a?.mode
  if (m && !untilPassed(m.until, nowMs)) return m
  if (reg.drain?.includes(id)) return { kind: 'drain' }
  if (reg.fable === id) return { kind: 'reserve', for: 'fable' }
  return { kind: 'normal' }
}

/** An ISO `until` at or before now; `reset` and none never pass here (modes.ts judges `reset`). */
export function untilPassed(until: string | null | undefined, nowMs: number): boolean {
  if (!until || until === 'reset') return false
  const t = Date.parse(until)
  return !Number.isNaN(t) && t <= nowMs
}

/** A reserve's hold; the default, and what the v1 `fable` key means, is the whole account. */
export const reserveHold = (m: Mode): Hold => (m.hold === 'allowance' ? 'allowance' : 'account')

/** True for an enabled account in drain mode. */
export const isDrain = (reg: Registry, id: string, nowMs: number): boolean =>
  !!reg.accounts[id]?.enabled && modeOf(reg, id, nowMs).kind === 'drain'
/** True for an account in paused mode: sampled and checked, never handed work. */
export const isPaused = (reg: Registry, id: string, nowMs: number): boolean => modeOf(reg, id, nowMs).kind === 'paused'

/** A reserve's scoped sample is fetched again once it is older than this (one usage GET; the 5-min claim still binds). */
export const SCOPED_FRESH_MS = 30 * 60_000
/** In the final hours before the weekly reset a reserve's unused allowance is released to other work (spec choice A). */
export const RESERVE_RELEASE_S = 24 * 3600

/** One model's scoped weekly limit in a sample: its percent and its share of the weekly limit. */
export interface Scoped {
  percent: number | null
  used: number
  allowance: number
  ts: number
}

const scopeModel = (scope: unknown): string[] => {
  const m = (scope as { model?: { display_name?: unknown; id?: unknown } } | null)?.model
  return [m?.display_name, m?.id].filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase())
}

/** The `weekly_scoped` limit for `model` (display name or id, any case) with its share; null when the sample has none. */
export function scopedLimit(x: Sample | undefined, model: string): Scoped | null {
  if (!x?.limits || !isNum(x.limits_ts)) return null
  const want = model.toLowerCase()
  const i = x.limits.findIndex((l) => l.kind === 'weekly_scoped' && scopeModel(l.scope).includes(want))
  if (i < 0) return null
  const share = x.scoped_shares?.find((s) => s.limit_index === i)
  if (!share || !isNum(share.used_percent_of_weekly) || !isNum(share.allowance_percent_of_weekly)) return null
  const p = x.limits[i].percent
  return {
    percent: isNum(p) ? p : null,
    used: share.used_percent_of_weekly,
    allowance: share.allowance_percent_of_weekly,
    ts: x.limits_ts,
  }
}

/** A reserve account's budget for other work (docs/accounts.md §Reserve). `known` false: no fresh scoped sample. */
export interface ReserveBudget {
  for: string
  known: boolean
  /** allowance points not used yet (0 once released) */
  unused: number | null
  weekly: number | null
  ceiling: number
  /** takes other work: weekly + unused under the ceiling */
  open: boolean
  released: boolean
}

/** Null for an account that is not a reserve holding its model's allowance (hold: account has no budget: it holds the whole account). */
export function reserveBudget(reg: Registry, cache: Cache, id: string, nowMs: number): ReserveBudget | null {
  const m = modeOf(reg, id, nowMs)
  if (m.kind !== 'reserve' || !m.for || reserveHold(m) !== 'allowance') return null
  const x = cache.samples[id]
  const ceiling = x ? weeklyMax(x, nowMs) : WEEKLY_MAX
  const unknown: ReserveBudget = {
    for: m.for,
    known: false,
    unused: null,
    weekly: null,
    ceiling,
    open: false,
    released: false,
  }
  const sc = scopedLimit(x, m.for)
  if (!x || !sc || nowMs - sc.ts >= STALE_OK_MS) return unknown
  const weekly = hasW(x) && nowMs - (x.w_ts ?? 0) < STALE_OK_MS ? x.w! : weeklyAllPercent(x)
  if (weekly === null) return unknown
  const msLeft = x.w_reset === null ? null : x.w_reset * 1000 - nowMs
  const released = msLeft !== null && msLeft > 0 && msLeft < RESERVE_RELEASE_S * 1000
  const unused = released ? 0 : Math.max(0, sc.allowance - sc.used)
  return { for: m.for, known: true, unused, weekly, ceiling, open: weekly + unused < ceiling, released }
}

const weeklyAllPercent = (x: Sample): number | null => {
  const p = x.limits?.find((l) => l.kind === 'weekly_all')?.percent
  return isNum(p) ? p : null
}

/** A reserve account whose scoped sample is missing or older than SCOPED_FRESH_MS: due for one usage GET. */
export function scopedDue(reg: Registry, cache: Cache, id: string, nowMs: number): boolean {
  if (modeOf(reg, id, nowMs).kind !== 'reserve') return false
  const ts = cache.samples[id]?.limits_ts
  return !isNum(ts) || nowMs - ts > SCOPED_FRESH_MS
}

/** The weekly ceiling (percent) at `nowMs` for a window resetting at `wReset` (epoch s): 95, 98 in the last 24 h, 100 in the last 3 h; 100 for a drain. */
export function weeklyCeiling(wReset: number | null, nowMs: number, drain = false): number {
  if (drain) return WEEKLY_MAX_FINAL
  const msLeft = wReset === null ? null : wReset * 1000 - nowMs
  if (msLeft === null || msLeft <= 0) return WEEKLY_MAX
  return msLeft < FINAL_S * 1000
    ? WEEKLY_MAX_FINAL
    : msLeft < CEILING_EXPIRING_S * 1000
      ? WEEKLY_MAX_EXPIRING
      : WEEKLY_MAX
}

const weeklyMax = (x: Sample, nowMs: number, drain = false): number => weeklyCeiling(x.w_reset, nowMs, drain)

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
  if (!a?.enabled || cache.auth_failed[id] || isPaused(reg, id, nowMs)) return false
  const x = cache.samples[id]
  if (!x || !usable(x, nowMs)) return false
  if ((sessionPct(reg, cache, id, nowMs) ?? 0) >= SESSION_MAX) return false
  if (hasW(x) && nowMs - (x.w_ts ?? 0) < STALE_OK_MS && x.w! >= weeklyMax(x, nowMs, isDrain(reg, id, nowMs)))
    return false
  const until = cache.exhausted[id]
  if (until && until * 1000 > nowMs) return false
  return true
}

/** Why an account takes no work now (docs/accounts.md §status). The codes are `status --json`'s `closed`. */
export const CLOSED_CODES = [
  'disabled',
  'paused',
  'auth',
  'no-sample',
  'session-max',
  'weekly-ceiling',
  'exhausted',
  'reserve-budget',
] as const
export type ClosedCode = (typeof CLOSED_CODES)[number]
export interface Closure {
  closed: ClosedCode
  /** epoch ms when it takes work again, as far as the sample says; null = unknown or only by a person (a login, a mode) */
  opens_at: number | null
}

/**
 * The first reason an account is closed to every lane at `nowMs`, null when it is open. Mirrors `eligible` check by check
 * and adds the reserve budget, so `closure === null` is exactly "`rank` lists it" for the account's own state
 * (test/read-model.test.ts holds the two together).
 */
export function closure(reg: Registry, cache0: Cache, id: string, nowMs: number): Closure | null {
  const cache = withoutSessionWindows(reg, cache0)
  const a = Object.hasOwn(reg.accounts, id) ? reg.accounts[id] : undefined
  if (!a?.enabled) return { closed: 'disabled', opens_at: null }
  if (cache.auth_failed[id]) return { closed: 'auth', opens_at: null }
  if (isPaused(reg, id, nowMs)) {
    const t = modeOf(reg, id, nowMs).until
    const at = t && t !== 'reset' ? Date.parse(t) : Number.NaN
    return { closed: 'paused', opens_at: Number.isNaN(at) ? null : at }
  }
  const x = cache.samples[id]
  if (!x || !usable(x, nowMs)) return { closed: 'no-sample', opens_at: null }
  const sessionPct0 = sessionPct(reg, cache, id, nowMs)
  if ((sessionPct0 ?? 0) >= SESSION_MAX)
    return { closed: 'session-max', opens_at: x.s_reset === null ? null : x.s_reset * 1000 }
  const drain = isDrain(reg, id, nowMs)
  if (hasW(x) && nowMs - (x.w_ts ?? 0) < STALE_OK_MS && x.w! >= weeklyMax(x, nowMs, drain))
    return { closed: 'weekly-ceiling', opens_at: ceilingOpensAt(x, x.w!, nowMs, drain) }
  const until = cache.exhausted[id]
  if (until && until * 1000 > nowMs) return { closed: 'exhausted', opens_at: until * 1000 }
  const b = reserveBudget(reg, cache, id, nowMs)
  if (b?.known && !b.open) return { closed: 'reserve-budget', opens_at: reserveOpensAt(x, b, nowMs) }
  return null
}

/** The next moment the ceiling rises above `w` (98 and 100 come with the last 24 h and 3 h), else the reset itself. */
function ceilingOpensAt(x: Sample, w: number, nowMs: number, drain: boolean): number | null {
  if (x.w_reset === null) return null
  const reset = x.w_reset * 1000
  for (const t of [reset - CEILING_EXPIRING_S * 1000, reset - FINAL_S * 1000]) {
    if (t > nowMs && weeklyCeiling(x.w_reset, t + 1, drain) > w) return t
  }
  return reset > nowMs ? reset : null
}

/** A closed reserve takes work again when its allowance is released (24 h before the reset) if that leaves room, else at the reset. */
function reserveOpensAt(x: Sample, b: ReserveBudget, nowMs: number): number | null {
  if (x.w_reset === null) return null
  const reset = x.w_reset * 1000
  const release = reset - RESERVE_RELEASE_S * 1000
  if (release > nowMs && b.weekly !== null && b.weekly < weeklyCeiling(x.w_reset, release + 1)) return release
  return reset > nowMs ? reset : null
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
 * A picking policy (docs/accounts.md §The policy lab): the rule's steps with the expiring-capacity step varied. `due`
 * adds a step before it in the bulk lanes: the due account (laxity: no more hours to its reset than it needs to fill
 * its week at the rate it can absorb) with the least slack. `expiringS`: the horizon of the earliest-reset-first step,
 * null for none.
 */
export interface PolicyDef {
  about: string
  due: boolean
  expiringS: number | null
  /** the expiring step only takes an account whose 5 h window is below this percent (null: any eligible one) */
  expiringSessionBelow: number | null
}
export const POLICIES = {
  'v1.9': {
    about: 'earliest weekly reset first among accounts resetting within 72 h (rule v1.9)',
    due: false,
    expiringS: EXPIRING_S,
    expiringSessionBelow: null,
  },
  laxity: {
    about: 'the due account with the least slack first (laxity), else v1.9',
    due: true,
    expiringS: EXPIRING_S,
    expiringSessionBelow: null,
  },
  'laxity-pure': {
    about: 'the due account with the least slack first (laxity), and no fixed 72 h horizon',
    due: true,
    expiringS: null,
    expiringSessionBelow: null,
  },
  'v1.9-cool': {
    about: 'v1.9, but the expiring step skips an account whose 5 h window is at 60 % or more (SESSION_PRESSURE)',
    due: false,
    expiringS: EXPIRING_S,
    expiringSessionBelow: SESSION_PRESSURE,
  },
} as const satisfies Record<string, PolicyDef>
export type PolicyName = keyof typeof POLICIES
export const POLICY_NAMES = Object.keys(POLICIES) as PolicyName[]
export const DEFAULT_POLICY: PolicyName = 'v1.9'
export const isPolicyName = (v: unknown): v is PolicyName => typeof v === 'string' && Object.hasOwn(POLICIES, v)
/** The registry's live policy; an unknown name (refused at load) reads as the default. */
export const livePolicy = (reg: Registry): PolicyName => (isPolicyName(reg.policy) ? reg.policy : DEFAULT_POLICY)
/** What the sample log's `rule` names: the rule version, and the policy when it is not the default. */
export const ruleTag = (policy: PolicyName): string =>
  policy === DEFAULT_POLICY ? RULE_VERSION : `${RULE_VERSION}+${policy}`
/** The policy a ledger line's `rule` names; null for a line from before the rule was recorded. */
export function policyOfRule(rule: string | null): PolicyName | null {
  if (rule === null) return null
  const name = rule.split('+')[1]
  return name === undefined ? DEFAULT_POLICY : isPolicyName(name) ? name : null
}

/** Everything a policy decides over. `load`: the measured load model, which the laxity step reads. */
export interface PolicySnapshot {
  reg: Registry
  cache: Cache
  lane: string
  nowMs: number
  rng?: () => number
  load?: LoadModel
}

/** A named policy as a pure function over a snapshot (the registry's own `policy` is ignored). */
export const pickWith = (name: PolicyName, s: PolicySnapshot): PickResult =>
  pick({ ...s.reg, policy: name }, s.cache, s.lane, s.nowMs, s.rng, s.load)

/**
 * Rule v1.5 (docs/claude-accounts.md §The picker) under the registry's live policy. Among several candidates the highest
 * weight wins (ties follow registry order); with `rng` the candidates share the work in proportion to their weights instead.
 */
export function pick(
  reg: Registry,
  cache0: Cache,
  lane: string,
  nowMs: number,
  rng?: () => number,
  load: LoadModel = MEASURED,
): PickResult {
  const cache = withoutSessionWindows(reg, cache0)
  const r = pickRaw(reg, cache, lane, nowMs, { rng, def: POLICIES[livePolicy(reg)], load })
  return { ...r, stale: r.reason !== 'interactive-fallback' && r.picked !== SPILL && isStaleOk(cache, r.picked, nowMs) }
}

/**
 * The due accounts among `ids`, least slack first (laxity.ts). An account is due when its slack is 0 h or less; the
 * pool is every enabled account, so the demand it may draw on is the whole pool's.
 */
export function dueAccounts(reg: Registry, cache: Cache, ids: string[], nowMs: number, load: LoadModel): string[] {
  const poolUnits = Object.values(reg.accounts)
    .filter((a) => a.enabled)
    .reduce((s, a) => s + accountUnits(a).weekly, 0)
  const slack = new Map<string, number>()
  for (const id of ids) {
    const x = cache.samples[id]
    if (!x || !hasW(x) || x.w_reset === null) continue
    const a = reg.accounts[id]
    const ratio = hasSessionLimit(a) ? sessionRatio(load, planTier(a.plan)) : null
    const h = laxityHours({
      w: x.w!,
      resetMs: x.w_reset * 1000,
      nowMs,
      weeklyUnits: accountUnits(a).weekly,
      windowUnits: ratio === null ? null : ratio * accountUnits(a).session,
      poolUnits,
      load,
    })
    if (h !== null && h <= 0) slack.set(id, h)
  }
  return [...slack.keys()].sort((p, q) => slack.get(p)! - slack.get(q)!)
}

/** Weekly capacity left under the account's own ceiling (scaled by its plan) per hour to its own reset, sharpened by URGENCY_EXP. */
export function accountWeight(reg: Registry, cache: Cache, id: string, nowMs: number): number {
  const x = cache.samples[id]
  const hasWeek = !!x && hasW(x)
  // a reset that already passed means the cached % predates the rollover: judge it as a fresh week
  const rolled = hasWeek && x.w_reset !== null && x.w_reset * 1000 <= nowMs
  // a reserve inside its budget offers only the room its model's unused allowance leaves (0 without a fresh scoped sample)
  const budget = reserveBudget(reg, cache, id, nowMs)
  const held = budget?.known ? budget.unused! : 0
  const spare = (hasWeek && !rolled ? weeklyMax(x, nowMs, isDrain(reg, id, nowMs)) - x.w! : WEEKLY_MAX) - held
  const hoursLeft =
    hasWeek && !rolled && x.w_reset !== null ? Math.max(1, (x.w_reset * 1000 - nowMs) / 3600_000) : WEEK_S / 3600
  return (spare * accountUnits(reg.accounts[id]).weekly) / hoursLeft ** URGENCY_EXP
}

/**
 * The account a model's launcher lands on: among the enabled accounts in reserve for `model`, the open one (eligible, scoped
 * percent under 100) with the most unused allowance; none open → the first of them (v1's answer); none at all → the default.
 */
export function launchAccount(reg: Registry, cache: Cache, model: string, nowMs: number): string {
  const want = model.toLowerCase()
  const ids = Object.keys(reg.accounts).filter((id) => {
    const m = modeOf(reg, id, nowMs)
    return reg.accounts[id].enabled && m.kind === 'reserve' && m.for?.toLowerCase() === want
  })
  const fresh = (id: string) => {
    const sc = scopedLimit(cache.samples[id], model)
    return sc && nowMs - sc.ts < STALE_OK_MS ? sc : null
  }
  const unused = (id: string) => {
    const sc = fresh(id)
    return sc ? Math.max(0, sc.allowance - sc.used) : -1
  }
  const open = ids.filter((id) => eligible(reg, cache, id, nowMs) && (fresh(id)?.percent ?? 0) < 100)
  const best = open.reduce<string | undefined>(
    (b, id) => (b === undefined || unused(id) > unused(b) ? id : b),
    undefined,
  )
  return best ?? ids[0] ?? defaultAccountId(reg)
}

/** The account `cf` launches on (launchAccount for Fable); without a cache it is v1's answer: the Fable account, else the default. */
export const fableAccount = (reg: Registry, cache: Cache = emptyCache(), nowMs = 0): string =>
  launchAccount(reg, cache, 'fable', nowMs)

interface RuleCtx {
  rng?: () => number
  def: PolicyDef
  load: LoadModel
}

function pickRaw(reg: Registry, cache: Cache, lane: string, nowMs: number, ctx: RuleCtx): Omit<PickResult, 'stale'> {
  // Reserve mode, hold: account: the last resort for every pick, whatever its budget says (v1's Fable mode). hold: allowance:
  // inside its budget an account takes its normal place; over it, other work is refused; without a fresh scoped sample the
  // budget is unknown and the account is the last resort
  let open = reg
  const lastResort: string[] = []
  for (const id of Object.keys(reg.accounts)) {
    if (!reg.accounts[id].enabled) continue
    const m = modeOf(reg, id, nowMs)
    if (m.kind === 'reserve' && m.for && reserveHold(m) === 'account') {
      lastResort.push(id)
      continue
    }
    const b = reserveBudget(reg, cache, id, nowMs)
    if (!b) continue
    if (!b.known) lastResort.push(id)
    else if (!b.open) open = withoutAccount(open, id)
  }
  if (!lastResort.length) return pickRule(open, cache, lane, nowMs, ctx)
  const spared = pickRule(lastResort.reduce(withoutAccount, open), cache, lane, nowMs, ctx)
  if (spared.picked !== SPILL && spared.reason !== 'interactive-fallback') return spared
  const r = pickRule(open, cache, lane, nowMs, ctx)
  return lastResort.includes(r.picked) ? { ...r, reason: `${modeOf(reg, r.picked, nowMs).for}-reserve` } : r
}

function pickRule(reg: Registry, cache: Cache, lane: string, nowMs: number, ctx: RuleCtx): Omit<PickResult, 'stale'> {
  const { rng, def } = ctx
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
  const draining = cool.filter((id) => isDrain(reg, id, nowMs))
  if (draining.length) return { picked: choose(draining)!, reason: 'drain' }

  if (bulk && def.due) {
    const due = dueAccounts(reg, cache, ok, nowMs, ctx.load)
    if (due.length) return { picked: due[0], reason: 'due' }
  }
  if (bulk && def.expiringS !== null) {
    const horizonMs = def.expiringS * 1000
    const expiring = ok
      .filter((id) => {
        const x = cache.samples[id]
        const msLeft = x.w_reset === null || !hasW(x) ? null : x.w_reset * 1000 - nowMs
        const cool =
          def.expiringSessionBelow === null || (sessionPct(reg, cache, id, nowMs) ?? 0) < def.expiringSessionBelow
        return cool && msLeft !== null && msLeft > 0 && msLeft < horizonMs
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
  // a reserve account is also due when its scoped sample (endpoint only) is older than SCOPED_FRESH_MS
  return Object.keys(reg.accounts).filter(
    (id) =>
      reg.accounts[id].enabled &&
      !authBlocked(id) &&
      (sampleAge(cache.samples[id], nowMs) > FRESH_MS || scopedDue(reg, cache, id, nowMs)),
  )
}
