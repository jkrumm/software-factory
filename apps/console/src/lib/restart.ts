/** A deploy stops and starts the one server process: how long the Console waits for it before it says Offline. */
export const RESTART_WINDOW_MS = 3 * 60_000
const RETRY_START_MS = 1_000
const RETRY_MAX_MS = 10_000

export type Phase = 'ok' | 'restarting' | 'offline'

/**
 * The stream dropped or a fetch failed with a network error (`failingSince`, epoch ms of the first of them; null when
 * nothing failed): that is a restart for `RESTART_WINDOW_MS`, then Offline. A browser that is offline is Offline.
 */
export function restartPhase({
  failingSince,
  online,
  now,
}: {
  failingSince: number | null
  online: boolean
  now: number
}): Phase {
  if (!online) return 'offline'
  if (failingSince === null) return 'ok'
  return now - failingSince < RESTART_WINDOW_MS ? 'restarting' : 'offline'
}

/** A fetch that never got an answer (the server is down): `fetch` rejects with a `TypeError`, an HTTP status is not one. */
export const isNetworkError = (error: unknown): boolean => error instanceof TypeError

/** react-query's retry delay: 1 s, doubling, capped at 10 s. */
export const retryDelay = (count: number): number => Math.min(RETRY_START_MS * 2 ** count, RETRY_MAX_MS)

let failingSince: number | null = null
const listeners = new Set<() => void>()
const notify = () => {
  for (const listener of listeners) listener()
}

export const subscribeFailing = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export const getFailingSince = (): number | null => failingSince

/** The stream dropped or a fetch got no answer; only the first of a run counts, the window runs from it. */
export function markFailing(now = Date.now()): void {
  if (failingSince !== null) return
  failingSince = now
  notify()
}

/** The stream greeted again or a fetch was answered. */
export function markRecovered(): void {
  if (failingSince === null) return
  failingSince = null
  notify()
}

/** A network error is retried (with `retryDelay`) while the restart window is open. */
export const retryNetworkError = (error: unknown, now = Date.now()): boolean =>
  isNetworkError(error) && restartPhase({ failingSince, online: true, now }) === 'restarting'
