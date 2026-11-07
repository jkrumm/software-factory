import * as z from 'zod'

const DEFAULT_POLL_MS = 1000

const Env = z.object({
  FACTORY_STREAM_POLL_MS: z.coerce.number().int().min(10).max(60_000).default(DEFAULT_POLL_MS),
})

export interface StreamSettings {
  /** how often the stream looks for new changes */
  pollMs: number
}

/** The change stream's settings from the environment; throws one message when `FACTORY_STREAM_POLL_MS` is not a whole number of 10 to 60000. */
export function loadStreamSettings(env: Record<string, string | undefined>): StreamSettings {
  const parsed = Env.safeParse({ FACTORY_STREAM_POLL_MS: env.FACTORY_STREAM_POLL_MS || undefined })
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '))
  }
  return { pollMs: parsed.data.FACTORY_STREAM_POLL_MS }
}
