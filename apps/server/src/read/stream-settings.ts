import * as z from 'zod'
import { parseEnv, type Environment } from '../kernel/env.ts'

const DEFAULT_POLL_MS = 1000

const Env = z.object({
  /** how often the change stream polls, 10 to 60000 ms */
  FACTORY_STREAM_POLL_MS: z.coerce.number().int().min(10).max(60_000).default(DEFAULT_POLL_MS),
})

export interface StreamSettings {
  /** how often the stream looks for new changes */
  pollMs: number
}

/** The change stream's settings from the environment; throws one message when `FACTORY_STREAM_POLL_MS` is not a whole number of 10 to 60000. */
export function loadStreamSettings(env: Environment): StreamSettings {
  const e = parseEnv(Env, { FACTORY_STREAM_POLL_MS: env.FACTORY_STREAM_POLL_MS || undefined })
  return { pollMs: e.FACTORY_STREAM_POLL_MS }
}
