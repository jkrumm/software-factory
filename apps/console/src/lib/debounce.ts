/** The clock a debounce runs on; tests pass a fake one. */
export interface Scheduler {
  set(run: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export const realScheduler: Scheduler = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * A trailing debounce: a burst of `call()`s runs `run` once, `ms` after the last one. With `maxWaitMs`, a burst that never
 * pauses for `ms` still runs once `maxWaitMs` after its first call, so a steady stream cannot starve `run`.
 */
export function trailingDebounce(
  run: () => void,
  ms: number,
  scheduler: Scheduler = realScheduler,
  maxWaitMs?: number,
) {
  let trailing: unknown
  let ceiling: unknown
  let pending = false
  const clear = () => {
    scheduler.clear(trailing)
    scheduler.clear(ceiling)
    pending = false
  }
  const fire = () => {
    clear()
    run()
  }
  return {
    call() {
      if (pending) scheduler.clear(trailing)
      else if (maxWaitMs !== undefined) ceiling = scheduler.set(fire, maxWaitMs)
      pending = true
      trailing = scheduler.set(fire, ms)
    },
    cancel() {
      if (pending) clear()
    },
  }
}

export const BACKOFF_START_MS = 1_000
export const BACKOFF_MAX_MS = 30_000

/** The reconnect wait after `previous` (undefined for the first): 1 s, doubling, capped at 30 s. */
export const nextBackoff = (previous?: number): number =>
  previous === undefined ? BACKOFF_START_MS : Math.min(previous * 2, BACKOFF_MAX_MS)
