import * as z from 'zod'
import { parseEnv, type Environment } from '../../kernel/env.ts'

const Env = z.object({
  FACTORY_UPTIME_URL: z.string().min(1).optional(),
  FACTORY_UPTIME_TOKEN: z.string().min(1).optional(),
  FACTORY_UPTIME_EVERY_MS: z.coerce.number().int().min(1000).default(60_000),
})

export interface UptimeEnv {
  /** `FACTORY_UPTIME_URL`; unset, the feature is off */
  url: string | null
  token: string | null
  everyMs: number
}

/** The uptime poller's settings from the environment; throws one message naming every bad key. */
export function loadUptimeEnv(env: Environment): UptimeEnv {
  const e = parseEnv(Env, {
    FACTORY_UPTIME_URL: env.FACTORY_UPTIME_URL || undefined,
    FACTORY_UPTIME_TOKEN: env.FACTORY_UPTIME_TOKEN || undefined,
    FACTORY_UPTIME_EVERY_MS: env.FACTORY_UPTIME_EVERY_MS || undefined,
  })
  return {
    url: e.FACTORY_UPTIME_URL ?? null,
    token: e.FACTORY_UPTIME_TOKEN ?? null,
    everyMs: e.FACTORY_UPTIME_EVERY_MS,
  }
}
