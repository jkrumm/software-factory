// A per-session lock around "read the spool, count, append" (the hook) and "sum, rotate" (the server). Two hooks of one
// session that overlap would count the same turns and write the same key, and the server would drop the second event.
// `mkdir` is the lock: atomic everywhere, no flock needed. Only node:fs, like the rest of what the hook loads.
import { mkdirSync, rmdirSync, statSync } from 'node:fs'

/** How long a holder may keep the lock before it is taken for a crashed one's. */
export const LOCK_STALE_MS = 2_000
const RETRY_MS = 5

/**
 * Takes `<file>.lock`, waiting up to `budgetMs`. Returns the release, or undefined when the budget ran out: the caller
 * then goes on without the lock (the hook with a key that cannot collide, the server by skipping its rotation).
 */
export async function tryLock(
  file: string,
  budgetMs: number,
  now: () => number = Date.now,
): Promise<(() => void) | undefined> {
  const path = `${file}.lock`
  const until = now() + budgetMs
  for (;;) {
    try {
      mkdirSync(path)
      return () => {
        try {
          rmdirSync(path)
        } catch {
          // already broken as stale: nothing to give back
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined
    }
    try {
      if (now() - statSync(path).mtimeMs > LOCK_STALE_MS) rmdirSync(path)
    } catch {
      // released between the two calls
    }
    if (now() >= until) return undefined
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
  }
}
