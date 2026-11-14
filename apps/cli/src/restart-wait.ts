import { lstatSync, readlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Patience } from '@software-factory/client'

/** How long a call waits for a server that is away: a restart of the one process is 10 to 60 s (`FACTORY_RESTART_WAIT_MS`). */
export const RESTART_WAIT_MS = 90_000

/** The same wait while a deploy of this host holds its lock with a live pid: the deploy's own limits, with its rollback, are minutes (`FACTORY_DEPLOY_WAIT_MS`). */
export const DEPLOY_WAIT_MS = 600_000

type Env = Record<string, string | undefined>

const milliseconds = (value: string | undefined, fallback: number): number => {
  const n = Number(value)
  return value !== undefined && value !== '' && Number.isFinite(n) && n >= 0 ? n : fallback
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Whether `scripts/deploy.sh` runs on this host: its lock under the data directory is a symlink to a live pid (the same
 * test as the server's `/health` `deploying`, apps/server/src/read/deploy-window.ts, which the CLI cannot import). A client
 * on another machine has no such file and waits the shorter time.
 */
export function deployRunning(env: Env): boolean {
  const dataDir =
    env.FACTORY_DATA_DIR || join(env.FACTORY_ROOT || join(env.HOME || homedir(), '.software-factory'), 'data')
  const lock = join(dataDir, 'deploy.lock')
  try {
    const pid = Number(readlinkSync(lock))
    return Number.isInteger(pid) && pid > 0 && alive(pid) && lstatSync(lock).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * How a CLI call waits out a restart: up to 90 s, up to 10 minutes while a deploy runs on this host (asked again before
 * every wait, so a deploy that begins during the wait stretches it). One stderr line the first time, none after.
 */
export function restartPatience(env: Env, err: (text: string) => void): Patience {
  const short = milliseconds(env.FACTORY_RESTART_WAIT_MS, RESTART_WAIT_MS)
  const long = milliseconds(env.FACTORY_DEPLOY_WAIT_MS, DEPLOY_WAIT_MS)
  return {
    limitMs: () => (deployRunning(env) ? Math.max(short, long) : short),
    onWait: () => err('server restarting (deploy), waiting\n'),
  }
}
