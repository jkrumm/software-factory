// Onboarding: add, verify and remove an account by command (docs/accounts.md §Onboarding). The registry is edited as the
// JSON it is (every key the package does not know stays), and written through a symlink, so a registry that lives in a
// dotfiles checkout stays a link. Nothing here needs a host block.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { loginVerdict, refreshEnv } from './claude-auth.ts'
import { shQuote } from './host.ts'
import { keychainService, readLoginExpiry } from './keychain.ts'
import { type Account, type Registry, ID, SPILL, hasSessionLimit, planTier, usable } from './policy.ts'
import type { HttpGet, Spawner } from './ports.ts'
import { type RefreshDeps, runRefresh } from './refresh.ts'
import { accountDir, readClaudeJsonSample } from './registry.ts'
import { expandHome, cacheDir as defaultCacheDir, historyDir, modesPath, picksPath } from './paths.ts'
import { loadCache, saveSample, writeAtomic } from './store.ts'

/** The plans `add` takes: a Max (5 h session window and weekly) or an Ultra (weekly only). */
export const ADD_PLANS = ['max', 'ultra'] as const
export type RegistryJson = { accounts: Record<string, Record<string, unknown>> } & Record<string, unknown>

/** The registry file as JSON, or an empty registry when there is no file yet. */
export function readRegistryJson(path: string): RegistryJson {
  if (!existsSync(path)) return { accounts: {} }
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  if (!raw || typeof raw.accounts !== 'object' || raw.accounts === null) throw new Error(`${path}: missing accounts`)
  return raw
}

/** Atomic write through a symlink (the file the link points at is replaced, the link stays). */
export function writeRegistryJson(path: string, raw: RegistryJson): void {
  const target = existsSync(path) ? realpathSync(path) : path
  writeAtomic(target, `${JSON.stringify(raw, null, 2)}\n`)
}

/** `~/…` for a path under $HOME (a registry shared by two machines names the dir the same on both), else the absolute path. */
export function registryDir(abs: string): string {
  const home = homedir()
  return abs === home ? '~' : abs.startsWith(`${home}/`) ? `~/${abs.slice(home.length + 1)}` : abs
}

export interface AddInput {
  id: string
  plan: string
  dir?: string | null
  lanes?: string[] | null
}

/**
 * The registry with one more account, disabled. The first account (none owns the default `~/.claude` yet) takes it: dir null and the
 * interactive lanes; every later one takes `~/.claude-<id>` and the bulk lane. `units` is never written: they come from the plan.
 */
export function withAccount(raw: RegistryJson, a: AddInput): { raw: RegistryJson; account: Account } {
  if (!ID.test(a.id) || a.id === SPILL)
    throw new Error(`add: '${a.id}' is not an account id (letters, digits, _ and -; '${SPILL}' is reserved)`)
  if (Object.hasOwn(raw.accounts, a.id)) throw new Error(`add: '${a.id}' is already in the registry`)
  if (!ADD_PLANS.includes(a.plan as (typeof ADD_PLANS)[number]))
    throw new Error(`add: --plan must be one of ${ADD_PLANS.join(', ')}`)
  const defaultDir = resolve(homedir(), '.claude')
  const owned = Object.values(raw.accounts).some(
    (x) => x.dir === null || (typeof x.dir === 'string' && resolve(expandHome(x.dir)) === defaultDir),
  )
  let dir: string | null
  if (a.dir) {
    const abs = resolve(expandHome(a.dir))
    if (abs === resolve(homedir(), '.claude'))
      throw new Error(
        `add: --dir ~/.claude is the default account's: omit --dir for the first account (it owns it), never name it (the Keychain item would change)`,
      )
    for (const [other, x] of Object.entries(raw.accounts))
      if (typeof x.dir === 'string' && resolve(expandHome(x.dir)) === abs)
        throw new Error(`add: ${other} already uses ${a.dir}`)
    dir = registryDir(abs)
  } else dir = owned ? `~/.claude-${a.id}` : null
  if (dir === null && owned) throw new Error('add: the default ~/.claude already belongs to an account')
  const lanes = a.lanes?.length ? a.lanes : dir === null ? ['interactive', 'headless'] : ['bulk']
  if (!lanes.every((l) => typeof l === 'string' && l.length > 0 && !/\s/.test(l)))
    throw new Error('add: --lanes is a comma-separated list of lane names')
  const account: Account = { dir, plan: a.plan, homeLanes: lanes, enabled: false }
  return { raw: { ...raw, accounts: { ...raw.accounts, [a.id]: { ...account } } }, account }
}

export function withEnabled(raw: RegistryJson, id: string, enabled: boolean): RegistryJson {
  return { ...raw, accounts: { ...raw.accounts, [id]: { ...raw.accounts[id], enabled } } }
}

/** The shell command that signs this machine in as the account (the binary reads CLAUDE_CONFIG_DIR). */
export function loginCommand(a: Account): string {
  const dir = accountDir(a)
  return dir === null ? 'claude auth login' : `CLAUDE_CONFIG_DIR=${shQuote(dir)} claude auth login`
}

/** The directory `add` creates: the account's own, `~/.claude` for the default one. */
export const configDir = (a: Account): string => accountDir(a) ?? resolve(homedir(), '.claude')

export function ensureConfigDir(a: Account): string {
  const d = configDir(a)
  mkdirSync(d, { recursive: true })
  return d
}

export interface Check {
  name: 'login' | 'plan' | 'sample'
  ok: boolean
  detail: string
}

export interface VerifyDeps {
  reg: Registry
  id: string
  spawn: Spawner
  httpGet: HttpGet
  claudeBin: string
  securityBin?: string
  baseEnv: Record<string, string | undefined>
  now: () => number
  log?: (msg: string) => void
}

/**
 * The three checks of `verify`: this machine's login answers `claude auth status`, the plan the login item reports is the registered
 * one, and a sample of the weekly window can be read (the usage endpoint with the account's own token, else what its own
 * `.claude.json` holds). A failed login stops there: nothing after it can be read. The sample lands in the cache like any refresh's.
 */
export async function verifyAccount(d: VerifyDeps): Promise<Check[]> {
  const a = d.reg.accounts[d.id]
  const login = loginVerdict({ spawn: d.spawn, claudeBin: d.claudeBin }, refreshEnv(d.baseEnv, accountDir(a)))
  if (login.loggedIn !== true)
    return [
      {
        name: 'login',
        ok: false,
        detail: login.startFailed
          ? `cannot start claude (${login.startFailed})`
          : login.loggedIn === false
            ? `not logged in: run ${loginCommand(a)}`
            : 'claude auth status gave no answer',
      },
    ]
  const checks: Check[] = [{ name: 'login', ok: true, detail: 'claude auth status: logged in' }]
  const row = readLoginExpiry({
    reg: d.reg,
    spawn: d.spawn,
    securityBin: d.securityBin,
    baseEnv: d.baseEnv,
    now: d.now(),
    ids: [d.id],
  })[0]
  const registered = planTier(a.plan)
  if (!row.plan_detected)
    checks.push({ name: 'plan', ok: false, detail: `the plan cannot be read from the login item (${row.detail})` })
  else if (row.plan_detected !== registered)
    checks.push({
      name: 'plan',
      ok: false,
      detail: `the login is ${row.plan_detected} (tier ${row.tier}), the registry says ${registered}: remove the account and add it again with --plan ${row.plan_detected}`,
    })
  else checks.push({ name: 'plan', ok: true, detail: `${registered} (tier ${row.tier}); ${row.detail}` })
  // an account that is still disabled is sampled all the same: that is what this check is for
  const reg = { ...d.reg, accounts: { ...d.reg.accounts, [d.id]: { ...a, enabled: true } } }
  const deps: RefreshDeps = {
    reg,
    spawn: d.spawn,
    httpGet: d.httpGet,
    claudeBin: d.claudeBin,
    securityBin: d.securityBin,
    baseEnv: d.baseEnv,
    ids: [d.id],
    now: d.now,
    log: d.log,
  }
  const startedAt = d.now()
  const results = await runRefresh(deps)
  const own = readClaudeJsonSample(a)
  if (own) saveSample(d.id, own, undefined, hasSessionLimit(a), d.now())
  // only a sample this run read counts: the cache may hold a removed account's old one under the same id
  // the weekly of an endpoint answer counts only with a timestamp from this run (an answer without it leaves the stored one in the merged cache sample);
  // else the account's own .claude.json usage counts, within 6 h
  const cached = results[d.id] === 'fresh' ? loadCache().samples[d.id] : undefined
  const fromEndpoint = cached?.w_ts != null && cached.w_ts >= startedAt ? cached : null
  const x = fromEndpoint ?? (usable(own ?? undefined, d.now()) ? own : null)
  const w = x?.w ?? null
  const age = x?.w_ts != null ? `, read ${Math.max(0, Math.round((d.now() - x.w_ts) / 60_000))} min ago` : ''
  checks.push(
    w === null
      ? {
          name: 'sample',
          ok: false,
          detail:
            "no quota sample read by this run: the usage endpoint gave none and the account's own cached usage is missing or older than 6 h (a sample left in the cache earlier does not count; see the lines above)",
        }
      : {
          name: 'sample',
          ok: true,
          detail: `weekly ${w}%${x?.s != null && hasSessionLimit(a) ? `, 5 h ${x.s}%` : ''} (${x?.src}${age})`,
        },
  )
  return checks
}

/** What `remove` leaves behind, one line each: the registry entry, the directory, the login, the cache, the history. */
export function leftBehind(reg: Registry, id: string, registryPath: string): string[] {
  const a = reg.accounts[id]
  const dir = accountDir(a)
  const cache = defaultCacheDir()
  const files = existsSync(cache) ? readdirSync(cache).filter((f) => f.startsWith(`${id}.`)) : []
  return [
    `registry   the entry stays in ${registryPath} with enabled: false (the history and the usage rows keep reading it); delete the key by hand to forget it`,
    `config dir ${configDir(a)} (not deleted)`,
    `login      Keychain item '${keychainService(dir)}'; \`${dir === null ? 'claude auth logout' : `CLAUDE_CONFIG_DIR=${shQuote(dir)} claude auth logout`}\` removes it`,
    `cache      ${files.length} file(s) ${cache}/${id}.* (samples, marks); they age out of every rule and are safe to delete`,
    `history    lines naming ${id} in ${picksPath()}, its samples and resets in ${historyDir()} (samples-*.jsonl, resets.jsonl) and any mode override in ${modesPath()}`,
  ]
}
