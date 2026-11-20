import { join } from 'node:path'
import * as z from 'zod'
import { parseEnv, type Environment } from './kernel/env.ts'

const Env = z.object({
  FACTORY_CONSOLE_PORT: z.coerce.number().int().min(1).max(65535).default(7795),
  /** the Console build; a release has the same layout as the repo */
  FACTORY_CONSOLE_DIR: z.string().min(1).optional(),
  /**
   * Hosts the Console page may load images from (the page's `img-src`), comma-separated: `images.example.com` or
   * `*.example.com`, no scheme, port or path. Empty by default: a Markdown artifact's image then shows its alt text.
   */
  FACTORY_CONSOLE_IMAGE_HOSTS: z.string().optional(),
})

/** A host, or `*.` and a domain of at least two labels: never a bare `*`, a scheme, a port or a path. */
const IMAGE_HOST = /^(\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/

export interface ConsoleSettings {
  port: number
  dir: string
  /** the hosts `img-src` adds to `'self' data:`, lower-cased */
  imageHosts: string[]
}

/** `<repo root>/apps/console/dist`: this file is `<repo root>/apps/server/src/console-settings.ts`. */
const DEFAULT_DIR = join(import.meta.dir, '..', '..', '..', 'apps', 'console', 'dist')

/** The Console listener's settings from the environment. */
export function loadConsoleSettings(env: Environment): ConsoleSettings {
  const e = parseEnv(Env, env)
  const imageHosts = (e.FACTORY_CONSOLE_IMAGE_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== '')
  const bad = imageHosts.find((host) => !IMAGE_HOST.test(host))
  if (bad !== undefined) {
    throw new Error(`FACTORY_CONSOLE_IMAGE_HOSTS: "${bad}" is not a host (use images.example.com or *.example.com)`)
  }
  return {
    port: e.FACTORY_CONSOLE_PORT,
    dir: e.FACTORY_CONSOLE_DIR ?? DEFAULT_DIR,
    imageHosts,
  }
}
