// Where the registry, the cache, the pick log and the keepalive log live (docs/accounts.md §Files). Every location is
// part of the CLI contract: other tools (usage tracker, extension, dashboards) read them.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

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

/** The policy lab's shadow log (docs/accounts.md §The policy lab): beside the pick log, whose shape it leaves alone. */
export const shadowPath = () => process.env.CLAUDE_ACCOUNTS_SHADOW ?? join(dirname(picksPath()), 'shadow.jsonl')

/** The mode overrides (docs/accounts.md §Modes): state, not cache, so it sits beside the pick log. */
export const modesPath = () =>
  process.env.CLAUDE_ACCOUNTS_MODES ?? join(homedir(), '.local', 'share', 'claude-accounts', 'modes.json')
/** One audit line per set, clear or adoption, beside the state file. */
export const modesAuditPath = (statePath = modesPath()) => `${statePath.replace(/\.json$/, '')}.jsonl`

/** The history of a machine's accounts (docs/accounts.md §History): `samples-YYYY-MM.jsonl` and `resets.jsonl`. Data beside the pick log, not cache. */
export const historyDir = () =>
  process.env.CLAUDE_ACCOUNTS_HISTORY ?? join(homedir(), '.local', 'share', 'claude-accounts')

/** The keepalive job's log: its stdout/stderr, and the stdio of the detached refresh a pick spawns. */
export const keepaliveLogPath = () => join(homedir(), 'Library', 'Logs', 'claude-accounts-keepalive.log')

export const expandHome = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)
