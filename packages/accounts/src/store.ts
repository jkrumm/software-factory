// The per-account cache files under cacheDir() (docs/accounts.md §Files) and the claim and stamp files beside them.
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type Cache,
  type Registry,
  type Sample,
  REFRESH_MIN_MS,
  ID,
  dueIds,
  emptyCache,
  isNum,
  isSample,
  mergeSample,
  noSession,
} from './policy.ts'
import { cacheDir } from './paths.ts'

export function writeAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

// ── Per-account cache files ────────────────────────────────────────────────────────────────────────────────────
// <id>.sample.json · <id>.exhausted.json · <id>.auth.json · <id>.statusline.json (last statusline feed) · <id>.refresh.claim. Every writer replaces only its own
// small file atomically, so there is no lock: two accounts or two kinds never contend, and a lost update on one
// file only costs freshness (the next feed rewrites it).

export const file = (dir: string, id: string, kind: string) => {
  if (!ID.test(id)) throw new Error(`bad account id '${id}'`)
  return join(dir, `${id}.${kind}`)
}
export const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function loadCache(dir = cacheDir()): Cache {
  const c = emptyCache()
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return c
  }
  for (const name of names) {
    const m = /^([A-Za-z0-9_-]+)\.(sample|exhausted|auth)\.json$/.exec(name)
    if (!m) continue
    const [, id, kind] = m
    const j = readJson(join(dir, name)) as Record<string, unknown> | null
    if (!j) continue
    if (kind === 'sample') {
      if (isSample(j)) c.samples[id] = j // a malformed file is dropped, the next feed rewrites it
    } else if (kind === 'exhausted' && isNum(j.until)) c.exhausted[id] = j.until
    else if (kind === 'auth' && j.failed === true) {
      c.auth_failed[id] = true
      if (isNum(j.ts)) c.auth_failed_at[id] = j.ts
    }
  }
  return c
}

/** `sessionLimit` false (a plan without a 5 h window): the session half of both the incoming and the stored sample is discarded. */
export function saveSample(id: string, inc: Sample, dir = cacheDir(), sessionLimit = true): void {
  const path = file(dir, id, 'sample.json')
  const prev = readJson(path) as Sample | null
  const merged = mergeSample(sessionLimit || !prev ? prev : noSession(prev), sessionLimit ? inc : noSession(inc))
  writeAtomic(path, JSON.stringify(merged))
}

export function markExhausted(id: string, untilS: number, dir = cacheDir()): void {
  const path = file(dir, id, 'exhausted.json')
  const cur = (readJson(path) as { until?: number } | null)?.until ?? 0
  writeAtomic(path, JSON.stringify({ until: Math.max(untilS, cur) }))
}

/** When this machine last proved the account's login (a sample from its own token, or `loggedIn: true`); null = never. */
export function readVerified(id: string, dir = cacheDir()): number | null {
  const ts = (readJson(file(dir, id, 'verified.json')) as { ts?: unknown } | null)?.ts
  return isNum(ts) ? ts : null
}

export function markVerified(id: string, nowMs: number, dir = cacheDir()): void {
  writeAtomic(file(dir, id, 'verified.json'), JSON.stringify({ ts: nowMs }))
}

/** Records the auth verdict; a no-op when it already says the same. */
export function setAuthFailed(id: string, failed: boolean, nowMs: number, dir = cacheDir()): void {
  const path = file(dir, id, 'auth.json')
  const cur = (readJson(path) as { failed?: boolean } | null)?.failed === true
  if (!failed && !cur) return // a repeated failure still rewrites the mark: its ts restarts the retry cooldown
  writeAtomic(path, JSON.stringify({ failed, ts: nowMs }))
}

/**
 * Statusline feed: a window the payload omits keeps its previous value and timestamp (so it is never presented as
 * fresh). A live statusline proves the login works, so it also clears a recorded auth failure.
 */
export function recordSample(
  id: string,
  part: { s?: number | null; w?: number | null; s_reset?: number | null; w_reset?: number | null },
  nowMs: number,
  dir = cacheDir(),
  sessionLimit = true,
): void {
  const has = (v: number | null | undefined): v is number => typeof v === 'number'
  saveSample(
    id,
    {
      s: part.s ?? null,
      s_reset: has(part.s) ? (part.s_reset ?? null) : null,
      s_ts: has(part.s) ? nowMs : null,
      w: part.w ?? null,
      w_reset: has(part.w) ? (part.w_reset ?? null) : null,
      w_ts: has(part.w) ? nowMs : null,
      src: 'statusline',
    },
    dir,
    sessionLimit,
  )
  setAuthFailed(id, false, nowMs, dir)
  // The sample's `src` flips to "oauth" when a refresh lands later, so the verify suite reads this stamp for "a statusline fed it".
  writeAtomic(file(dir, id, 'statusline.json'), JSON.stringify({ ts: nowMs }))
}

export const RELOGIN_ASK_INTERVAL_MS = 24 * 3600_000
export const RELOGIN_CAP_INTERVAL_MS = 3600_000
export const reloginStampPath = (dir: string, id: string) => file(dir, id, 'relogin-ask.json')
export const reloginCapPath = (dir: string) => join(dir, 'relogin-ask.cap')

/**
 * Claim a time stamp file atomically: exclusive create (private temp file hard-linked into place, so a reader never
 * sees a stamp without its time). A stamp younger than `intervalMs` means someone already holds the slot; an older,
 * unreadable or future one is replaced (unlink + exclusive create: of two racing replacers exactly one wins).
 */
export function claimStamp(path: string, nowMs: number, intervalMs: number): boolean {
  mkdirSync(dirname(path), { recursive: true })
  const create = (): boolean => {
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    writeFileSync(tmp, JSON.stringify({ ts: nowMs }))
    try {
      linkSync(tmp, path)
      return true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      return false
    } finally {
      unlinkSync(tmp)
    }
  }
  if (create()) return true
  const ts = (readJson(path) as { ts?: unknown } | null)?.ts
  if (isNum(ts) && nowMs - ts >= 0 && nowMs - ts < intervalMs) return false
  try {
    unlinkSync(path)
  } catch {
    return false // someone else replaced it first
  }
  return create()
}
export const releaseStamp = (path: string) => {
  try {
    unlinkSync(path)
  } catch {
    // already gone
  }
}

/**
 * Claim the per-account refresh: exclusive create of <id>.refresh.claim (content = claim time). A claim younger than
 * REFRESH_MIN_MS is the 5-min budget; an older one is stale and replaced. Racing replacers may both win: one
 * duplicate refresh at worst.
 */
export function claimRefresh(
  reg: Registry,
  ids: string[],
  nowMs: number,
  cache: Cache,
  dir = cacheDir(),
  ignoreAuthMark = false,
  all = false,
): string[] {
  mkdirSync(dir, { recursive: true })
  // Exclusive create WITH content: write a private temp file, then hard-link it into place (fails with EEXIST if
  // the claim exists), so a concurrent reader never sees a claim without its timestamp.
  const create = (path: string) => {
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    writeFileSync(tmp, String(nowMs))
    try {
      linkSync(tmp, path)
    } finally {
      unlinkSync(tmp)
    }
  }
  // `all` (the daily login keepalive): every enabled account, whatever its sample age; the claim budget still applies.
  const candidates = all
    ? Object.keys(reg.accounts).filter((id) => reg.accounts[id].enabled)
    : dueIds(reg, cache, nowMs, ignoreAuthMark)
  return candidates.filter((id) => {
    if (!ids.includes(id)) return false
    const path = file(dir, id, 'refresh.claim')
    try {
      create(path)
      return true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    let at: number
    try {
      at = Number(readFileSync(path, 'utf8').trim())
    } catch {
      return false // the claim vanished or is unreadable: someone else is on it
    }
    if (Number.isFinite(at) && nowMs - at <= REFRESH_MIN_MS) return false
    try {
      unlinkSync(path)
      create(path)
      return true
    } catch {
      return false // lost the replacement race
    }
  })
}

export function releaseClaim(id: string, dir = cacheDir()): void {
  try {
    unlinkSync(file(dir, id, 'refresh.claim'))
  } catch {
    // already gone
  }
}
