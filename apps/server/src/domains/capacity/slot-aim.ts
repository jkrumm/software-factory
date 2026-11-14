/** `FACTORY_SLOT_AIM`: `off` leaves the live rule alone, `shadow` records what the aim would do beside it, `on` grants by the aim. */
export type AimMode = 'off' | 'shadow' | 'on'

/** How long the host stays at pressure level 1 with swap steady before the aim adds a slot. */
export const AIM_QUIET_MS = 5 * 60_000
/** Samples (one a minute, newest first) the swap in use is judged over. */
export const SWAP_WINDOW = 5
/** Swap in use must rise by this many percentage points of RAM across the window to count as growing. */
export const SWAP_GROWTH_PCT = 0.5
/** No slot is added while the 1-minute load is above this many times the cores. */
export const LOAD_PER_CORE = 2

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
  cores: number
  /** callers in line for a slot */
  waiters: number
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
 * and one more slot is added after five quiet minutes at level 1 with a waiter in line and the load within twice the
 * cores. An unread pressure level holds the count and counts as not quiet.
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
  if (pressureLevel === null) return { state: { target, quietSince: null }, reason: 'pressure not read: held' }

  const quietSince = state.quietSince ?? at
  const quietMs = at.getTime() - quietSince.getTime()
  if (quietMs < AIM_QUIET_MS) return { state: { target, quietSince }, reason: 'quiet, waiting out 5 minutes' }
  if (target >= ceiling) return { state: { target, quietSince }, reason: `quiet, at the ceiling of ${ceiling}` }
  if (signals.waiters === 0) return { state: { target, quietSince }, reason: 'quiet, nobody waits' }
  if (signals.load === null || signals.load > LOAD_PER_CORE * signals.cores)
    return {
      state: { target, quietSince },
      reason: `quiet, load ${signals.load ?? 'unread'} is over ${LOAD_PER_CORE * signals.cores} (${LOAD_PER_CORE}x the cores)`,
    }
  return {
    state: { target: target + 1, quietSince: at },
    reason: `quiet 5 minutes with a waiter: ${target} to ${target + 1}`,
  }
}
