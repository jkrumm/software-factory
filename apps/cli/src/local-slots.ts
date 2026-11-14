import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { reason, releaseLock, tryTake } from './pid-lock.ts'

/** The base of the server's slots (`FACTORY_SLOTS`): how many commands a host runs at once while the server is gone. */
const DEFAULT_LOCAL_SLOTS = 2
const MAX_LOCAL_SLOTS = 64

type Env = Record<string, string | undefined>

/** What one try at the host-local slots came to. `unavailable`: they cannot be used at all, the caller runs without one. */
export type LocalTry = 'taken' | 'held' | { unavailable: string }

/**
 * The slots a host hands out while the server does not answer: `FACTORY_SLOTS` (default 2) lock files in
 * `FACTORY_LOCAL_SLOT_DIR` (default `~/.local/state/factory/local-slots`), each a symlink to its holder's pid, taken the way
 * the deploy lock is (a holder that is dead is reclaimed, so a crashed caller never blocks the next). They keep a dead
 * factory from being flooded by every waiting step at once, and never block the work that repairs it.
 */
export function localSlots(env: Env): { take: () => LocalTry; release: () => void; count: number } {
  const n = Math.floor(Number(env.FACTORY_SLOTS))
  const count = Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_LOCAL_SLOTS) : DEFAULT_LOCAL_SLOTS
  const dir = env.FACTORY_LOCAL_SLOT_DIR || join(env.HOME || homedir(), '.local/state/factory/local-slots')
  let held: string | undefined
  return {
    count,
    take: () => {
      try {
        mkdirSync(dir, { recursive: true })
      } catch (error) {
        return { unavailable: `cannot create ${dir}: ${reason(error)}` }
      }
      for (let slot = 1; slot <= count; slot++) {
        const lock = join(dir, `slot-${slot}.lock`)
        // `retry` is a lock released or retaken while looked at: asked again at once, a few times.
        for (let again = 0; again < 5; again++) {
          const outcome = tryTake(lock)
          if (outcome === 'taken') {
            held = lock
            return 'taken'
          }
          if (outcome === 'retry') continue
          if ('failed' in outcome && !outcome.transient) return { unavailable: outcome.failed }
          break
        }
      }
      return 'held'
    },
    release: () => {
      if (held) releaseLock(held)
      held = undefined
    },
  }
}
