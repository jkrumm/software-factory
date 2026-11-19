// The usage endpoint adapter: one read-only GET with the account's own token (docs/accounts.md §Sources of a sample).
import { type Sample, sampleFromClaudeJson } from './policy.ts'
import type { HttpGet } from './ports.ts'

export const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
/** Same request shape as scripts/fetch_usage.py fetch(). */
export const oauthUsageHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  'anthropic-beta': 'oauth-2025-04-20',
  Accept: 'application/json',
})
export const OAUTH_TIMEOUT_MS = 10_000

/** Parse the `GET /api/oauth/usage` body (`five_hour` / `seven_day` with `utilization` percent + ISO `resets_at`); a window it omits stays null. */
export function sampleFromOAuthUsage(json: unknown, nowMs: number): Sample | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  const j = json as Record<string, unknown>
  // a window counts only with a numeric utilization and a string resets_at; anything else is dropped (null)
  const window = (v: unknown): { utilization?: number; resets_at?: unknown } | null => {
    const w = v as { utilization?: unknown; resets_at?: unknown } | null
    return w && typeof w === 'object' && typeof w.utilization === 'number' && typeof w.resets_at === 'string'
      ? { utilization: w.utilization, resets_at: w.resets_at }
      : null
  }
  return sampleFromClaudeJson(
    {
      cachedUsageUtilization: {
        fetchedAtMs: nowMs,
        utilization: { five_hour: window(j.five_hour), seven_day: window(j.seven_day) },
      },
    },
    'oauth',
  )
}

/** The real HttpGet: a hard timeout, no redirects, an unreadable body is just "no sample". */
export const httpGet: HttpGet = async (url, headers, timeoutMs) => {
  const r = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
  let json: unknown = null
  try {
    json = JSON.parse(await r.text())
  } catch {
    // an unreadable body is just "no sample"
  }
  return { status: r.status, json }
}

export interface UsageDeps {
  httpGet: HttpGet
  now: () => number
  log?: (msg: string) => void
}

/** One GET of the usage endpoint; the status is kept so the caller can tell an expired token (401) from the rest. */
export async function fetchUsage(
  d: UsageDeps,
  id: string,
  token: string,
): Promise<{ sample: Sample | null; status: number | null }> {
  try {
    const r = await d.httpGet(OAUTH_USAGE_URL, oauthUsageHeaders(token), OAUTH_TIMEOUT_MS)
    const sample = r.status === 200 ? sampleFromOAuthUsage(r.json, d.now()) : null
    if (!sample) d.log?.(`refresh ${id}: usage endpoint gave no sample (HTTP ${r.status})`)
    return { sample, status: r.status }
  } catch (e) {
    d.log?.(`refresh ${id}: usage endpoint failed: ${e instanceof Error ? e.name : typeof e}`) // name only: never echo a message that could carry request details
    return { sample: null, status: null }
  }
}
