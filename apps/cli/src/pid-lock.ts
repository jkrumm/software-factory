import { lstatSync, mkdirSync, readlinkSync, rmdirSync, rmSync, symlinkSync } from 'node:fs'

/** A lock path that reads EINVAL (not yet a readable symlink) is read again this often, for at most ~1 s. */
const READ_RETRIES = 100
const READ_RETRY_MS = 10

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const exists = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

export const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The pid a lock names, `gone` when it was released a moment ago, or why it cannot be read (never reclaimed). */
function holderOf(lock: string): { pid: number } | { gone: true } | { unreadable: string } {
  let target: string | undefined
  // EINVAL ("not a symlink") on a path another process just created or replaced is transient under load: the link is
  // not readable yet. Read again for a moment; one that stays a non-link is unreadable, never reclaimed.
  for (let attempt = 0; target === undefined; attempt++) {
    try {
      target = readlinkSync(lock)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return { gone: true }
      if (code !== 'EINVAL' || attempt >= READ_RETRIES) return { unreadable: reason(error) }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, READ_RETRY_MS)
    }
  }
  return /^[0-9]+$/.test(target) && Number(target) > 0
    ? { pid: Number(target) }
    : { unreadable: `its target is "${target}", not a pid` }
}

/**
 * One try at a pid lock, a symlink to our pid (`symlinkSync` is atomic and the pid is in place from the first moment).
 * `taken`: ours. `held`: a live process has it. `retry`: it was released or retaken while we looked, look again at once.
 * `failed`: it cannot be created or read; `transient` marks a reclaim another caller is in the middle of, which a later
 * try may find done.
 * A holder that is dead is reclaimed, one reclaimer at a time (`<lock>.reclaim`, a `mkdir`).
 */
export function tryTake(lock: string): 'taken' | 'retry' | { held: number } | { failed: string; transient?: true } {
  try {
    symlinkSync(String(process.pid), lock)
    return 'taken'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { failed: `cannot create ${lock}: ${reason(error)}` }
  }
  const holder = holderOf(lock)
  if ('gone' in holder) return 'retry'
  if ('unreadable' in holder) return { failed: `cannot read ${lock}: ${holder.unreadable}` }
  if (alive(holder.pid)) return { held: holder.pid }

  const reclaim = `${lock}.reclaim`
  try {
    mkdirSync(reclaim)
  } catch (error) {
    return {
      failed: `cannot reclaim ${lock}: ${reclaim} (${reason(error)}); someone else is reclaiming, or a crashed reclaim needs a manual rm`,
      transient: true,
    }
  }
  try {
    // Under the reclaim lock: look again, and remove the lock only if its holder is still dead.
    if (exists(lock)) {
      const again = holderOf(lock)
      if ('unreadable' in again) return { failed: `cannot read ${lock}: ${again.unreadable}` }
      if ('pid' in again) {
        if (alive(again.pid)) return { held: again.pid }
        rmSync(lock, { force: true })
      }
    }
    symlinkSync(String(process.pid), lock)
    return 'taken'
  } catch (error) {
    // Taking needs no reclaim lock, so another caller may have taken it since the removal: look again.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'retry'
    return { failed: `cannot take ${lock}: ${reason(error)}` }
  } finally {
    rmdirSync(reclaim)
  }
}

/** Removes the lock only while it still names this process. */
export function releaseLock(lock: string): void {
  const holder = holderOf(lock)
  if ('pid' in holder && holder.pid === process.pid) rmSync(lock, { force: true })
}
