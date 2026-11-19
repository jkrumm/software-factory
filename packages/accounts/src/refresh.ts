// The refresh orchestration: claim, sample (peer, usage endpoint, `claude auth status`), record. Ports in, files out.
import { loginVerdict, refreshEnv, type LoginVerdict } from './claude-auth.ts'
import { type KeychainDeps, keychainToken } from './keychain.ts'
import { fetchUsage } from './oauth.ts'
import {
  type Cache,
  type Registry,
  type RefreshResult,
  type Sample,
  FRESH_MS,
  STALE_OK_MS,
  hasSessionLimit,
  isNum,
  newestAge,
  required,
  sampleAge,
  scopedDue,
  usable,
  dueIds,
  withoutSessionWindows,
} from './policy.ts'
import { isOverrideRecord, newerRecord } from './modes.ts'
import type { HttpGet, PeerUsage } from './ports.ts'
import type { HistoryTarget } from './history-store.ts'
import { accountDir } from './registry.ts'
import {
  loadCache,
  markExhausted,
  markVerified,
  readVerified,
  releaseClaim,
  saveSample,
  endOverrides,
  setAuthFailed,
  loadOverrides,
  writeOverride,
} from './store.ts'

export interface RefreshDeps extends KeychainDeps {
  httpGet: HttpGet
  claudeBin: string
  dir?: string
  now: () => number
  /** Accounts to refresh. They are already claimed (budget stamped) by the caller. */
  ids: string[]
  /** The peer machine's `claude-account usage --json` body (parsed), fetched once per run; throws or answers null when unreachable. Absent = no import. */
  peerUsage?: PeerUsage
  /** The mode override state file (default: modesPath()); the peer's newer overrides are adopted into it. */
  modesPath?: string
  /** This machine's name for the audit line of an adopted override. */
  machine?: string
  /** Where the sample log and the reset ledger are written (docs/accounts.md §History); absent = no history. */
  history?: HistoryTarget
}

/**
 * Sample from the OAuth usage endpoint with the account's own Keychain token (read-only, 0 tokens, no window
 * priming). Every failure (locked Keychain, HTTP error incl. 429, bad body) is just "no sample": none of them
 * proves anything about the login. The one exception to "just fail" is HTTP 401: the access token of an idle
 * account expires and nothing renews it, but `claude auth status` (0 tokens) makes the binary renew it in the
 * Keychain, so a 401 runs it (`status`, shared with the caller's verdict), re-reads the token and retries the GET
 * once. The token is never logged or stored.
 */
async function oauthSample(d: RefreshDeps, id: string, status: () => LoginVerdict): Promise<Sample | null> {
  const token = keychainToken(d, id)
  if (!token) return null
  const first = await fetchUsage(d, id, token)
  if (first.status !== 401) return first.sample
  d.log?.(`refresh ${id}: usage endpoint HTTP 401, renewing the access token via \`claude auth status\``)
  if (status().startFailed) return null
  const renewed = keychainToken(d, id)
  return renewed ? (await fetchUsage(d, id, renewed)).sample : null
}

/**
 * No sample and no verdict this run (the API or `claude auth status` hung: 2026-11-13 five red runs of ~95 s from a
 * transient 503/401 outage that cleared by the next hour). Not red while this machine proved the login within STALE_OK_MS:
 * `deferred` (exit 0, logged). Past that, or never proven, it stays `unresolved` (exit 1).
 */
function unverified(d: RefreshDeps, id: string): RefreshResult {
  const at = readVerified(id, d.dir)
  if (at === null || d.now() - at >= STALE_OK_MS) return 'unresolved'
  d.log?.(
    `refresh ${id}: no verdict this run, login last proven ${Math.round((d.now() - at) / 60_000)} min ago (deferred)`,
  )
  return 'deferred'
}

/**
 * Quota is per account, not per machine, so the peer machine's samples are as good as ours: an idle login whose
 * Keychain access token expired gets 401 on every usage GET (and `claude auth status` no longer renews it), while the
 * peer, where the account is busy, has fresh numbers. Each locally registered, enabled row of the peer's `usage --json`
 * becomes a `peer` sample (window timestamps rebuilt from the row's ages, so the original age is never laundered) and a
 * future `exhausted_until` becomes a mark; `mergeSample` keeps whichever window is newer. Auth state is never imported:
 * logins are per machine. Returns the ids that received a sample. A peer that is unreachable or garbled is one log line.
 */
async function importPeerSamples(d: RefreshDeps): Promise<Set<string>> {
  const imported = new Set<string>()
  if (!d.peerUsage) return imported
  let body: unknown
  try {
    body = await d.peerUsage()
  } catch (e) {
    d.log?.(`refresh: peer usage unavailable: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`)
    return imported
  }
  const rows = (body as { accounts?: unknown } | null)?.accounts
  if (!Array.isArray(rows)) {
    d.log?.('refresh: peer usage unreadable, no samples imported')
    return imported
  }
  const now = d.now()
  const pct = (v: unknown) => (isNum(v) ? v : null)
  for (const r of rows as Record<string, unknown>[]) {
    const id = r?.id
    if (typeof id !== 'string' || !Object.hasOwn(d.reg.accounts, id)) continue
    adoptOverride(d, id, r.mode_override, now)
    if (!required(d.reg.accounts, id).enabled) continue
    const win = (value: unknown, reset: unknown, age: unknown) => {
      const v = pct(value)
      return v === null
        ? { v, reset: null, ts: null }
        : { v, reset: pct(reset), ts: isNum(age) ? now - age * 1000 : null }
    }
    const s = win(r.five_hour, r.five_hour_resets_at, r.five_hour_age_s)
    const w = win(r.seven_day, r.seven_day_resets_at, r.seven_day_age_s)
    const lim = peerLimits(r, now)
    if (s.v !== null || w.v !== null || lim) {
      saveSample(
        id,
        { s: s.v, s_reset: s.reset, s_ts: s.ts, w: w.v, w_reset: w.reset, w_ts: w.ts, src: 'peer', ...lim },
        d.dir,
        hasSessionLimit(required(d.reg.accounts, id)),
        now,
        d.history,
      )
      imported.add(id)
    }
    if (isNum(r.exhausted_until) && r.exhausted_until * 1000 > now) markExhausted(id, r.exhausted_until, d.dir)
  }
  return imported
}

/** The peer row's `limits` / `weekly_scoped_shares` (each with `age_s`) as sample fields, the fetch time rebuilt from the oldest age. */
function peerLimits(r: Record<string, unknown>, now: number) {
  if (!Array.isArray(r.limits)) return null
  const strip = (v: unknown) =>
    (Array.isArray(v) ? v : [])
      .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && !Array.isArray(e))
      .map((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'age_s')))
  const ages = (r.limits as { age_s?: unknown }[]).map((l) => l?.age_s).filter(isNum)
  if (!ages.length) return null // an age-less (or empty) limit set cannot be dated: never laundered into a fresh one
  const limits = strip(r.limits)
  return {
    limits,
    ...(Array.isArray(r.weekly_scoped_shares) ? { scoped_shares: strip(r.weekly_scoped_shares) } : {}),
    limits_ts: now - Math.max(...ages) * 1000,
  }
}

/** The peer's override for `id` replaces ours when it is newer (a clear's tombstone too): how a mode set on one machine reaches the other. */
function adoptOverride(d: RefreshDeps, id: string, rec: unknown, now: number): void {
  if (!isOverrideRecord(rec)) return
  try {
    if (!newerRecord(rec, loadOverrides(d.modesPath).accounts[id])) return
    writeOverride(id, rec, { action: 'adopt', machine: d.machine ?? 'local', nowMs: now, path: d.modesPath })
    d.log?.(`refresh: adopted the peer's mode override for ${id} (${rec.cleared ? 'cleared' : rec.kind})`)
  } catch (e) {
    d.log?.(`refresh: peer mode override for ${id} not adopted: ${(e as Error).message}`)
  }
}

export async function runRefresh(d: RefreshDeps): Promise<Record<string, RefreshResult>> {
  const results: Record<string, RefreshResult> = {}
  const imported = d.ids.length ? await importPeerSamples(d) : new Set<string>()
  for (const id of d.ids) {
    results[id] = 'unresolved' // neither a fresh sample nor an auth verdict, until proven otherwise
    const env = refreshEnv(d.baseEnv, accountDir(required(d.reg.accounts, id)))
    let verdict: LoginVerdict | undefined
    const status = () => (verdict ??= loginVerdict(d, env)) // at most one `auth status` per account and run
    const afterImport = loadCache(d.dir)
    if (
      imported.has(id) &&
      sampleAge(afterImport.samples[id], d.now()) < FRESH_MS &&
      !scopedDue(d.reg, afterImport, id, d.now()) // a reserve still needs its scoped limit, which only the endpoint gives
    ) {
      // A fresh peer sample replaces the endpoint GET, but says nothing about THIS machine's login: the verdict still runs.
      const v = status()
      if (v.startFailed) {
        d.log?.(`refresh ${id}: cannot start claude (${v.startFailed})`)
        releaseClaim(id, d.dir)
      } else if (v.loggedIn !== null) setAuthFailed(id, !v.loggedIn, d.now(), d.dir)
      if (v.loggedIn === true) markVerified(id, d.now(), d.dir)
      // a peer sample proves nothing about this machine's login: without a verdict the run is unverified (keepalive exit 1 once the last proof is 6 h old)
      results[id] =
        v.loggedIn === true
          ? 'fresh'
          : v.loggedIn === false
            ? 'auth-failed'
            : v.startFailed
              ? 'unresolved'
              : unverified(d, id)
      continue
    }
    const sample = await oauthSample(d, id, status)
    if (sample) {
      saveSample(id, sample, d.dir, hasSessionLimit(required(d.reg.accounts, id)), d.now(), d.history)
      setAuthFailed(id, false, d.now(), d.dir)
      markVerified(id, d.now(), d.dir)
      results[id] = 'fresh'
      continue
    }
    const v = status()
    if (v.startFailed) {
      d.log?.(`refresh ${id}: cannot start claude (${v.startFailed})`)
      releaseClaim(id, d.dir)
      continue
    }
    if (v.loggedIn === null) {
      d.log?.(`refresh ${id}: no sample and no auth verdict`)
      results[id] = unverified(d, id)
      continue
    }
    setAuthFailed(id, !v.loggedIn, d.now(), d.dir)
    if (v.loggedIn) markVerified(id, d.now(), d.dir)
    if (!v.loggedIn) {
      results[id] = 'auth-failed'
      continue
    }
    const age = newestAge(withoutSessionWindows(d.reg, loadCache(d.dir)).samples[id], d.now()) // the same "usable" test the picker applies
    results[id] = age >= STALE_OK_MS ? 'stale' : 'auth-ok'
    if (results[id] === 'stale')
      d.log?.(
        `refresh ${id}: logged in but the usage endpoint gave no sample and the stored one is ${Number.isFinite(age) ? `${Math.round(age / 3600_000)} h old` : 'missing'}`,
      )
  }
  try {
    endOverrides(loadCache(d.dir), d.now(), { machine: d.machine ?? 'local', path: d.modesPath })
  } catch {
    // the ending is a record, never a gate
  }
  return results
}

export interface BeforePick {
  reg: Registry
  lane: string
  now: number
  cache: Cache
  /** Claims the due ids atomically (budget stamped); returns the ones this caller won. */
  claim: (ids: string[]) => string[]
  /** Blocking refresh of already-claimed ids (account has no usable sample). */
  runSync: (ids: string[]) => void | Promise<void>
  /** Detached, fire-and-forget refresh of already-claimed ids. */
  detach: (ids: string[]) => void
}

/**
 * Refresh policy of `pick`, the same on every lane except for blocking: a due account (no sample, or a window older
 * than FRESH_MS) is claimed first (5-min budget), then refreshed detached in the background. Only a non-interactive
 * lane waits, and only for an account with no usable sample; the interactive lane never blocks and never spends
 * tokens (the refresh is the 0-token usage GET / `claude auth status`), so a pick stays instant.
 */
export async function refreshBeforePick(b: BeforePick): Promise<{ sync: string[]; background: string[] }> {
  const due = dueIds(b.reg, b.cache, b.now)
  const claimed = due.length ? b.claim(due) : []
  // a due auth-failed account is a retry: never block a pick on it
  const sync =
    b.lane === 'interactive'
      ? []
      : claimed.filter((id) => !b.cache.auth_failed[id] && !usable(b.cache.samples[id], b.now))
  const background = claimed.filter((id) => !sync.includes(id))
  if (background.length) b.detach(background)
  if (sync.length) await b.runSync(sync)
  return { sync, background }
}
