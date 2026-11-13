import type { Clock } from '../kernel/clock.ts'

/** After a server start, at most one note or nudge typed into a lead per this long (Issue 1039). */
export const TYPE_GAP_MS = 10_000
/** How long after the server's start the gap is kept: the backlog of a restart or a boot drains in this time. */
export const TYPE_WINDOW_MS = 10 * 60_000

export type TypePace = () => Promise<void>

/**
 * A pacer for what is typed into leads: while the server is younger than `windowMs`, each call waits until `gapMs`
 * have passed since the one before, so the notes and nudges that were due while the host booted do not all land at once.
 * Calls are served in order; after the window it never waits. No transaction is open where it is called (a port is
 * never called inside one), so the wait holds nothing.
 */
export function typePacer(input: {
  clock: Clock
  gapMs?: number
  windowMs?: number
  sleep?: (ms: number) => Promise<void>
}): TypePace {
  const gapMs = input.gapMs ?? TYPE_GAP_MS
  const windowMs = input.windowMs ?? TYPE_WINDOW_MS
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const startedAt = input.clock.now().getTime()
  let nextAt = 0
  let queue: Promise<void> = Promise.resolve()
  return () => {
    const turn = queue.then(async () => {
      const now = input.clock.now().getTime()
      if (now - startedAt >= windowMs) return
      const wait = nextAt - now
      if (wait > 0) await sleep(wait)
      nextAt = Math.max(now, nextAt) + gapMs
    })
    queue = turn.catch(() => undefined)
    return turn
  }
}
