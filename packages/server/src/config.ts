import { DEFAULT_ROLES_FILE } from '@software-factory/contract'
import { defaultHookSocket, defaultSpoolDir } from '@software-factory/contract/spool'

export interface Config {
  databaseUrl: string
  herdrBin: string
  token: string
  port: number
  version: string
  /** `claude-pretrust.sh` */
  pretrustBin: string
  /** the account registry */
  accountsFile: string
  /** the account picker, `claude-account`: its `usage --json` is the quota source */
  claudeAccountBin: string
  /** the role table (`FACTORY_ROLES_FILE`): tier and effort per role */
  rolesFile: string
  retryBudgetMs: number
  /** the directories a spawn's repo must be inside (`FACTORY_REPO_ROOTS`) */
  repoRoots: string[]
  /** where the hooks append their events (`FACTORY_SPOOL_DIR`) */
  spoolDir: string
  /** the unix socket the hooks post to (`FACTORY_SOCKET`) */
  hookSocket: string
  /** how many test runs may hold a slot at once (`FACTORY_SLOTS`) */
  slots: number
}

const DOTFILES = 'SourceRoot/dotfiles'

/**
 * How long a spawn stays retryable, counted from its first claim: a herdr that restarts for a few minutes fails
 * nothing. Only a start that failed counts; time spent waiting for capacity does not (the clock resets there).
 */
export const DEFAULT_RETRY_BUDGET_MS = 30 * 60_000

/** Reads the environment once, at boot, and refuses to start on anything unusable. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const required = (name: string): string => {
    const value = env[name]
    if (!value) throw new Error(`${name} is not set`)
    return value
  }
  const port = Number(required('PORT'))
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535, got: ${env.PORT}`)
  }
  const token = required('FACTORY_TOKEN')
  if (token.length < 16) throw new Error('FACTORY_TOKEN must be at least 16 characters')
  return {
    databaseUrl: required('DATABASE_URL'),
    herdrBin: required('HERDR_BIN'),
    token,
    port,
    version: env.FACTORY_VERSION || 'dev',
    pretrustBin: env.FACTORY_PRETRUST_BIN || `${required('HOME')}/${DOTFILES}/scripts/claude-pretrust.sh`,
    accountsFile: env.FACTORY_ACCOUNTS_FILE || `${required('HOME')}/${DOTFILES}/config/claude-accounts.json`,
    claudeAccountBin: env.FACTORY_CLAUDE_ACCOUNT_BIN || `${required('HOME')}/.local/bin/claude-account`,
    rolesFile: env.FACTORY_ROLES_FILE || DEFAULT_ROLES_FILE,
    retryBudgetMs: retryBudgetMs(env.FACTORY_RETRY_BUDGET_MS),
    repoRoots: repoRoots(env.FACTORY_REPO_ROOTS, env.HOME),
    spoolDir: env.FACTORY_SPOOL_DIR || defaultSpoolDir(required('HOME')),
    hookSocket: env.FACTORY_SOCKET || defaultHookSocket(required('HOME')),
    slots: slots(env.FACTORY_SLOTS),
  }
}

/** Test slots (FL7): two to start with, tuned from the load record. */
export const DEFAULT_SLOTS = 2

function slots(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_SLOTS
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 64)
    throw new Error(`FACTORY_SLOTS must be a whole number from 1 to 64, got: ${value}`)
  return n
}

function retryBudgetMs(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_RETRY_BUDGET_MS
  const ms = Number(value)
  if (!Number.isInteger(ms) || ms < 1000)
    throw new Error(`FACTORY_RETRY_BUDGET_MS must be whole milliseconds, got: ${value}`)
  return ms
}

/** Colon-separated absolute paths; the default is the two workspaces under the home directory. */
function repoRoots(value: string | undefined, home: string | undefined): string[] {
  const raw = value || (home ? `${home}/SourceRoot:${home}/IuRoot` : '')
  if (!raw) throw new Error('FACTORY_REPO_ROOTS is not set and HOME is not set to default it from')
  const roots = raw.split(':').filter(Boolean)
  const relative = roots.find((root) => !root.startsWith('/'))
  if (relative !== undefined || roots.length === 0) {
    throw new Error(`FACTORY_REPO_ROOTS must be colon-separated absolute paths, got: ${raw}`)
  }
  return roots
}
