import { lstatSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'

/** The file `scripts/deploy.sh` holds for the length of a deploy: a symlink to the deploying pid. */
export const DEPLOY_LOCK = 'deploy.lock'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * When the running deploy took its lock, or null when none runs: no lock, a lock that cannot be read, or one whose
 * holder is dead (a deploy that crashed holds nothing). Two small system calls, no database: `/health` calls it on every request.
 */
export function deployingSince(dataDir: string): Date | null {
  const lock = join(dataDir, DEPLOY_LOCK)
  try {
    const pid = Number(readlinkSync(lock))
    if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return null
    return lstatSync(lock).mtime
  } catch {
    return null
  }
}
