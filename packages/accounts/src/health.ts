// Cross-machine session health for the wake check (packages/accounts/docs/accounts.md §Health).
// Pure grading: callers pass the parsed `usage --json` / `expiry --json` of one machine plus its pending re-login asks.

export type HealthState = 'ok' | 'warn' | 'fail'

export interface HealthRow {
  machine: string
  id: string
  check: 'reach' | 'login' | 'quota' | 'queue'
  state: HealthState
  detail: string
  /** shell command that repairs it, run on the MacBook; null when nothing to run */
  fix: string | null
  /** transport the peer's data came over; absent for the local machine */
  via?: 'core' | 'ssh'
  /** login rows: when the login ends (ISO time) and the days left as the expiry check read them; absent when unreadable */
  ends_at?: string
  days_left?: number
}

interface UsageAcct {
  id: string
  auth_ok: boolean
  age_s: number | null
}
interface ExpiryAcct {
  id: string
  severity: string
  days_left: number | null
  expired: boolean
  refresh_expires_at: number | null
}
export interface PendingAsk {
  id: string
  ageMs: number
}

/** Sample older than this while the login claims to be fine means the usage endpoint is rejecting the token. */
export const STALE_QUOTA_S = 6 * 3600

/** The end of a login as the row carries it; nothing when the check could not read one. */
const endsOf = (exp: ExpiryAcct | undefined): Pick<HealthRow, 'ends_at' | 'days_left'> =>
  exp && exp.refresh_expires_at !== null
    ? {
        ends_at: new Date(exp.refresh_expires_at).toISOString(),
        ...(exp.days_left === null ? {} : { days_left: exp.days_left }),
      }
    : {}

const relogin = (machine: string, id: string) => `claude-relogin ${id} --machine ${machine}`

/** `fix` is the repair hint of a row for an account id (default: the owner's `claude-relogin`); null = none. */
export function gradeMachine(
  machine: string,
  d: {
    usage: { default_account?: string; accounts: UsageAcct[] } | null
    expiry: { accounts: ExpiryAcct[] } | null
    pending: PendingAsk[] | null
    via?: 'core' | 'ssh'
  },
  fix: (id: string) => string | null = (id) => relogin(machine, id),
): HealthRow[] {
  if (!d.usage) return [{ machine, id: '-', check: 'reach', state: 'fail', detail: 'unreachable', fix: null }]
  const rows: HealthRow[] = []
  const via = d.via
  const hint = via ? ` (via ${via})` : ''
  const dflt = d.usage.default_account ?? 'iu'
  for (const a of d.usage.accounts) {
    const exp = d.expiry?.accounts.find((e) => e.id === a.id)
    if (!a.auth_ok) {
      rows.push({
        machine,
        id: a.id,
        check: 'login',
        state: a.id === dflt ? 'fail' : 'warn',
        detail: 'logged out',
        fix: fix(a.id),
      })
    } else if (exp && exp.refresh_expires_at !== null && exp.severity !== 'PASS') {
      const detail = exp.expired ? 'login expired' : `login ends in ${exp.days_left} d`
      rows.push({
        machine,
        id: a.id,
        check: 'login',
        state: exp.severity === 'FAIL' ? 'fail' : 'warn',
        detail,
        fix: fix(a.id),
        ...endsOf(exp),
      })
    } else if (exp?.severity === 'PASS' && exp.days_left !== null) {
      rows.push({
        machine,
        id: a.id,
        check: 'login',
        state: 'ok',
        detail: `${exp.days_left} d left`,
        fix: null,
        ...endsOf(exp),
      })
    } else {
      // No readable expiry (Keychain unreadable over ssh, entry missing, check failed): never "ok" without data.
      rows.push({
        machine,
        id: a.id,
        check: 'login',
        state: 'warn',
        detail: `login expiry unreadable${hint}`,
        fix: null,
      })
    }
    if (a.auth_ok && a.age_s !== null && a.age_s > STALE_QUOTA_S) {
      rows.push({
        machine,
        id: a.id,
        check: 'quota',
        state: 'warn',
        detail: `no quota sample for ${Math.round(a.age_s / 3600)} h (token rejected?)`,
        fix: fix(a.id),
      })
    }
  }
  const waiting = (d.pending ?? []).filter((p) => p.ageMs < 24 * 3600_000)
  if (waiting.length)
    rows.push({
      machine,
      id: '-',
      check: 'queue',
      state: 'warn',
      detail: `${waiting.length} re-login request(s) waiting for your click`,
      fix: null,
    })
  return via ? rows.map((r) => ({ ...r, via })) : rows
}

/** Stable signature of the non-ok rows: the notifier only speaks again when it changes. */
export const healthSignature = (rows: HealthRow[]) =>
  rows
    .filter((r) => r.state !== 'ok')
    .map((r) => `${r.machine}/${r.id}/${r.check}/${r.state}`)
    .sort()
    .join('|')

export const worst = (rows: HealthRow[]): HealthState =>
  rows.some((r) => r.state === 'fail') ? 'fail' : rows.some((r) => r.state === 'warn') ? 'warn' : 'ok'
