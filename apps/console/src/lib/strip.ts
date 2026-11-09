import type { HostSample, MachineModel, ReadAccountQuota } from '@software-factory/contract'

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

/** The account is stopped at its limit right now. */
export const isExhausted = (quota: Pick<ReadAccountQuota, 'exhaustedUntil'>, now: Date): boolean =>
  quota.exhaustedUntil !== null && new Date(quota.exhaustedUntil) > now

/** A used share rounded to a whole percent and kept within 0 to 100; null stays null. */
export const usedPct = (used: number | null): number | null => (used === null ? null : clampPct(used))

export function accountMeter(quota: ReadAccountQuota, now: Date): AccountMeter {
  const weeklyPct = usedPct(quota.weeklyUsed)
  const exhausted = isExhausted(quota, now)
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

/** One host meter on the strip: a label, a bar from 0 to 1, the figure as it reads, and whether it is past its ceiling. */
export interface HostMeter {
  key: 'load' | 'memory' | 'swap'
  label: string
  /** 0 to 1; null when the host could not be read */
  fill: number | null
  /** "4.2", "62%"; "-" when unknown */
  text: string
  warn: boolean
}

const unit = (value: number): number => Math.min(Math.max(value, 0), 1)

/**
 * Load and swap are drawn against their ceilings (a full bar is the wall), memory against the RAM. Warn is `machineWords`'
 * logic: load over its ceiling, swap in use or swapped out over theirs; memory has no ceiling.
 */
export function hostMeters(
  machine: Pick<MachineModel, 'load' | 'loadCeiling' | 'memory' | 'memoryCeilings'> | undefined,
  newest: Pick<HostSample, 'memoryUsedPct'> | undefined,
): HostMeter[] {
  const load = machine?.load ?? null
  const memory = machine?.memory ?? null
  const ceilings = machine?.memoryCeilings
  const used = newest?.memoryUsedPct ?? null
  return [
    {
      key: 'load',
      label: 'Load',
      fill: load === null || !machine ? null : unit(load / machine.loadCeiling),
      text: load === null ? '-' : String(Math.round(load * 10) / 10),
      warn: load !== null && !!machine && load > machine.loadCeiling,
    },
    {
      key: 'memory',
      label: 'Memory',
      fill: used === null ? null : unit(used / 100),
      text: used === null ? '-' : `${Math.round(used)}%`,
      warn: false,
    },
    {
      key: 'swap',
      label: 'Swap',
      fill: memory === null || !ceilings ? null : unit(memory.swapUsedPct / ceilings.swapUsedPct),
      text: memory === null ? '-' : `${Math.round(memory.swapUsedPct)}%`,
      warn:
        memory !== null &&
        !!ceilings &&
        (memory.swapUsedPct > ceilings.swapUsedPct || memory.swapoutMbPer300s > ceilings.swapoutMbPer300s),
    },
  ]
}

const HOUR_MS = 60 * 60 * 1000
const MIN_MS = 60 * 1000

/** How long the server has been up: "3 d 4 h", "5 h 12 min", "12 min", "under a minute". */
export function uptimeWords(startedAt: string, now: Date): string {
  const ms = Math.max(0, now.getTime() - new Date(startedAt).getTime())
  const days = Math.floor(ms / DAY_MS)
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS)
  const minutes = Math.floor((ms % HOUR_MS) / MIN_MS)
  if (days > 0) return `${days} d ${hours} h`
  if (hours > 0) return `${hours} h ${minutes} min`
  if (minutes > 0) return `${minutes} min`
  return 'under a minute'
}

/** The span of a history in words for an axis end: "-24 h", "-5 h", "-40 min". */
export function spanLabel(ms: number): string {
  if (ms >= HOUR_MS) return `-${Math.round(ms / HOUR_MS)} h`
  return `-${Math.max(1, Math.round(ms / MIN_MS))} min`
}

/** The span the samples cover, in ms (0 for fewer than two). */
export function historySpan(samples: readonly Pick<HostSample, 'at'>[]): number {
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (!first || !last) return 0
  return new Date(last.at).getTime() - new Date(first.at).getTime()
}

/** "N h of history" for a history younger than a day; null once it covers (nearly) the full 24 hours. */
export function historyWords(samples: readonly Pick<HostSample, 'at'>[]): string | null {
  const span = historySpan(samples)
  if (span >= 23.5 * HOUR_MS) return null
  if (span >= HOUR_MS) return `${Math.round(span / HOUR_MS)} h of history`
  return `${Math.max(1, Math.round(span / MIN_MS))} min of history`
}

/** The stream in the owner's words. */
export function streamWords(connection: { live: boolean; offline: boolean }): string {
  if (connection.offline) return 'No connection to the server'
  return connection.live ? 'Connected to the event stream' : 'Polling every 15 s'
}
