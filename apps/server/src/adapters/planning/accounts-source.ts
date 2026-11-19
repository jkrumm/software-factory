import {
  type AccountPaths,
  clearModeOverride,
  readQuotaAtResetIn,
  readStatus,
  setModeOverride,
  wallResetAt,
} from '@software-factory/accounts'
import type { AccountMode } from '@software-factory/contract'
import { type AccountReading, RANK_LANE } from '../../domains/capacity/accounts.ts'
import type { AccountDesk, AccountSource, AccountStatusRow } from '../../domains/capacity/ports.ts'
import { err, ok, portError, type Result } from '../../kernel/result.ts'

const date = (iso: string | null | undefined): Date | null => (iso ? new Date(iso) : null)

const limitOf = (a: AccountStatusRow, kind: string) => a.limits.find((l) => l.kind === kind)
const percentOf = (l: Record<string, unknown> | undefined): number | null =>
  typeof l?.percent === 'number' ? l.percent : null
const resetOf = (l: Record<string, unknown> | undefined): Date | null =>
  typeof l?.resets_at === 'string' ? date(l.resets_at) : null

/** The newest age of the account's windows, in seconds; null when no window has a sample. */
const newestAgeS = (a: AccountStatusRow): number | null => {
  const ages = a.limits.flatMap((l) => (typeof l.age_s === 'number' && l.kind !== 'weekly_scoped' ? [l.age_s] : []))
  return ages.length === 0 ? null : Math.min(...ages)
}

/** One account of the package's status as a reading: the windows as the sample shows them and the verdict for the bulk lane. */
export function readingOf(a: AccountStatusRow, now: Date): AccountReading {
  const lane = a.lanes[RANK_LANE]
  const age = newestAgeS(a)
  const wall = wallResetAt(a, now.getTime())
  return {
    account: a.id,
    readAt: now,
    sampledAt: age === null ? null : new Date(now.getTime() - age * 1000),
    enabled: a.enabled,
    authOk: a.auth_ok,
    fiveHourUsed: percentOf(limitOf(a, 'session')),
    weeklyUsed: percentOf(limitOf(a, 'weekly_all')),
    fiveHourResetsAt: resetOf(limitOf(a, 'session')),
    weeklyResetsAt: resetOf(limitOf(a, 'weekly_all')),
    exhaustedUntil: date(a.exhausted_until),
    open: lane?.open ?? false,
    position: lane?.position ?? null,
    reason: lane?.reason ?? null,
    closedWhy: lane ? lane.why : 'the lane is unknown to the package',
    opensAt: date(lane?.opens_at),
    wallResetAt: wall === null ? null : new Date(wall),
  }
}

/**
 * The accounts as `packages/accounts` reads them, in this process: the registry, the cache files, the mode overrides, the
 * history. No shell-out and no copy of the rule; the CLI works with the server down, the server needs only the files.
 * `paths` is for a test.
 */
export function packageAccountDesk(options: { paths?: AccountPaths } = {}): AccountDesk {
  const paths = options.paths ? { paths: options.paths } : {}
  const modeOf = (account: string, at: Date): Result<AccountMode> => {
    const row = readStatus({ nowMs: at.getTime(), history: false, ...paths }).accounts.find((a) => a.id === account)
    return row ? ok(row.mode) : err(portError('refused', `no account ${account}`))
  }
  const guarded = <T>(kind: 'refused' | 'unreadable', what: string, run: () => Result<T>): Result<T> => {
    try {
      return run()
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      return err(portError(kind, `${what}: ${detail.slice(0, 300)}`))
    }
  }
  return {
    status: (at, o) =>
      guarded('unreadable', 'the accounts could not be read', () =>
        ok(readStatus({ nowMs: at.getTime(), history: o?.history ?? true, ...paths })),
      ),
    setMode: (account, body, at) =>
      guarded('refused', 'mode', () => {
        setModeOverride(
          account,
          { kind: body.mode, for: body.for ?? null, until: body.until ?? null, why: body.why ?? null },
          { nowMs: at.getTime(), ...paths },
        )
        return modeOf(account, at)
      }),
    clearMode: (account, at) =>
      guarded('refused', 'mode', () => {
        clearModeOverride(account, { nowMs: at.getTime(), ...paths })
        return modeOf(account, at)
      }),
  }
}

/** The poll's view of the desk: every account as a reading, with the package's verdict for the bulk lane. */
export function deskAccountSource(desk: AccountDesk): AccountSource {
  return {
    async read(now) {
      const status = desk.status(now, { history: false })
      if (!status.ok) return status
      return ok(status.value.accounts.map((a) => readingOf(a, now)))
    },
  }
}

/** The reset ledger of the accounts' history directory as the KPI `quota_at_reset` reads it: any span, in this process. */
export function ledgerQuotaReader(options: { paths?: AccountPaths } = {}) {
  return (span: { from: Date; to: Date }) =>
    readQuotaAtResetIn({
      from: span.from.getTime(),
      to: span.to.getTime(),
      ...(options.paths ? { paths: options.paths } : {}),
    })
}
