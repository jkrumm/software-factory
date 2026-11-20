import * as z from 'zod'
import { parseEnv, type Environment } from '../kernel/env.ts'

export const DEFAULT_LONG_WAIT_MS = 3_600_000

const Env = z.object({
  /** a timed wait behind open Issues this long reaches Needs you */
  FACTORY_LONG_WAIT_MS: z.coerce.number().int().min(60_000).default(DEFAULT_LONG_WAIT_MS),
})

export interface NeedsSettings {
  /** a timed wait of at least this long, with other Issues held behind it, reaches Needs you */
  longWaitMs: number
}

/** Needs you's settings from the environment; throws one message when `FACTORY_LONG_WAIT_MS` is not a whole number of at least 60000. */
export function loadNeedsSettings(env: Environment): NeedsSettings {
  const e = parseEnv(Env, { FACTORY_LONG_WAIT_MS: env.FACTORY_LONG_WAIT_MS || undefined })
  return { longWaitMs: e.FACTORY_LONG_WAIT_MS }
}
