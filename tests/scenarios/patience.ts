import { cpus, loadavg } from 'node:os'

/** The most a wait stretches: a host this loaded is slow, not stuck, and a wait that never ends hides a real hang. */
const MOST = 12

/**
 * A wait in ms for an event, stretched by how loaded the machine is right now (1-minute load per core, at least 1):
 * a deadline that holds on an idle host turned into a false red at load 40 (Issue 719). The events are awaited, not counted.
 */
export function patient(ms: number): number {
  const perCore = (loadavg()[0] ?? 0) / Math.max(1, cpus().length)
  return Math.round(ms * Math.min(MOST, Math.max(1, perCore)))
}
