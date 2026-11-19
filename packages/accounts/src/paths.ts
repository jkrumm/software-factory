// Where the registry, the cache, the pick log and the keepalive log live (docs/accounts.md §Files). Every location is
// part of the CLI contract: other tools (usage tracker, extension, dashboards) read them.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The shared registry of a machine that runs the factory beside a dotfiles checkout; the fallback when no per-user file exists. */
const LEGACY_REGISTRY = ['SourceRoot', 'dotfiles', 'config', 'claude-accounts.json']

/** $CLAUDE_ACCOUNTS_REGISTRY, else `~/.config/claude-accounts/registry.json` when it exists, else the legacy shared file. */
export const registryPath = () => {
  if (process.env.CLAUDE_ACCOUNTS_REGISTRY) return process.env.CLAUDE_ACCOUNTS_REGISTRY
  const own = join(homedir(), '.config', 'claude-accounts', 'registry.json')
  return existsSync(own) ? own : join(homedir(), ...LEGACY_REGISTRY)
}
export const cacheDir = () => process.env.CLAUDE_ACCOUNTS_CACHE_DIR ?? join(homedir(), '.cache', 'claude-accounts')
export const picksPath = () =>
  process.env.CLAUDE_ACCOUNTS_PICKS ?? join(homedir(), '.local', 'share', 'claude-accounts', 'picks.jsonl')

/** The keepalive job's log: its stdout/stderr, and the stdio of the detached refresh a pick spawns. */
export const keepaliveLogPath = () => join(homedir(), 'Library', 'Logs', 'claude-accounts-keepalive.log')

export const expandHome = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)
