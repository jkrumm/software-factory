import { DEFAULT_RETRY_BUDGET_MS } from './tick.ts'

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
  const home = required('HOME')
  const token = required('FACTORY_TOKEN')
  if (token.length < 16) throw new Error('FACTORY_TOKEN must be at least 16 characters')
  return {
    databaseUrl: required('DATABASE_URL'),
    herdrBin: required('HERDR_BIN'),
    token,
    port,
    version: env.FACTORY_VERSION || 'dev',
    pretrustBin: env.FACTORY_PRETRUST_BIN || `${home}/${DOTFILES}/scripts/claude-pretrust.sh`,
    accountsFile: env.FACTORY_ACCOUNTS_FILE || `${home}/${DOTFILES}/config/claude-accounts.json`,
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
