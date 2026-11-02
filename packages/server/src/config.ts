import { DEFAULT_ROLES_FILE, ReaperMode } from '@software-factory/contract'
import { parseProbeHosts } from './fleet/probes.ts'
import { defaultHookSocket, defaultSpoolDir } from '@software-factory/contract/spool'

export interface Config {
  databaseUrl: string
  /** herdr-core's `hc` (`HC_BIN`) */
  hcBin: string
  /** another core than the default one (`HC_SESSION`, tests) */
  hcSession?: string
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
  /** the directories whose repos the fleet view shows read-only (`FACTORY_VISIBLE_ROOTS`, default `$HOME/IuRoot`): never a spawn or Issue target on their account */
  visibleRoots: string[]
  /** `dotfiles/scripts/ask-human.sh`, the human queue's reader and its `resolve` (`FACTORY_ASK_HUMAN`) */
  askHumanBin: string
  /** the machines the fleet triage's probes may look at (`FACTORY_PROBE_HOSTS`, `<name>=<ssh alias|local>,…`; none by default): a probe on any other machine says nothing */
  probeHosts: Map<string, string>
  /** where the hooks append their events (`FACTORY_SPOOL_DIR`) */
  spoolDir: string
  /** the unix socket the hooks post to (`FACTORY_SOCKET`) */
  hookSocket: string
  /** how many test runs may hold a slot at once (`FACTORY_SLOTS`) */
  slots: number
  /** the `agw` CLI Classify calls (`FACTORY_AGW_BIN`) */
  agwBin: string
  /** `FACTORY_ALERT_LEADS`: whether an `alert` Issue gets a lead. Unset: yes (decision 3: evidence and the hold are live); `0` switches it off */
  alertLeads: boolean
  /** `FACTORY_NOTIFY_TARGET`: where Hermes delivers the owner's messages; `off` sends nothing */
  notifyTarget: string
  /** `HERMES_BIN` */
  hermesBin: string
  /** `FACTORY_DIGEST_AT` (`HH:MM` local time, or `off`) in `FACTORY_DIGEST_TZ` */
  digestAt: string | null
  digestTz: string
  /** `FACTORY_DIGEST_EVERY` (`5m`, `90s`, `1h`, or `off`): how often the fleet digest asks `agw digest` about what changed; null is off (not the owner's morning line above) */
  fleetDigestEveryMs: number | null
  /** `FACTORY_REAPER` (`on`, `dry`, `off`; default `dry`): whether the fleet build closes finished, merged worker sessions, only lists them, or reads nothing */
  reaper: ReaperMode
  /** where a closed attempt's transcripts are kept (`FACTORY_ARCHIVE_DIR`) */
  archiveDir: string
}

const DOTFILES = 'SourceRoot/dotfiles'

/**
 * How long a spawn stays retryable, counted from its first claim: a runner that restarts for a few minutes fails
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
    hcBin: required('HC_BIN'),
    hcSession: env.HC_SESSION || undefined,
    token,
    port,
    version: env.FACTORY_VERSION || 'dev',
    pretrustBin: env.FACTORY_PRETRUST_BIN || `${required('HOME')}/${DOTFILES}/scripts/claude-pretrust.sh`,
    accountsFile: env.FACTORY_ACCOUNTS_FILE || `${required('HOME')}/${DOTFILES}/config/claude-accounts.json`,
    claudeAccountBin: env.FACTORY_CLAUDE_ACCOUNT_BIN || `${required('HOME')}/.local/bin/claude-account`,
    rolesFile: env.FACTORY_ROLES_FILE || DEFAULT_ROLES_FILE,
    retryBudgetMs: retryBudgetMs(env.FACTORY_RETRY_BUDGET_MS),
    repoRoots: repoRoots(env.FACTORY_REPO_ROOTS, env.HOME),
    visibleRoots: visibleRoots(env.FACTORY_VISIBLE_ROOTS, env.HOME),
    probeHosts: parseProbeHosts(env.FACTORY_PROBE_HOSTS),
    askHumanBin: env.FACTORY_ASK_HUMAN || `${required('HOME')}/${DOTFILES}/scripts/ask-human.sh`,
    spoolDir: env.FACTORY_SPOOL_DIR || defaultSpoolDir(required('HOME')),
    hookSocket: env.FACTORY_SOCKET || defaultHookSocket(required('HOME')),
    slots: slots(env.FACTORY_SLOTS),
    agwBin: env.FACTORY_AGW_BIN || `${required('HOME')}/.local/bin/agw`,
    alertLeads: switchOn('FACTORY_ALERT_LEADS', env.FACTORY_ALERT_LEADS, true),
    archiveDir: env.FACTORY_ARCHIVE_DIR || `${required('HOME')}/.local/share/factory/archive`,
    notifyTarget: env.FACTORY_NOTIFY_TARGET || DEFAULT_NOTIFY_TARGET,
    hermesBin: env.HERMES_BIN || `${required('HOME')}/.local/bin/hermes`,
    digestAt: digestAt(env.FACTORY_DIGEST_AT),
    digestTz: digestTz(env.FACTORY_DIGEST_TZ),
    fleetDigestEveryMs: fleetDigestEvery(env.FACTORY_DIGEST_EVERY),
    reaper: reaperMode(env.FACTORY_REAPER),
  }
}

/** A channel's name is not a secret, and a message to it never makes Hermes answer. */
export const DEFAULT_NOTIFY_TARGET = 'slack:#agents'
export const DEFAULT_DIGEST_AT = '07:30'
export const DEFAULT_DIGEST_TZ = 'Europe/Berlin'
export const DEFAULT_FLEET_DIGEST_EVERY_MS = 5 * 60_000

function digestAt(value: string | undefined): string | null {
  if (value === undefined || value === '') return DEFAULT_DIGEST_AT
  if (value === 'off') return null
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value))
    throw new Error(`FACTORY_DIGEST_AT must be HH:MM or off, got: ${value}`)
  // The digest is sent from this time until noon (a server that was down catches up before then): a later time could never be due.
  if (value >= '12:00') throw new Error(`FACTORY_DIGEST_AT must be before 12:00, got: ${value}`)
  return value
}

/** `on`, `dry` or `off`; unset is `dry`: a new switch lists before it acts. */
function reaperMode(value: string | undefined): ReaperMode {
  if (value === undefined || value === '') return 'dry'
  const mode = ReaperMode.safeParse(value)
  if (!mode.success) throw new Error(`FACTORY_REAPER must be on, dry or off, got: ${value}`)
  return mode.data
}

const DURATION_UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000 } as const

/** `5m`, `90s`, `1h`; `off` for none; unset is five minutes. Between 30 s and 24 h: a shorter spacing is spend, a longer one is a stale board. */
function fleetDigestEvery(value: string | undefined): number | null {
  if (value === undefined || value === '') return DEFAULT_FLEET_DIGEST_EVERY_MS
  if (value === 'off') return null
  const found = /^(\d+)([smh])$/.exec(value)
  const ms = found ? Number(found[1]) * DURATION_UNIT_MS[found[2] as 's' | 'm' | 'h'] : Number.NaN
  if (!(ms >= 30_000 && ms <= 24 * 3_600_000)) {
    throw new Error(`FACTORY_DIGEST_EVERY must be a duration of 30s to 24h (5m, 90s, 1h) or off, got: ${value}`)
  }
  return ms
}

function digestTz(value: string | undefined): string {
  const zone = value || DEFAULT_DIGEST_TZ
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone })
  } catch {
    throw new Error(`FACTORY_DIGEST_TZ is not a time zone: ${zone}`)
  }
  return zone
}

/** A switch: unset or empty is its default; `0`/`false`/`off` is off, `1`/`true`/`on` is on; anything else is a mistake that must not read as either. */
function switchOn(name: string, value: string | undefined, unset: boolean): boolean {
  if (value === undefined || value === '') return unset
  if (['0', 'false', 'off'].includes(value)) return false
  if (['1', 'true', 'on'].includes(value)) return true
  throw new Error(`${name} must be 1 or 0, got: ${value}`)
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

/** Colon-separated absolute paths, `off` for none; the default is the IuRoot workspace under the home directory. */
function visibleRoots(value: string | undefined, home: string | undefined): string[] {
  if (value === 'off') return []
  const raw = value || (home ? `${home}/IuRoot` : '')
  const roots = raw.split(':').filter(Boolean)
  if (roots.some((root) => !root.startsWith('/'))) {
    throw new Error(`FACTORY_VISIBLE_ROOTS must be colon-separated absolute paths or off, got: ${raw}`)
  }
  return roots
}
