import { describeTrip, type LoadTrip } from './host.ts'

/** `FACTORY_SLOT_AIM`: `off` leaves the live rule alone, `shadow` records what the aim would do beside it, `on` grants by the aim. */
export type AimMode = 'off' | 'shadow' | 'on'

/** How long the host stays at pressure level 1 with swap steady before the aim adds a slot. */
export const AIM_QUIET_MS = 5 * 60_000
/** Samples (one a minute, newest first) the swap in use is judged over. */
export const SWAP_WINDOW = 5
/** Swap in use must rise by this many percentage points of RAM across the window to count as growing. */
const SWAP_GROWTH_PCT = 0.5

export interface AimState {
  /** the slots the aim allows, between 1 and the ceiling */
  target: number
  /** since when the host has been quiet (level 1, swap steady); null while it is not */
  quietSince: Date | null
}

export interface AimSignals {
  at: Date
  /** `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical; null when unread */
  pressureLevel: number | null
  swapGrowing: boolean
  load: number | null
  /** the load tripwire over the minute samples (`loadTrip`): no slot is added while it is tripped; null: too few samples */
  loadTrip: LoadTrip
  /** the load ceiling the tripwire is set at, for the reason's words */
  loadCeiling: number
  /** callers in line for a slot */
  waiters: number
  /** the swapouts of the last 300 s are over their ceiling (`sustainedSwapoutMb`); absent: not over */
  swapouts?: boolean
}

export interface AimStep {
  state: AimState
  reason: string
}

/** Whether swap in use grew over the newest samples (newest first): the newest reading is above the lowest of the older ones by the growth threshold. */
export function swapGrowing(samplesNewestFirst: readonly { swapUsedPct: number | null }[]): boolean {
  const window = samplesNewestFirst
    .slice(0, SWAP_WINDOW)
    .map((s) => s.swapUsedPct)
    .filter((pct): pct is number => pct !== null)
  const [newest, ...older] = window
  if (newest === undefined || older.length === 0) return false
  return newest - Math.min(...older) >= SWAP_GROWTH_PCT
}

/**
 * One minute of the aim, AIMD on the host's pressure: level 4 drops to one slot, level 2 or swap growing halves the count,
 * and one more slot is added after five quiet minutes at level 1 with a waiter in line and the load tripwire clear (a
 * peak over the ceiling adds nothing to the count's caution; minutes on end over it do). An unread pressure level holds
 * the count and counts as not quiet.
 */
export function aimStep(state: AimState, signals: AimSignals, ceiling: number): AimStep {
  const target = Math.min(Math.max(1, state.target), ceiling)
  const { at, pressureLevel } = signals
  if (pressureLevel === 4) return { state: { target: 1, quietSince: null }, reason: 'pressure level 4: down to 1 slot' }
  if (pressureLevel !== null && pressureLevel >= 2)
    return {
      state: { target: Math.max(1, Math.floor(target / 2)), quietSince: null },
      reason: `pressure level ${pressureLevel}: halved`,
    }
  if (signals.swapGrowing)
    return { state: { target: Math.max(1, Math.floor(target / 2)), quietSince: null }, reason: 'swap growing: halved' }
  if (signals.swapouts)
    return {
      state: { target: Math.max(1, Math.floor(target / 2)), quietSince: null },
      reason: 'swapouts over the ceiling: halved',
    }
  if (pressureLevel === null) return { state: { target, quietSince: null }, reason: 'pressure not read: held' }

  const quietSince = state.quietSince ?? at
  const quietMs = at.getTime() - quietSince.getTime()
  if (quietMs < AIM_QUIET_MS) return { state: { target, quietSince }, reason: 'quiet, waiting out 5 minutes' }
  if (target >= ceiling) return { state: { target, quietSince }, reason: `quiet, at the ceiling of ${ceiling}` }
  if (signals.waiters === 0) return { state: { target, quietSince }, reason: 'quiet, nobody waits' }
  if (signals.load === null) return { state: { target, quietSince }, reason: 'quiet, load unread' }
  if (signals.loadTrip?.tripped)
    return {
      state: { target, quietSince },
      reason: `quiet, but ${describeTrip(signals.loadTrip.loads, signals.loadCeiling)}`,
    }
  return {
    state: { target: target + 1, quietSince: at },
    reason: `quiet 5 minutes with a waiter: ${target} to ${target + 1}`,
  }
}

/** How long the host stays quiet before the lead aim adds a lead, and again after each one (a lead's burst shows within two samples). */
export const LEAD_AIM_STEP_MS = 2 * 60_000

/** The count of leads the host takes, and since when it has been quiet (null while it is not). */
export interface LeadAim {
  target: number
  since: Date | null
}

export interface LeadAimSignals {
  at: Date
  /** `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical; null when unread */
  pressureLevel: number | null
  swapGrowing: boolean
  /** the swapouts of the last 300 s are over their ceiling */
  swapouts: boolean
  load: number | null
  loadTrip: LoadTrip
  loadCeiling: number
  /** leads running now: the claims held (a lead resumed from a wait takes its claim back and counts then) */
  running: number
  /** queued Issues that only the aim holds back (every other rule would let them in) */
  waiting: number
}

/**
 * One minute of the lead aim, the slot aim's own rule over leads: the host's pressure (level 2 or 4, swap growing, swapouts over
 * the ceiling) halves what is running, never below one lead, and one lead is added after two quiet minutes at level 1 when the
 * count binds (as many leads run as the aim allows) with a lead the aim itself holds back in the queue and the load tripwire clear. An unread pressure
 * holds the count and counts as not quiet. The first minute seeds the count at the leads running: the aim never starts
 * above what the host was already taking. Leads already running are never touched; the count only gates new ones.
 */
export function leadAimStep(state: LeadAim | null, signals: LeadAimSignals): { state: LeadAim; reason: string } {
  const target = Math.max(1, state?.target ?? signals.running)
  const { at, pressureLevel, running } = signals
  const halved = (why: string) => ({
    state: { target: Math.max(1, Math.floor(Math.min(target, Math.max(1, running)) / 2)), since: null },
    reason: `${why}: halved`,
  })
  if (pressureLevel !== null && pressureLevel >= 2) return halved(`pressure level ${pressureLevel}`)
  if (signals.swapGrowing) return halved('swap growing')
  if (signals.swapouts) return halved('swapouts over the ceiling')
  if (pressureLevel === null) return { state: { target, since: null }, reason: 'pressure not read: held' }

  const since = state?.since ?? at
  if (at.getTime() - since.getTime() < LEAD_AIM_STEP_MS)
    return { state: { target, since }, reason: 'quiet, waiting out 2 minutes' }
  // No ceiling: the count only grows while as many leads run as it allows, so it stays within one of the leads the accounts' caps let run.
  if (running < target) return { state: { target, since }, reason: `quiet, ${running} of ${target} leads run` }
  if (signals.waiting === 0) return { state: { target, since }, reason: 'quiet, no queued lead waits for the aim' }
  if (signals.load === null) return { state: { target, since }, reason: 'quiet, load unread' }
  if (signals.loadTrip?.tripped)
    return {
      state: { target, since },
      reason: `quiet, but ${describeTrip(signals.loadTrip.loads, signals.loadCeiling)}`,
    }
  return {
    state: { target: target + 1, since: at },
    reason: `quiet 2 minutes, ${running} leads run: ${target} to ${target + 1}`,
  }
}
