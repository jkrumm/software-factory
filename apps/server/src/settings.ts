import * as z from 'zod'
import { PROCESS_LOCK_WAIT_MS } from './adapters/postgres/process-lock.ts'

const Env = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (from secrets-run)'),
  PORT: z.coerce.number().int().min(1).max(65_535),
  FACTORY_VERSION: z.string().min(1).optional(),
  FACTORY_LOCK_WAIT_MS: z.coerce.number().int().min(0).optional(),
  FACTORY_INTERNAL_TEST_ROUTES: z.enum(['0', '1']).optional(),
})

export interface Settings {
  databaseUrl: string
  /** the loopback API port */
  port: number
  /** the deployed commit; `dev` outside a release */
  version: string
  /** how long a second copy waits for the process lock before it exits 1; the scenarios shorten it */
  lockWaitMs: number
  /** mounts `/internal/test/...`, the scenarios' entry into the write path until package 8 deletes it */
  internalTestRoutes: boolean
}

/** The server's settings from its environment; throws one message naming every bad key. */
export function loadSettings(env: Record<string, string | undefined>): Settings {
  const parsed = Env.safeParse(env)
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '))
  }
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    port: parsed.data.PORT,
    version: parsed.data.FACTORY_VERSION ?? 'dev',
    lockWaitMs: parsed.data.FACTORY_LOCK_WAIT_MS ?? PROCESS_LOCK_WAIT_MS,
    internalTestRoutes: parsed.data.FACTORY_INTERNAL_TEST_ROUTES === '1',
  }
}
