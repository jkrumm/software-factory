import * as z from 'zod'
import { parseEnv, type Environment } from '../../kernel/env.ts'

const Env = z.object({
  /** a ref of `.env.server.tpl`: the ClickStack ingest URL; unset, the export is off */
  FACTORY_OTEL_ENDPOINT: z.string().url().optional(),
  /** the ingest key, sent as the `authorization` header; a ref of `.env.server.tpl` */
  FACTORY_OTEL_KEY: z.string().min(1).optional(),
  /** how often the metrics export runs, at least 5 s */
  FACTORY_OTEL_EVERY_MS: z.coerce.number().int().min(5_000).default(60_000),
})

/** The trailing window the counted figures (slot waits, placements) cover: the host's swapout window, five minutes. */
const WINDOW_MS = 300_000

export interface OtelEnv {
  endpoint: string | null
  key: string | null
  everyMs: number
  windowMs: number
}

/** The metrics export's settings from the environment; throws one message naming every bad key. */
export function loadOtelEnv(env: Environment): OtelEnv {
  const e = parseEnv(Env, {
    FACTORY_OTEL_ENDPOINT: env.FACTORY_OTEL_ENDPOINT || undefined,
    FACTORY_OTEL_KEY: env.FACTORY_OTEL_KEY || undefined,
    FACTORY_OTEL_EVERY_MS: env.FACTORY_OTEL_EVERY_MS || undefined,
  })
  return {
    endpoint: e.FACTORY_OTEL_ENDPOINT?.replace(/\/+$/, '') ?? null,
    key: e.FACTORY_OTEL_KEY ?? null,
    everyMs: e.FACTORY_OTEL_EVERY_MS,
    windowMs: WINDOW_MS,
  }
}
