import { join } from 'node:path'
import * as z from 'zod'

const Env = z.object({
  /** the owner's tailnet login; absent, the Console listener is not started (fail closed) */
  FACTORY_CONSOLE_OWNER_LOGIN: z.string().min(1).optional(),
  FACTORY_CONSOLE_PORT: z.coerce.number().int().min(1).max(65535).default(7794),
  /** the Console build; a release has the same layout as the repo */
  FACTORY_CONSOLE_DIR: z.string().min(1).optional(),
})

export interface ConsoleSettings {
  ownerLogin: string | null
  port: number
  dir: string
}

/** `<repo root>/apps/console/dist`: this file is `<repo root>/apps/server/src/console-settings.ts`. */
const DEFAULT_DIR = join(import.meta.dir, '..', '..', '..', 'apps', 'console', 'dist')

/** The Console listener's settings from the environment. */
export function loadConsoleSettings(env: Record<string, string | undefined>): ConsoleSettings {
  const parsed = Env.safeParse(env)
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '))
  }
  return {
    ownerLogin: parsed.data.FACTORY_CONSOLE_OWNER_LOGIN ?? null,
    port: parsed.data.FACTORY_CONSOLE_PORT,
    dir: parsed.data.FACTORY_CONSOLE_DIR ?? DEFAULT_DIR,
  }
}
