import type { ZodType, output } from 'zod'

/** The process environment, or a test's stand-in for it. */
export type Environment = Record<string, string | undefined>

/** `env` read through `schema`; throws one message naming every bad key (`KEY: why`, joined by `; `). */
export function parseEnv<S extends ZodType>(schema: S, env: unknown): output<S> {
  const parsed = schema.safeParse(env)
  if (parsed.success) return parsed.data
  throw new Error(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '))
}
