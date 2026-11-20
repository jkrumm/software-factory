import { homedir } from 'node:os'
import { join } from 'node:path'
import * as z from 'zod'
import { PROCESS_LOCK_WAIT_MS } from './adapters/postgres/process-lock.ts'
import { DEFAULT_RECHECK_MS, DEFAULT_RETRY_MS } from './domains/quality/watch.ts'
import { parseEnv, type Environment } from './kernel/env.ts'

const DEFAULT_SETTLE_MS = 2 * 60_000

const MIN_TOKEN_CHARS = 16
const token = z.string().min(MIN_TOKEN_CHARS, `must be at least ${MIN_TOKEN_CHARS} characters`)

const Env = z.object({
  /** the owner's API token; the server refuses to start with fewer than 16 characters */
  FACTORY_TOKEN: token,
  /** the token a lead's terminal calls the API with, never the owner's */
  FACTORY_AGENT_TOKEN: token.optional(),
  /** the token a door (a machine) calls the API with */
  FACTORY_DOOR_TOKEN: token.optional(),
  /** the token signals are filed with */
  FACTORY_SIGNAL_TOKEN: token.optional(),
  /** the token the orchestrator calls the API with */
  FACTORY_ORCHESTRATOR_TOKEN: token.optional(),
  /** a read-only token for the read API */
  FACTORY_READ_TOKEN: token.optional(),
  /** the Postgres database the server stores into (secrets-run supplies it) */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (from secrets-run)'),
  /** the port the API listens on, on loopback */
  PORT: z.coerce.number().int().min(1).max(65_535),
  /** the version the server reports; dev when unset */
  FACTORY_VERSION: z.string().min(1).optional(),
  /** how long a write waits for the process lock before it gives up */
  FACTORY_LOCK_WAIT_MS: z.coerce.number().int().min(0).optional(),
  /** how long after a read of the database facts `/health` serves from, the next starts; for the scenarios */
  FACTORY_HEALTH_PROBE_MS: z.coerce.number().int().min(50).optional(),
  /** the file the counting epoch is read from; unset, `config/throughput.json` */
  FACTORY_THROUGHPUT_FILE: z.string().optional(),
  /** the owner's Herdr groups file; unset, the one the Herdr app reads */
  FACTORY_PROJECT_GROUPS_FILE: z.string().optional(),
  /** 1 lets the test clock offset be set; only a scenario sets it */
  FACTORY_TEST_MODE: z.enum(['0', '1']).optional(),
  /** the agw binary the server calls for agent work */
  FACTORY_AGW_BIN: z.string().min(1).optional(),
  /** moves the server's clock by this many ms; honored only with FACTORY_TEST_MODE=1 */
  FACTORY_TEST_CLOCK_OFFSET_MS: z.coerce.number().int().optional(),
  /** how long a shipped change is watched for a regression; 0 is off */
  FACTORY_WATCH_WINDOW_MS: z.coerce.number().int().min(0).optional(),
  /** the wait before a failed verify is tried again */
  FACTORY_VERIFY_RETRY_MS: z.coerce.number().int().min(1).optional(),
  /** the gap between two verify checks of a shipped change */
  FACTORY_VERIFY_RECHECK_MS: z.coerce.number().int().min(1).optional(),
  /** how long a verify result must hold before it counts as settled */
  FACTORY_VERIFY_SETTLE_MS: z.coerce.number().int().min(0).optional(),
})

/** The bearer tokens by caller; a caller whose token is absent does not exist (`api/auth.ts`). */
export interface Tokens {
  owner: string
  agent?: string
  machine?: string
  signal?: string
  orchestrator?: string
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
  healthProbeMs: number
  /** the counting epoch's file; undefined is the tracked one */
  throughputFile: string | undefined
  /** the file the Herdr app's project groups are read from */
  projectGroupsFile: string
  /** the agw binary the review reads go through */
  agwBin: string
  /** moves the server's clock; only ever non-zero in a test (`FACTORY_TEST_MODE=1`), to reach a date a real clock would take 30 days to */
  clockOffsetMs: number
  /** the project's setting for the watch and verify, until the project file brings it (`domains/quality/watch.ts`) */
  quality: {
    /** how long a shipped change is watched before verify runs; the project's default is none */
    windowMs: number
    /** the first retry of a red check; it doubles for each one after */
    retryMs: number
    /** how long after a blocked check (a checkout not ours to move, CI still running) verify looks again */
    recheckMs: number
    /** how long after the server starts no check runs: a restart is a deploy */
    settleMs: number
  }
}

/** The server's settings from its environment; throws one message naming every bad key. */
export function loadSettings(env: Environment): Settings {
  const data = parseEnv(Env, env)
  if (data.FACTORY_TEST_CLOCK_OFFSET_MS !== undefined && data.FACTORY_TEST_MODE !== '1') {
    throw new Error('FACTORY_TEST_CLOCK_OFFSET_MS is honored only together with FACTORY_TEST_MODE=1: refusing to start')
  }
  const present: [string, string][] = []
  for (const key of [
    'FACTORY_TOKEN',
    'FACTORY_AGENT_TOKEN',
    'FACTORY_DOOR_TOKEN',
    'FACTORY_SIGNAL_TOKEN',
    'FACTORY_ORCHESTRATOR_TOKEN',
    'FACTORY_READ_TOKEN',
  ] as const) {
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
      ...(data.FACTORY_SIGNAL_TOKEN ? { signal: data.FACTORY_SIGNAL_TOKEN } : {}),
      ...(data.FACTORY_ORCHESTRATOR_TOKEN ? { orchestrator: data.FACTORY_ORCHESTRATOR_TOKEN } : {}),
      ...(data.FACTORY_READ_TOKEN ? { read: data.FACTORY_READ_TOKEN } : {}),
    },
    databaseUrl: data.DATABASE_URL,
    port: data.PORT,
    version: data.FACTORY_VERSION ?? 'dev',
    lockWaitMs: data.FACTORY_LOCK_WAIT_MS ?? PROCESS_LOCK_WAIT_MS,
    healthProbeMs: data.FACTORY_HEALTH_PROBE_MS ?? 10_000,
    agwBin: data.FACTORY_AGW_BIN ?? 'agw',
    clockOffsetMs: data.FACTORY_TEST_CLOCK_OFFSET_MS ?? 0,
    throughputFile: data.FACTORY_THROUGHPUT_FILE || undefined,
    projectGroupsFile: data.FACTORY_PROJECT_GROUPS_FILE || join(homedir(), '.config', 'herdr-app', 'groups.json'),
    quality: {
      windowMs: data.FACTORY_WATCH_WINDOW_MS ?? 0,
      retryMs: data.FACTORY_VERIFY_RETRY_MS ?? DEFAULT_RETRY_MS,
      recheckMs: data.FACTORY_VERIFY_RECHECK_MS ?? DEFAULT_RECHECK_MS,
      settleMs: data.FACTORY_VERIFY_SETTLE_MS ?? DEFAULT_SETTLE_MS,
    },
  }
}
