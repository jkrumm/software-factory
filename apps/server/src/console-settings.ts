import { join } from 'node:path'
import * as z from 'zod'

const Env = z.object({
  FACTORY_CONSOLE_PORT: z.coerce.number().int().min(1).max(65535).default(7795),
  /** the Console build; a release has the same layout as the repo */
  FACTORY_CONSOLE_DIR: z.string().min(1).optional(),
})

export interface ConsoleSettings {
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
    port: parsed.data.FACTORY_CONSOLE_PORT,
    dir: parsed.data.FACTORY_CONSOLE_DIR ?? DEFAULT_DIR,
  }
}
