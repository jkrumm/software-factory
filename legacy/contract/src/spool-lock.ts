// A per-session lock around "read the spool, count, append" (the hook) and "sum, rotate" (the server). Two hooks of one
// session that overlap would count the same turns and write the same key, and the server would drop the second event.
// `mkdir` is the lock: atomic everywhere, no flock needed. Only node:fs, like the rest of what the hook loads.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'

/** How long a holder may keep the lock before it is taken for a crashed one's. Holders keep it for milliseconds. */
export const LOCK_STALE_MS = 2_000
const RETRY_MS = 5

/**
 * Takes `<file>.lock`, waiting up to `budgetMs`. Returns the release, or undefined when the budget ran out: the caller
 * then goes on without the lock (the hook with a key that cannot collide, the server by skipping its rotation).
 *
 * The holder writes a token into the lock; a release removes the lock only while the token is still its own, so a
 * holder whose lock was broken as stale cannot remove its successor's. A stale lock is broken by moving it aside
 * (atomic), never by removing it in place.
 */
export async function tryLock(
  file: string,
  budgetMs: number,
  now: () => number = Date.now,
): Promise<(() => void) | undefined> {
  const path = `${file}.lock`
  const until = now() + budgetMs
  const token = `${process.pid}.${Math.random().toString(36).slice(2)}`
  for (;;) {
    try {
      mkdirSync(path)
      writeFileSync(`${path}/owner`, token)
      return () => {
        try {
          if (readFileSync(`${path}/owner`, 'utf8') !== token) return
          unlinkSync(`${path}/owner`)
          rmSync(path, { recursive: true })
        } catch {
          // already broken as stale, or released: nothing to give back
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined
    }
    try {
      if (now() - statSync(path).mtimeMs > LOCK_STALE_MS) {
        const aside = `${path}.stale.${token}`
        renameSync(path, aside)
        rmSync(aside, { recursive: true, force: true })
      }
    } catch {
      // released or broken by someone else between the two calls
    }
    if (now() >= until) return undefined
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
  }
}
