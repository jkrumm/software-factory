import { join } from 'node:path'
import * as z from 'zod'
import { loadOwnersLine, type OwnersLine } from './adapters/ntfy/ntfy.ts'

const Env = z.object({
  /** the factory's data directory; artifact revisions are blobs under `<dir>/blobs`, never in git */
  FACTORY_DATA_DIR: z.string().min(1).optional(),
  HOME: z.string().optional(),
  /** how often the server settles open Decisions and sends pages by itself; 0 leaves it to the loops' tick and `checkpoint pass` */
  FACTORY_CHECKPOINT_PASS_MS: z.coerce.number().int().min(0).default(30_000),
  FACTORY_AGW_BIN: z.string().min(1).default('agw'),
  /** a stand-in for `project.yaml`'s standing policy until package 3: a JSON file of rules per repo */
  FACTORY_CHECKPOINT_POLICY_FILE: z.string().min(1).optional(),
})

export interface CheckpointSettings {
  blobDir: string
  passMs: number
  agwBin: string
  policyFile: string | null
  line: OwnersLine
}

/** The checkpoints domain's settings from the environment (`FACTORY_NTFY_URL`, `FACTORY_NTFY_TOPIC`, `NTFY_TOKEN`, `FACTORY_CONSOLE_URL` are the owner's line's). */
export function loadCheckpointSettings(env: Record<string, string | undefined>): CheckpointSettings {
  const parsed = Env.safeParse(env)
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '))
  }
  const dataDir = parsed.data.FACTORY_DATA_DIR ?? join(parsed.data.HOME ?? '/tmp', '.software-factory', 'data')
  return {
    blobDir: join(dataDir, 'blobs'),
    passMs: parsed.data.FACTORY_CHECKPOINT_PASS_MS,
    agwBin: parsed.data.FACTORY_AGW_BIN,
    policyFile: parsed.data.FACTORY_CHECKPOINT_POLICY_FILE ?? null,
    line: loadOwnersLine(env),
  }
}
