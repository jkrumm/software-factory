import type { MachineModel, ReadAccountQuota } from '@software-factory/contract'

/** A share at or above this is drawn as a warning: the mock's marker sits at 95 %, a little before the wall. */
export const WARN_AT_PCT = 90

const clampPct = (used: number): number => Math.min(Math.max(Math.round(used), 0), 100)

/** One account on the strip: the weekly share first; null when the account has no reading. */
export interface AccountMeter {
  account: string
  weeklyPct: number | null
  warn: boolean
  /** the reading is old, or the account is at its limit */
  note: string | null
}

export function accountMeter(quota: ReadAccountQuota, now: Date): AccountMeter {
  const weeklyPct = quota.weeklyUsed === null ? null : clampPct(quota.weeklyUsed)
  const exhausted = quota.exhaustedUntil !== null && new Date(quota.exhaustedUntil) > now
  return {
    account: quota.account,
    weeklyPct,
    warn: exhausted || (weeklyPct !== null && weeklyPct >= WARN_AT_PCT),
    note: exhausted ? `at its limit until ${resetWords(quota.exhaustedUntil, now)}` : quota.fresh ? null : 'stale',
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

/** A reset in the owner's words and local time: "09:10" within a day, "Wednesday 16:00" after; "none" for no window. */
export function resetWords(iso: string | null, now: Date): string {
  if (iso === null) return 'none'
  const at = new Date(iso)
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (at.getTime() - now.getTime() < DAY_MS) return time
  return `${at.toLocaleDateString('en-GB', { weekday: 'long' })} ${time}`
}

/** The host in two short phrases; a failed reading is said, not drawn as zero. */
export function machineWords(machine: Pick<MachineModel, 'load' | 'loadCeiling' | 'memory' | 'memoryCeilings'>): {
  load: string
  swap: string
  warn: boolean
} {
  const { load, loadCeiling, memory, memoryCeilings } = machine
  return {
    load: load === null ? 'load unknown' : `load ${Math.round(load * 10) / 10} of ${loadCeiling}`,
    swap: memory === null ? 'swap unknown' : `swap ${memory.swapUsedPct}% of RAM`,
    warn:
      (load !== null && load > loadCeiling) ||
      (memory !== null &&
        (memory.swapUsedPct > memoryCeilings.swapUsedPct || memory.swapoutMbPer300s > memoryCeilings.swapoutMbPer300s)),
  }
}
