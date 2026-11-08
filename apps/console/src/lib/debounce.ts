/** The clock a debounce runs on; tests pass a fake one. */
export interface Scheduler {
  set(run: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export const realScheduler: Scheduler = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** A trailing debounce: a burst of `call()`s runs `run` once, `ms` after the last one. */
export function trailingDebounce(run: () => void, ms: number, scheduler: Scheduler = realScheduler) {
  let handle: unknown
  let pending = false
  return {
    call() {
      if (pending) scheduler.clear(handle)
      pending = true
      handle = scheduler.set(() => {
        pending = false
        run()
      }, ms)
    },
    cancel() {
      if (!pending) return
      scheduler.clear(handle)
      pending = false
    },
  }
}

export const BACKOFF_START_MS = 1_000
export const BACKOFF_MAX_MS = 30_000

/** The reconnect wait after `previous` (undefined for the first): 1 s, doubling, capped at 30 s. */
export const nextBackoff = (previous?: number): number =>
  previous === undefined ? BACKOFF_START_MS : Math.min(previous * 2, BACKOFF_MAX_MS)
