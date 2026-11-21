import { join } from 'node:path'
import * as z from 'zod'
import { parseEnv, type Environment } from './kernel/env.ts'
import { loadOwnersLine, type OwnersLine } from './adapters/ntfy/ntfy.ts'

const Env = z.object({
  /** the factory's data directory; artifact revisions are blobs under `<dir>/blobs`, never in git */
  FACTORY_DATA_DIR: z.string().min(1).optional(),
})

export interface CheckpointSettings {
  blobDir: string
  line: OwnersLine
}

/** The factory's data directory: `FACTORY_DATA_DIR`, else `.software-factory/data` under `home` (the leads' settings read `HOME`). */
export function factoryDataDir(env: Environment, options: { home: string }): string {
  const e = parseEnv(Env, env)
  return e.FACTORY_DATA_DIR ?? join(options.home, '.software-factory', 'data')
}

/** The checkpoints domain's settings from the environment (`FACTORY_NTFY_URL`, `FACTORY_NTFY_TOPIC`, `NTFY_TOKEN`, `FACTORY_CONSOLE_URL` are the owner's line's). */
export function loadCheckpointSettings(env: Environment, options: { home: string }): CheckpointSettings {
  return {
    blobDir: join(factoryDataDir(env, options), 'blobs'),
    line: loadOwnersLine(env),
  }
}
