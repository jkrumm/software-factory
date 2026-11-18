import * as z from 'zod'

const Env = z.object({
  /** a ref of `.env.server.tpl`: the ClickStack ingest URL; unset, the export is off */
  FACTORY_OTEL_ENDPOINT: z.string().url().optional(),
  /** the ingest key, sent as the `authorization` header; a ref of `.env.server.tpl` */
  FACTORY_OTEL_KEY: z.string().min(1).optional(),
  FACTORY_OTEL_EVERY_MS: z.coerce.number().int().min(5_000).default(60_000),
  /** the trailing window the counted figures (slot waits, placements) cover; five minutes is the host swapout window */
  FACTORY_OTEL_WINDOW_MS: z.coerce.number().int().min(60_000).default(300_000),
})

export interface OtelEnv {
  endpoint: string | null
  key: string | null
  everyMs: number
  windowMs: number
}

/** The metrics export's settings from the environment; throws one message naming every bad key. */
export function loadOtelEnv(env: Record<string, string | undefined>): OtelEnv {
  const parsed = Env.safeParse({
    FACTORY_OTEL_ENDPOINT: env.FACTORY_OTEL_ENDPOINT || undefined,
    FACTORY_OTEL_KEY: env.FACTORY_OTEL_KEY || undefined,
    FACTORY_OTEL_EVERY_MS: env.FACTORY_OTEL_EVERY_MS || undefined,
    FACTORY_OTEL_WINDOW_MS: env.FACTORY_OTEL_WINDOW_MS || undefined,
  })
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '))
  }
  const e = parsed.data
  return {
    endpoint: e.FACTORY_OTEL_ENDPOINT?.replace(/\/+$/, '') ?? null,
    key: e.FACTORY_OTEL_KEY ?? null,
    everyMs: e.FACTORY_OTEL_EVERY_MS,
    windowMs: e.FACTORY_OTEL_WINDOW_MS,
  }
}
