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
  retryBudgetMs: number
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
    retryBudgetMs: retryBudgetMs(env.FACTORY_RETRY_BUDGET_MS),
  }
}

function retryBudgetMs(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_RETRY_BUDGET_MS
  const ms = Number(value)
  if (!Number.isInteger(ms) || ms < 1000)
    throw new Error(`FACTORY_RETRY_BUDGET_MS must be whole milliseconds, got: ${value}`)
  return ms
}
