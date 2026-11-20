// The registry file and what is derived from an account's directory. Registry shape: packages/accounts/docs/accounts.md §The registry.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  type Account,
  type Mode,
  type Hold,
  type ModeKind,
  type PickResult,
  type Registry,
  HOLDS,
  type Sample,
  ID,
  MODE_KINDS,
  POLICY_NAMES,
  isPolicyName,
  SPILL,
  defaultAccountId,
  isNum,
  required,
  sampleFromClaudeJson,
} from './policy.ts'
import { expandHome, registryPath } from './paths.ts'
import { parseHost, shQuote } from './host.ts'

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
  return parseRegistry(JSON.parse(readFileSync(path, 'utf8')), path)
}

/** A registry as parsed JSON, checked; `path` only names the file in the messages. */
export function parseRegistry(raw: ReturnType<typeof JSON.parse>, path: string): Registry {
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
  const version = raw.version
  if (version !== undefined && version !== 1 && version !== 2)
    throw new Error(`${path}: registry version ${JSON.stringify(version)} is not known to this build (1 or 2)`)
  const policy = raw.policy
  if (policy !== undefined && !isPolicyName(policy))
    throw new Error(`${path}: policy ${JSON.stringify(policy)} is not one of ${POLICY_NAMES.join(', ')}`)
  const host = raw.host === undefined ? undefined : parseHost(raw.host)
  if (typeof host === 'string') throw new Error(`${path}: host ${host}`)
  const accounts: Record<string, Account> = {}
  for (const [id, a] of Object.entries(raw.accounts as Record<string, Account & { mode?: unknown }>)) {
    if (a.mode === undefined) {
      accounts[id] = a
      continue
    }
    const mode = parseMode(a.mode)
    if (typeof mode === 'string') throw new Error(`${path}: account '${id}' mode: ${mode}`)
    accounts[id] = { ...a, mode }
  }
  return {
    ...(version !== undefined ? { version } : {}),
    ...(host ? { host } : {}),
    accounts,
    fable,
    drain,
    ...(policy !== undefined ? { policy } : {}),
  }
}

/** A registry `mode`: a kind (`"drain"`) or `{kind, for?, hold?, until?, why?}`; a string answer is what is wrong with it. */
export function parseMode(v: unknown): Mode | string {
  const o = (typeof v === 'string' ? { kind: v } : v) as Record<string, unknown> | null
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'must be a kind or an object'
  if (!MODE_KINDS.includes(o.kind as ModeKind)) return `kind must be one of ${MODE_KINDS.join(', ')}`
  const str = (k: string) => o[k] === undefined || o[k] === null || typeof o[k] === 'string'
  if (!str('for') || !str('until') || !str('why')) return 'for, until and why must be strings'
  if (o.kind === 'reserve' && typeof o.for !== 'string') return 'reserve needs for: <model>'
  if (o.kind !== 'reserve' && o.for) return 'for belongs to reserve only'
  if (o.hold !== undefined && o.hold !== null && !HOLDS.includes(o.hold as Hold))
    return `hold must be one of ${HOLDS.join(', ')}`
  if (o.kind !== 'reserve' && o.hold) return 'hold belongs to reserve only'
  if (o.until === 'reset')
    return 'until: reset is for overrides only (claude-account mode); the registry takes an ISO time'
  if (typeof o.until === 'string' && Number.isNaN(Date.parse(o.until))) return `until '${o.until}' is not an ISO time`
  return {
    kind: o.kind as ModeKind,
    ...(o.for ? { for: o.for as string } : {}),
    ...(o.hold ? { hold: o.hold as Hold } : {}),
    ...(o.until ? { until: o.until as string } : {}),
    ...(o.why ? { why: o.why as string } : {}),
  }
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

/** The account's own `.claude.json` `cachedUsageUtilization` as a sample; null when the file is missing or unreadable. */
export function readClaudeJsonSample(a: Account): Sample | null {
  try {
    return sampleFromClaudeJson(JSON.parse(readFileSync(claudeJsonPath(a), 'utf8')))
  } catch {
    return null
  }
}

/** Shell fragment for a pick; null for the IU spill signal. */
export function shellLine(reg: Registry, p: PickResult): string | null {
  if (p.picked === SPILL) return null
  const dir = accountDir(required(reg.accounts, p.picked))
  return dir === null ? 'unset CLAUDE_CONFIG_DIR' : `export CLAUDE_CONFIG_DIR=${shQuote(dir)}`
}
