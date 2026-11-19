// The registry file and what is derived from an account's directory. Registry shape: docs/accounts.md §The registry.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { type Account, type PickResult, type Registry, ID, SPILL, defaultAccountId, isNum } from './policy.ts'
import { expandHome, registryPath } from './paths.ts'

function validAccount(a: unknown): a is Account {
  const x = a as Account | null
  return (
    !!x &&
    typeof x === 'object' &&
    (x.dir === null || typeof x.dir === 'string') &&
    typeof x.plan === 'string' &&
    (x.units === undefined || (!!x.units && isNum(x.units.session) && isNum(x.units.weekly))) &&
    Array.isArray(x.homeLanes) &&
    x.homeLanes.every((l) => typeof l === 'string') &&
    (x.loginBrowser === undefined || typeof x.loginBrowser === 'string') &&
    typeof x.enabled === 'boolean'
  )
}

export function loadRegistry(path = registryPath()): Registry {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  if (!raw || typeof raw.accounts !== 'object' || raw.accounts === null) throw new Error(`${path}: missing accounts`)
  for (const [id, a] of Object.entries(raw.accounts)) {
    if (!ID.test(id) || id === SPILL) throw new Error(`${path}: bad account id '${id}'`)
    if (!validAccount(a)) throw new Error(`${path}: account '${id}' is malformed`)
  }
  if (!Object.values(raw.accounts).some((a) => (a as Account).dir === null))
    throw new Error(`${path}: no account owns the default ~/.claude (dir: null)`)
  const fable = raw.fable ?? null
  if (fable !== null && !(typeof fable === 'string' && Object.hasOwn(raw.accounts, fable)))
    throw new Error(`${path}: fable '${fable}' is not an account id`)
  const drain = raw.drain ?? null
  if (
    drain !== null &&
    !(Array.isArray(drain) && drain.every((id) => typeof id === 'string' && Object.hasOwn(raw.accounts, id)))
  )
    throw new Error(`${path}: drain must be a list of account ids`)
  if (drain !== null && fable !== null && drain.includes(fable))
    throw new Error(`${path}: '${fable}' cannot be both the fable and a drain account`)
  return { accounts: raw.accounts, fable, drain }
}

/** Absolute config dir of an account; null = default ~/.claude (env unset). */
export const accountDir = (a: Account): string | null => (a.dir === null ? null : resolve(expandHome(a.dir)))

/** Where the account's `.claude.json` lives: the default one sits in $HOME, others inside their dir. */
export function claudeJsonPath(a: Account): string {
  const d = accountDir(a)
  return d === null ? join(homedir(), '.claude.json') : join(d, '.claude.json')
}

/**
 * Registry id for a CLAUDE_CONFIG_DIR value. Unset or empty -> the default account; a set dir that no account
 * owns -> null (an unknown identity must not be attributed to the default account).
 */
export function accountFromConfigDir(reg: Registry, configDir: string | undefined): string | null {
  if (!configDir) return defaultAccountId(reg)
  const want = resolve(expandHome(configDir))
  for (const [id, a] of Object.entries(reg.accounts)) if (accountDir(a) === want) return id
  return null
}

const shQuote = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`

/** Shell fragment for a pick; null for the IU spill signal. */
export function shellLine(reg: Registry, p: PickResult): string | null {
  if (p.picked === SPILL) return null
  const dir = accountDir(reg.accounts[p.picked])
  return dir === null ? 'unset CLAUDE_CONFIG_DIR' : `export CLAUDE_CONFIG_DIR=${shQuote(dir)}`
}
