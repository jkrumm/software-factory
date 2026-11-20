import { join } from 'node:path'
import * as z from 'zod'
import { parseEnv, type Environment } from './kernel/env.ts'
import { loadOwnersLine, type OwnersLine } from './adapters/ntfy/ntfy.ts'

const Env = z.object({
  /** the factory's data directory; artifact revisions are blobs under `<dir>/blobs`, never in git */
  FACTORY_DATA_DIR: z.string().min(1).optional(),
  /** the home directory the defaults are built from */
  HOME: z.string().optional(),
})

export interface CheckpointSettings {
  blobDir: string
  line: OwnersLine
}

/** The factory's data directory: `FACTORY_DATA_DIR`, else `$HOME/.software-factory/data`. */
export function factoryDataDir(env: Environment): string {
  const e = parseEnv(Env, env)
  return e.FACTORY_DATA_DIR ?? join(e.HOME ?? '/tmp', '.software-factory', 'data')
}

/** The checkpoints domain's settings from the environment (`FACTORY_NTFY_URL`, `FACTORY_NTFY_TOPIC`, `NTFY_TOKEN`, `FACTORY_CONSOLE_URL` are the owner's line's). */
export function loadCheckpointSettings(env: Environment): CheckpointSettings {
  return {
    blobDir: join(factoryDataDir(env), 'blobs'),
    line: loadOwnersLine(env),
  }
}
