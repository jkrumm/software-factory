// The `claude` adapter (0 tokens): the login verdict (`auth status`), the token renewal (`mcp list`), and the environment the binary runs in.
import type { Spawner } from './ports.ts'

/** Credentials that would make the spawned binary bill API credits or bypass the account's own login. */
const STRIPPED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']

export function refreshEnv(base: Record<string, string | undefined>, dir: string | null): Record<string, string> {
  const env = { ...base } as Record<string, string>
  for (const k of STRIPPED_ENV) delete env[k]
  env.ANTHROPIC_BASE_URL = ''
  if (dir === null) delete env.CLAUDE_CONFIG_DIR
  else env.CLAUDE_CONFIG_DIR = dir
  return env
}

/**
 * Makes the binary renew an expired Keychain access token (0 tokens): `claude mcp list` does, `claude auth status` no
 * longer does (2.1.311 and later; seen 2026-11-24 on 2.1.331). Returns the start failure, if any; the caller re-reads the token.
 */
export function renewToken(
  d: { spawn: Spawner; claudeBin: string },
  env: Record<string, string>,
): { startFailed?: string } {
  const r = d.spawn(d.claudeBin, ['mcp', 'list'], { env, timeoutMs: 30_000 })
  if (r.error && r.error.code !== 'ETIMEDOUT') return { startFailed: `${r.error.code ?? 'error'}: ${r.error.message}` }
  return {}
}

export type LoginVerdict = { loggedIn: boolean | null; startFailed?: string }

/** `claude auth status` (0 tokens): the login verdict, null when the binary gave no usable answer. */
export function loginVerdict(d: { spawn: Spawner; claudeBin: string }, env: Record<string, string>): LoginVerdict {
  const r = d.spawn(d.claudeBin, ['auth', 'status'], { env, timeoutMs: 30_000 })
  // any spawn error but a timeout means the binary never ran an attempt; a timeout says nothing and keeps the claim
  if (r.error && r.error.code !== 'ETIMEDOUT')
    return { loggedIn: null, startFailed: `${r.error.code ?? 'error'}: ${r.error.message}` }
  try {
    const v = (JSON.parse(r.stdout) as { loggedIn?: unknown }).loggedIn
    return { loggedIn: typeof v === 'boolean' ? v : null }
  } catch {
    return { loggedIn: null }
  }
}
