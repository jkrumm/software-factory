import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The most a token resolution may take: `secrets-run` reads an offline cache, so a longer wait is a hang (a biometric prompt). */
export const RESOLVE_TIMEOUT_MS = 10_000

type Env = Record<string, string | undefined>

/** The bearer a call sends, and why there is none when there is none. */
export interface Credential {
  token: string | undefined
  /** set when the CLI tried to resolve the owner token on this host and could not */
  failure?: string
}

/** The token the caller put in the environment: the owner's (or a lead's, or the orchestrator's), else the read token. */
export const tokenFromEnv = (env: Env): string | undefined => env.FACTORY_TOKEN || env.FACTORY_READ_TOKEN || undefined

/** The deployed release's env template: the one list of refs the factory's own launcher resolves. */
export function templateOf(env: Env): string | undefined {
  const root = env.FACTORY_ROOT || (env.HOME ? join(env.HOME, '.software-factory') : undefined)
  return root ? join(root, 'current', '.env.tpl') : undefined
}

/** The `op://` reference the template gives `FACTORY_TOKEN`, or undefined when the template is missing or has none. */
function tokenRefIn(template: string): string | undefined {
  try {
    return /^FACTORY_TOKEN=(op:\/\/\S+)\s*$/m.exec(readFileSync(template, 'utf8'))?.[1]
  } catch {
    return undefined
  }
}

/**
 * The bearer of this process. A set `FACTORY_TOKEN` or `FACTORY_READ_TOKEN` always wins and nothing is spawned. With
 * neither, on a host that holds a deployed release and `secrets-run`, the owner token is resolved from the release's
 * `.env.tpl` through `secrets-run`, never from a tracked file and never by `op`. Anywhere else there is no token and the
 * server answers 401.
 */
export async function credentialOf(env: Env): Promise<Credential> {
  const given = tokenFromEnv(env)
  if (given) return { token: given }
  const template = templateOf(env)
  const ref = template ? tokenRefIn(template) : undefined
  if (!ref) return { token: undefined }
  const secretsRun = Bun.which('secrets-run', { PATH: env.PATH ?? '' })
  if (!secretsRun) return { token: undefined }
  try {
    const child = Bun.spawn([secretsRun, 'read', ref], {
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: RESOLVE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })
    // `read`, not `run`: `secrets-run run` masks the secrets it resolves in its own output, so it could never print one.
    const [text, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const token = text.trim()
    if (code === 0 && token) return { token }
    const why = error.trim().split('\n')[0]
    return {
      token: undefined,
      failure: `secrets-run ${code === 0 ? 'printed no token' : `exited ${code}`}${why ? `: ${why.slice(0, 200)}` : ''}`,
    }
  } catch (error) {
    return {
      token: undefined,
      failure: `secrets-run did not run: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** The 401 hint of every online command: what to set, and what the host tried. */
export const authHint = (failure?: string): string =>
  `set FACTORY_TOKEN (FACTORY_READ_TOKEN reads only); on the host the CLI resolves the owner token from the release's .env.tpl through secrets-run when neither is set${failure ? ` (${failure})` : ''}`
