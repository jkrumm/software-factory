import * as z from 'zod'
import { PROCESS_LOCK_WAIT_MS } from './adapters/postgres/process-lock.ts'
import { DEFAULT_RETRY_MS } from './domains/quality/watch.ts'

const DEFAULT_SETTLE_MS = 2 * 60_000

const MIN_TOKEN_CHARS = 16
const token = z.string().min(MIN_TOKEN_CHARS, `must be at least ${MIN_TOKEN_CHARS} characters`)

const Env = z.object({
  FACTORY_TOKEN: token,
  FACTORY_AGENT_TOKEN: token.optional(),
  FACTORY_DOOR_TOKEN: token.optional(),
  FACTORY_READ_TOKEN: token.optional(),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (from secrets-run)'),
  PORT: z.coerce.number().int().min(1).max(65_535),
  FACTORY_VERSION: z.string().min(1).optional(),
  FACTORY_LOCK_WAIT_MS: z.coerce.number().int().min(0).optional(),
  FACTORY_INTERNAL_TEST_ROUTES: z.enum(['0', '1']).optional(),
  FACTORY_AGW_BIN: z.string().min(1).optional(),
  FACTORY_CLOCK_OFFSET_MS: z.coerce.number().int().optional(),
  FACTORY_WATCH_WINDOW_MS: z.coerce.number().int().min(0).optional(),
  FACTORY_VERIFY_RETRY_MS: z.coerce.number().int().min(1).optional(),
  FACTORY_VERIFY_SETTLE_MS: z.coerce.number().int().min(0).optional(),
})

/** The bearer tokens by caller; a caller whose token is absent does not exist (`api/auth.ts`). */
export interface Tokens {
  owner: string
  agent?: string
  machine?: string
  read?: string
}

export interface Settings {
  tokens: Tokens
  databaseUrl: string
  /** the loopback API port */
  port: number
  /** the deployed commit; `dev` outside a release */
  version: string
  /** how long a second copy waits for the process lock before it exits 1; the scenarios shorten it */
  lockWaitMs: number
  /** mounts `/internal/test/...`, the scenarios' entry into the write path until package 8 deletes it */
  internalTestRoutes: boolean
  /** the agw binary the review reads go through */
  agwBin: string
  /** moves the server's clock; the scenarios use it to reach a date a real clock would take 30 days to */
  clockOffsetMs: number
  /** the project's setting for the watch and verify, until the project file brings it (`domains/quality/watch.ts`) */
  quality: {
    /** how long a shipped change is watched before verify runs; the project's default is none */
    windowMs: number
    /** the first retry of a red check; it doubles for each one after */
    retryMs: number
    /** how long after the server starts no check runs: a restart is a deploy */
    settleMs: number
  }
}

/** The server's settings from its environment; throws one message naming every bad key. */
export function loadSettings(env: Record<string, string | undefined>): Settings {
  const parsed = Env.safeParse(env)
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '))
  }
  const data = parsed.data
  const present: [string, string][] = []
  for (const key of ['FACTORY_TOKEN', 'FACTORY_AGENT_TOKEN', 'FACTORY_DOOR_TOKEN', 'FACTORY_READ_TOKEN'] as const) {
    const value = data[key]
    if (value !== undefined) present.push([key, value])
  }
  for (const [i, [keyA, valueA]] of present.entries()) {
    const twin = present.slice(i + 1).find(([, valueB]) => valueA === valueB)
    if (twin) throw new Error(`${keyA} and ${twin[0]} are the same token: every caller needs its own`)
  }
  return {
    tokens: {
      owner: data.FACTORY_TOKEN,
      ...(data.FACTORY_AGENT_TOKEN ? { agent: data.FACTORY_AGENT_TOKEN } : {}),
      ...(data.FACTORY_DOOR_TOKEN ? { machine: data.FACTORY_DOOR_TOKEN } : {}),
      ...(data.FACTORY_READ_TOKEN ? { read: data.FACTORY_READ_TOKEN } : {}),
    },
    databaseUrl: parsed.data.DATABASE_URL,
    port: parsed.data.PORT,
    version: parsed.data.FACTORY_VERSION ?? 'dev',
    lockWaitMs: parsed.data.FACTORY_LOCK_WAIT_MS ?? PROCESS_LOCK_WAIT_MS,
    internalTestRoutes: parsed.data.FACTORY_INTERNAL_TEST_ROUTES === '1',
    agwBin: parsed.data.FACTORY_AGW_BIN ?? 'agw',
    clockOffsetMs: parsed.data.FACTORY_CLOCK_OFFSET_MS ?? 0,
    quality: {
      windowMs: parsed.data.FACTORY_WATCH_WINDOW_MS ?? 0,
      retryMs: parsed.data.FACTORY_VERIFY_RETRY_MS ?? DEFAULT_RETRY_MS,
      settleMs: parsed.data.FACTORY_VERIFY_SETTLE_MS ?? DEFAULT_SETTLE_MS,
    },
  }
}
