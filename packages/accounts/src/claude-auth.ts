// The `claude auth status` adapter (0 tokens): the login verdict, and the environment the binary runs in.
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
