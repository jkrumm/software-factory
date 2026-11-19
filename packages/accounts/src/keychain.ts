// The Keychain adapter: an account's Claude Code login item, read through `security` (read-only, 0 tokens).
// Only the access token (for the usage GET, never logged or stored), the two expiry timestamps and the plan tier leave the item.
import { createHash } from 'node:crypto'
import { userInfo } from 'node:os'
import { resolve } from 'node:path'
import { type LoginGrade, type LoginRow, type Registry, gradeLogin, isNum } from './policy.ts'
import type { Spawner } from './ports.ts'
import { accountDir } from './registry.ts'

export const KEYCHAIN_TIMEOUT_MS = 15_000
export const SECURITY_BIN = '/usr/bin/security'

/** Keychain service holding an account's Claude Code login: the default dir has the bare name, any other dir the first 8 hex of sha256(abs config dir). */
export const keychainService = (dir: string | null): string =>
  dir === null
    ? 'Claude Code-credentials'
    : `Claude Code-credentials-${createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 8)}`

/**
 * `security find-generic-password` args for an account's item. Claude Code files it under acct = $USER, so a process
 * that ran without USER leaves a second item (acct "unknown") under the same service; without `-a` the lookup may
 * return that stale twin (seen on the mini 2026-10-27: a 58 h expired copy behind every 401 and a false expiry WARN).
 */
export const keychainLookupArgs = (svc: string, env: Record<string, string | undefined>): string[] => [
  'find-generic-password',
  '-s',
  svc,
  '-a',
  env.USER || userInfo().username,
  '-w',
]

/** Access token out of the Keychain item's JSON (`claudeAiOauth.accessToken`); null for anything else. Never log the result. */
export function tokenFromCredentials(raw: string): string | null {
  try {
    const t = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } })?.claudeAiOauth?.accessToken
    return typeof t === 'string' && t ? t : null
  } catch {
    return null
  }
}

export interface LoginTimestamps {
  refreshTokenExpiresAt: number | null
  expiresAt: number | null
}

/** The two expiry timestamps out of the Keychain item's JSON; null when it is not a credentials blob. Never touches the tokens. */
export function expiryFromCredentials(raw: string): LoginTimestamps | null {
  try {
    const o = (JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> })?.claudeAiOauth
    if (!o || typeof o !== 'object') return null
    const ms = (v: unknown) => (isNum(v) && v > 0 ? v : null)
    return { refreshTokenExpiresAt: ms(o.refreshTokenExpiresAt), expiresAt: ms(o.expiresAt) }
  } catch {
    return null
  }
}

/**
 * The Keychain item's `claudeAiOauth.rateLimitTier` (e.g. `default_claude_max_5x`): the plan marker, not a secret.
 * Null for anything but a short string. Never touches a token field.
 */
export function tierFromCredentials(raw: string): string | null {
  try {
    const t = (JSON.parse(raw) as { claudeAiOauth?: { rateLimitTier?: unknown } })?.claudeAiOauth?.rateLimitTier
    return typeof t === 'string' && t && t.length <= 64 ? t : null
  } catch {
    return null
  }
}

/** `default_claude_max_20x` -> `ultra`, `default_claude_max_5x` -> `max` (the registry's plan names); null when the tier names neither. */
export function planFromTier(tier: string | null): string | null {
  if (!tier) return null
  if (/ultra/i.test(tier)) return 'ultra'
  const m = /max_(\d+)x/.exec(tier)
  return m ? (Number(m[1]) >= 20 ? 'ultra' : 'max') : null // the 20x tier is the Ultra account
}

export interface KeychainDeps {
  reg: Registry
  spawn: Spawner
  /** Override for tests; defaults to SECURITY_BIN. */
  securityBin?: string
  baseEnv: Record<string, string | undefined>
  log?: (msg: string) => void
}

/**
 * Grade of every enabled account's login from its own Keychain item (read-only `security … -w`, 0 tokens, nothing
 * logged but timestamps and the plan tier). `ids` selects accounts instead, disabled ones included (a first login).
 */
export function readLoginExpiry(d: {
  reg: Registry
  spawn: Spawner
  securityBin?: string
  baseEnv: Record<string, string | undefined>
  now: number
  ids?: string[]
}): LoginRow[] {
  return Object.entries(d.reg.accounts)
    .filter(([id, a]) => (d.ids ? d.ids.includes(id) : a.enabled))
    .map(([id, a]) => {
      const svc = keychainService(accountDir(a))
      const kc = d.spawn(d.securityBin ?? SECURITY_BIN, keychainLookupArgs(svc, d.baseEnv), {
        env: d.baseEnv as Record<string, string>,
        timeoutMs: KEYCHAIN_TIMEOUT_MS,
      })
      const isDefault = a.dir === null
      const row = (grade: LoginGrade) => ({
        id,
        default: isDefault,
        grade,
        severity: !isDefault && grade === 'FAIL' ? ('WARN' as const) : grade,
      })
      const unreadable = (why: string): LoginRow => ({
        ...row('WARN'),
        refresh_expires_at: null,
        access_expires_at: null,
        tier: null,
        plan_detected: null,
        days_left: null,
        expired: false,
        detail: `login expiry unreadable (${why})`,
      })
      if (kc.error || kc.status !== 0)
        return unreadable(
          `Keychain '${svc}': ${kc.error?.message ?? (kc.stderr.trim().slice(0, 120) || `rc=${kc.status}`)}`,
        )
      const t = expiryFromCredentials(kc.stdout)
      if (!t) return unreadable(`Keychain '${svc}' is not a Claude login`)
      const tier = tierFromCredentials(kc.stdout)
      const plan = { tier, plan_detected: planFromTier(tier) }
      if (t.refreshTokenExpiresAt === null)
        return {
          ...unreadable('no refreshTokenExpiresAt in the Keychain item'),
          access_expires_at: t.expiresAt,
          ...plan,
        }
      const left = t.refreshTokenExpiresAt - d.now
      const days = Math.round((left / 86400_000) * 10) / 10
      const expired = left <= 0
      const date = new Date(t.refreshTokenExpiresAt).toISOString().slice(0, 10)
      return {
        ...row(gradeLogin(t.refreshTokenExpiresAt, d.now)),
        refresh_expires_at: t.refreshTokenExpiresAt,
        access_expires_at: t.expiresAt,
        ...plan,
        days_left: days,
        expired,
        detail: expired
          ? `login expired ${date} (${-days} d ago): /login needed`
          : `login valid until ${date} (${days} d left)`,
      }
    })
}

/** Access token of the account's Keychain item; null (with the reason logged) when it cannot be read. Never log the result. */
export function keychainToken(d: KeychainDeps, id: string): string | null {
  const svc = keychainService(accountDir(d.reg.accounts[id]))
  const kc = d.spawn(d.securityBin ?? SECURITY_BIN, keychainLookupArgs(svc, d.baseEnv), {
    env: d.baseEnv as Record<string, string>,
    timeoutMs: KEYCHAIN_TIMEOUT_MS,
  })
  const token = kc.status === 0 && !kc.error ? tokenFromCredentials(kc.stdout) : null
  if (!token)
    d.log?.(
      `refresh ${id}: no Keychain token (${svc}): ${kc.error?.message ?? (kc.stderr.trim().slice(0, 200) || `rc=${kc.status}`)}`,
    )
  return token
}
