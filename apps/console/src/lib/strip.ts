import type { HostSample, MachineModel, ReadAccountQuota } from '@software-factory/contract'
import { meterTone, type Tone } from '../components/kit/tone.ts'

const clampPct = (used: number): number => Math.min(Math.max(Math.round(used), 0), 100)

/** One account on the strip: the weekly share first; null when the account has no reading. */
export interface AccountMeter {
  account: string
  weeklyPct: number | null
  /** graphite until 75 %, warn from there, bad from 90 % or at the limit */
  tone: Tone
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
    tone: exhausted ? 'bad' : weeklyPct === null ? 'neutral' : meterTone(weeklyPct / 100),
    note: exhausted ? `at its limit until ${resetWords(quota.exhaustedUntil, now)}` : quota.fresh ? null : 'stale',
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

/** A reset in the owner's words and local time: "09:10" within a day, "Wednesday 16:00" after; "none" for no window. */
export function resetWords(iso: string | null, now: Date, weekday: 'long' | 'short' = 'long'): string {
  if (iso === null) return 'none'
  const at = new Date(iso)
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (at.getTime() - now.getTime() < DAY_MS) return time
  return `${at.toLocaleDateString('en-GB', { weekday })} ${time}`
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

/** One host meter on the strip: a label, a bar from 0 to 1, the figure as it reads, and its tone on that fill. */
export interface HostMeter {
  key: 'load' | 'memory' | 'swap'
  label: string
  /** 0 to 1; null when the host could not be read */
  fill: number | null
  /** "4.2", "62%"; "-" when unknown */
  text: string
  tone: Tone
}

const unit = (value: number): number => Math.min(Math.max(value, 0), 1)

/**
 * Load and swap are drawn against their ceilings (a full bar is the wall), memory against the RAM. The tone is `meterTone` on the
 * fill; swap is also bad when swapped out over its ceiling.
 */
export function hostMeters(
  machine: Pick<MachineModel, 'load' | 'loadCeiling' | 'memory' | 'memoryCeilings'> | undefined,
  newest: Pick<HostSample, 'memoryUsedPct'> | undefined,
): HostMeter[] {
  const load = machine?.load ?? null
  const memory = machine?.memory ?? null
  const ceilings = machine?.memoryCeilings
  const used = newest?.memoryUsedPct ?? null
  const loadFill = load === null || !machine ? null : unit(load / machine.loadCeiling)
  const memoryFill = used === null ? null : unit(used / 100)
  const swapFill = memory === null || !ceilings ? null : unit(memory.swapUsedPct / ceilings.swapUsedPct)
  const swappedOut = memory !== null && !!ceilings && memory.swapoutMbPer300s > ceilings.swapoutMbPer300s
  return [
    {
      key: 'load',
      label: 'Load',
      fill: loadFill,
      text: load === null ? '-' : String(Math.round(load * 10) / 10),
      tone: loadFill === null ? 'neutral' : meterTone(loadFill),
    },
    {
      key: 'memory',
      label: 'Memory',
      fill: memoryFill,
      text: used === null ? '-' : `${Math.round(used)}%`,
      tone: memoryFill === null ? 'neutral' : meterTone(memoryFill),
    },
    {
      key: 'swap',
      label: 'Swap',
      fill: swapFill,
      text: memory === null ? '-' : `${Math.round(memory.swapUsedPct)}%`,
      tone: swappedOut ? 'bad' : swapFill === null ? 'neutral' : meterTone(swapFill),
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

/** The stream in the owner's words. */
export function streamWords(connection: { live: boolean; offline: boolean; restarting?: boolean }): string {
  if (connection.restarting) return 'Server restarting, reconnecting'
  if (connection.offline) return 'No connection to the server'
  return connection.live ? 'Connected to the event stream' : 'Polling every 15 s'
}
