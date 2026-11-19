#!/usr/bin/env bun
// claude-account — Claude account registry, picker and per-account quota cache (docs/accounts.md).
//
// Every verb and flag is in VERBS below; `claude-account --help` prints them, `claude-account <verb> --help` one in full.
//
// Idle-account samples: one read-only GET of the OAuth usage endpoint with the account's own Keychain token
// (never copied, logged or written back; on HTTP 401 `claude auth status` renews it first, one retry); `claude -p /usage` no longer refreshes cachedUsageUtilization (2.1.310).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import {
  type Cache,
  type RefreshResult,
  type Registry,
  type Sample,
  SPILL,
  defaultAccountId,
  fableAccount,
  hasSessionLimit,
  mergeSample,
  newestAge,
  pick,
  pickLine,
  planTier,
  rank,
  sampleFromClaudeJson,
  withoutSessionWindows,
} from './policy.ts'
import { cacheDir, picksPath, registryPath } from './paths.ts'
import { accountFromConfigDir, claudeJsonPath, loadRegistry, shellLine } from './registry.ts'
import { claimRefresh, loadCache, markExhausted, recordSample } from './store.ts'
import { readLoginExpiry } from './keychain.ts'
import { httpGet } from './oauth.ts'
import { runRefresh, refreshBeforePick } from './refresh.ts'
import { askRelogins } from './relogin.ts'
import { latestSessionId, sessionAccount } from './sessions.ts'
import { spawnDetached, spawner } from './spawn.ts'
import { type Integrations, fill, loadIntegrations, peerUsageFrom } from './integrations.ts'
import { type HealthRow, gradeMachine, healthSignature, localPending, parseJson, peerSnapshot, worst } from './peers.ts'
import { versionLine } from './version.ts'
import { boundedSpawnSync } from './spawn.ts'

const SPILL_EXIT = 3
const REGISTRY_EXIT = 4 // pick answered `unset CLAUDE_CONFIG_DIR` (iu) because the registry was unreadable

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(name)
  if (i < 0) return null
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`)
  return v
}
function num(argv: string[], name: string): number | null {
  const v = flag(argv, name)
  if (v === null) return null
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`)
  return n
}
function account(reg: Registry, argv: string[]): string {
  const id = flag(argv, '--account')
  if (!id || !Object.hasOwn(reg.accounts, id))
    throw new Error(`--account must be one of ${Object.keys(reg.accounts).join(', ')}`)
  return id
}

function readSample(reg: Registry, id: string): Sample | null {
  try {
    return sampleFromClaudeJson(JSON.parse(readFileSync(claudeJsonPath(reg.accounts[id]), 'utf8')))
  } catch {
    return null // missing or unreadable .claude.json: the account simply has no sample
  }
}

/** Merge each enabled account's own .claude.json cachedUsageUtilization into the cache. */
function readClaudeJson(reg: Registry, cache: Cache): Cache {
  for (const [id, a] of Object.entries(reg.accounts)) {
    if (!a.enabled) continue
    const s = readSample(reg, id)
    if (s) cache = { ...cache, samples: { ...cache.samples, [id]: mergeSample(cache.samples[id] ?? null, s) } }
  }
  return withoutSessionWindows(reg, cache) // a plan without a 5 h window never shows or judges a leftover session half
}

const claudeBin = () => Bun.which('claude') ?? join(homedir(), '.local', 'bin', 'claude')

/**
 * Refresh accounts. `ids` restricts what to consider but still goes through the enabled + due filters and the
 * claim; `claimed` (internal: the detached child of a pick) was already claimed by the parent.
 */
async function refresh(
  reg: Registry,
  o: { ids?: string[]; claimed?: string[]; all?: boolean; peer?: boolean } = {},
): Promise<Record<string, RefreshResult>> {
  const integrations: Integrations = o.peer === false ? {} : integrationsOrNone()
  const enabled = (id: string) => Object.hasOwn(reg.accounts, id) && reg.accounts[id].enabled
  const todo = o.claimed
    ? o.claimed.filter(enabled)
    : claimRefresh(
        reg,
        (o.ids ?? Object.keys(reg.accounts)).filter(enabled),
        Date.now(),
        readClaudeJson(reg, loadCache()),
        undefined,
        !!o.ids || !!o.all,
        !!o.all,
      ) // explicit --ids bypasses the auth-failed cooldown: the documented manual retry
  return runRefresh({
    reg,
    spawn: spawner,
    httpGet,
    securityBin: process.env.CLAUDE_ACCOUNTS_SECURITY_BIN,
    claudeBin: claudeBin(),
    baseEnv: process.env,
    ids: todo,
    now: Date.now,
    log: (m) => console.error(m),
    peerUsage: integrations.peerUsage ? peerUsageFrom(integrations.peerUsage) : undefined, // the synchronous pick-time refresh never waits on a peer
  })
}

const spawnDetachedRefresh = (ids: string[]) =>
  spawnDetached([process.execPath, process.argv[1], 'refresh', '--claimed', ids.join(',')])

const loginExpiry = (reg: Registry, now: number, ids?: string[]) =>
  readLoginExpiry({
    reg,
    spawn: spawner,
    securityBin: process.env.CLAUDE_ACCOUNTS_SECURITY_BIN,
    baseEnv: process.env,
    now,
    ids,
  })

/**
 * Keepalive only: a dead login, or one inside its last 7 days, asks its owner once per 24 h for a re-login through the
 * configured command (integrations.reloginAsk, detached; the dialog is the human's click, nothing runs by itself).
 * Without that command there is nobody to ask: nothing is read, nothing is stamped.
 */
function askForRelogins(reg: Registry, results: Record<string, RefreshResult>): void {
  const cmd = integrationsOrNone().reloginAsk
  if (!cmd) return
  const now = Date.now()
  try {
    const o = askRelogins({
      results,
      logins: loginExpiry(reg, now),
      now,
      ask: (c) => spawnDetached(fill(cmd, { id: c.id, reason: c.reason })),
      log: (m) => console.error(`claude-account: ${m}`),
    })
    for (const id of o.asked) console.error(`claude-account: asked for a re-login of ${id} (next ask in 24 h)`)
    if (o.capped.length)
      console.error(`claude-account: re-login ask for ${o.capped.join(', ')} deferred (one dialog per hour)`)
  } catch (e) {
    console.error(`claude-account: re-login ask skipped: ${(e as Error).message}`) // an ask is a courtesy, never a failure of the keepalive
  }
}

function expiry(reg: Registry, json: boolean, ids?: string[]): void {
  const unknown = ids?.filter((id) => !Object.hasOwn(reg.accounts, id))
  if (unknown?.length)
    throw new Error(`--ids: unknown account ${unknown.join(', ')} (one of ${Object.keys(reg.accounts).join(', ')})`)
  const rows = loginExpiry(reg, Date.now(), ids)
  if (json) return void console.log(JSON.stringify({ accounts: rows }, null, 2))
  for (const r of rows) console.log(`${r.id}  ${r.grade}  ${r.detail}`)
}

/** The rows of `usage --json`, from the cache files alone (no Keychain, no network). */
function usageDoc(reg: Registry, now = Date.now()) {
  const cache = readClaudeJson(reg, loadCache())
  const rows = Object.entries(reg.accounts).map(([id, a]) => {
    const x = cache.samples[id]
    const until = cache.exhausted[id]
    return {
      id,
      plan: planTier(a.plan),
      session_limit: hasSessionLimit(a),
      enabled: a.enabled,
      five_hour: x?.s ?? null,
      seven_day: x?.w ?? null,
      five_hour_resets_at: x?.s_reset ?? null,
      seven_day_resets_at: x?.w_reset ?? null,
      age_s: x ? Math.round(newestAge(x, now) / 1000) : null,
      five_hour_age_s: x && x.s !== null && x.s_ts !== null ? Math.round((now - x.s_ts) / 1000) : null,
      seven_day_age_s: x && x.w !== null && x.w_ts !== null ? Math.round((now - x.w_ts) / 1000) : null,
      source: x?.src ?? null,
      auth_ok: !cache.auth_failed[id],
      exhausted_until: until && until * 1000 > now ? until : null,
    }
  })
  return { default_account: defaultAccountId(reg), accounts: rows }
}

function usage(reg: Registry, json: boolean): void {
  const doc = usageDoc(reg)
  const rows = doc.accounts
  if (json) return void console.log(JSON.stringify(doc, null, 2))
  const reset = (e: number | null) => (e ? new Date(e * 1000).toISOString().slice(5, 16).replace('T', ' ') : '-')
  for (const r of rows) {
    console.log(
      `${r.id} ${r.plan}${r.enabled ? '' : ' (disabled)'}  ${r.session_limit ? `5h ${r.five_hour ?? '-'}% ↺${reset(r.five_hour_resets_at)}  ` : ''}7d ${r.seven_day ?? '-'}% ↺${reset(r.seven_day_resets_at)}  age ${r.age_s ?? '-'}s  auth ${r.auth_ok ? 'ok' : 'FAILED'}${r.exhausted_until ? '  EXHAUSTED' : ''}`,
    )
  }
}

// ── health (wake check) ─────────────────────────────────────────────────────────────────────────────────────────

/** The registry's and the machine's integrations; a malformed one is logged and the feature it configures is off (a refresh must still run). */
function integrationsOrNone(): Integrations {
  try {
    return loadIntegrations(registryPath())
  } catch (e) {
    console.error(`claude-account: ${(e as Error).message}`)
    return {}
  }
}

/** This machine's `usage`, `expiry` and pending asks, read in process. */
function localSnapshot(reg: Registry, cfg: NonNullable<Integrations['health']>, nowMs: number) {
  return {
    usage: usageDoc(reg, nowMs),
    expiry: { accounts: loginExpiry(reg, nowMs) },
    pending: localPending(cfg.pending, nowMs),
  }
}

async function health(reg: Registry, argv: string[]): Promise<number> {
  const now = Date.now()
  const cfg = integrationsOrNone().health ?? {}
  const local = cfg.local ?? hostname()
  const mine = localSnapshot(reg, cfg, now)
  const theirs = cfg.peer ? peerSnapshot(cfg.peer, now) : null
  const rows: HealthRow[] = [
    ...gradeMachine(local, mine, cfg.fix),
    ...(cfg.peer && theirs ? gradeMachine(cfg.peer.name, theirs as Parameters<typeof gradeMachine>[1], cfg.fix) : []),
  ]
  // A transport that is only a last resort says so, whatever the format (stderr keeps --json parseable).
  if (cfg.peer && theirs?.note) {
    const note = `NOTE ${cfg.peer.name}: ${theirs.note}`
    if (argv.includes('--json')) console.error(note)
    else console.log(note)
  }
  if (argv.includes('--json')) console.log(JSON.stringify({ state: worst(rows), rows }, null, 2))
  else
    for (const r of rows)
      console.log(
        `${r.state.toUpperCase().padEnd(4)} ${r.machine}/${r.id} ${r.check}: ${r.detail}${r.fix ? `  -> ${r.fix}` : ''}`,
      )
  if (argv.includes('--wake')) {
    // The dialogs the peer could not deliver while this machine slept: push them again now that it is awake.
    if (cfg.peer?.repush)
      for (const p of theirs?.pending ?? [])
        if (p.ageMs < 24 * 3600_000) spawnDetached(fill(cfg.peer.repush, { id: p.id }))
    if (cfg.notify) notifyIfChanged(rows, now, cfg.notify)
  }
  return worst(rows) === 'fail' ? 1 : 0
}

function notifyIfChanged(rows: HealthRow[], nowMs: number, cmd: string[]) {
  const sig = healthSignature(rows)
  const stamp = join(cacheDir(), 'health-notified.json')
  const prev = parseJson(
    (() => {
      try {
        return readFileSync(stamp, 'utf8')
      } catch {
        return ''
      }
    })(),
  ) as { sig?: string; ts?: number } | null
  if (!sig || (prev?.sig === sig && nowMs - (prev.ts ?? 0) < 12 * 3600_000)) return
  const bad = rows
    .filter((r) => r.state !== 'ok')
    .map((r) => `${r.machine}/${r.id}: ${r.detail}`)
    .join('; ')
  const argv = fill(cmd, { message: bad.slice(0, 200) })
  boundedSpawnSync(argv[0], argv.slice(1), { timeoutMs: 10_000 })
  try {
    mkdirSync(dirname(stamp), { recursive: true })
    writeFileSync(stamp, JSON.stringify({ sig, ts: nowMs }))
  } catch {
    // suppressing a repeat is best-effort
  }
}

type Verb = { name: string; usage: string; summary: string; detail: string[]; caller?: string }

/** Every verb `main` dispatches, in help order. `caller` set = a verb meant for a job or a hook, listed apart as "not for agents". */
export const VERBS: Verb[] = [
  {
    name: 'pick',
    usage: 'pick --lane <lane> [--why] [--dry]',
    summary: 'which account to launch on: prints a shell line for the lane',
    detail: [
      '--lane <lane>   the lane asking (interactive, headless, bulk, ...); required',
      '--why           also print `# picked=<id> reason=<r> stale=<bool>`',
      '--dry           answer without refreshing and without a picks.jsonl line (verify suite, previews); deterministic',
      'stdout: `unset CLAUDE_CONFIG_DIR` | `export CLAUDE_CONFIG_DIR=<dir>` | `spill`',
      'exit 0 = an account; 3 = spill (no account has headroom); 4 = registry unreadable (still prints `unset CLAUDE_CONFIG_DIR`)',
      'A due account refreshes detached in the background; a non-interactive lane waits only for an account with no usable sample.',
    ],
  },
  {
    name: 'rank',
    usage: 'rank --lane <lane> [--json]',
    summary: 'every eligible account in rule order (a pure read: no refresh, no picks.jsonl line)',
    detail: ['--lane <lane>   required', '--json           {lane, order:[{account,reason,weight}], at}'],
  },
  {
    name: 'usage',
    usage: 'usage [--json]',
    summary: "every account's quota, from the cache (a file read: no Keychain, no network)",
    detail: ['--json   machine-readable rows'],
  },
  {
    name: 'expiry',
    usage: 'expiry [--json] [--ids a,b]',
    summary: "when each account's login (refresh token) ends, from its own Keychain item",
    detail: [
      '--json        rows carry `grade` (PASS > 7 d, WARN <= 7 d or unreadable, FAIL <= 2 d or past), `default` (owns ~/.claude),',
      '              `severity` (the grade, a non-default account never above WARN), `tier`, `plan_detected`',
      '--ids a,b     only these accounts, disabled ones too (a first login)',
      'Read-only: only the two timestamps and the plan tier leave the Keychain item.',
    ],
  },
  {
    name: 'refresh',
    usage: 'refresh [--ids a,b] [--all]',
    summary:
      'sample enabled, due accounts: peer samples first, then the OAuth usage endpoint, else `claude auth status`',
    detail: [
      '--ids a,b   only these accounts; also retries an auth-failed account before its 30 min cooldown',
      '--all       the login keepalive: ignores the 10 min freshness and the auth cooldown (the 5 min claim still applies);',
      '            exits 1 when an account got neither a fresh sample nor an auth verdict, or is logged in with a stored sample older than 6 h',
      '--claimed a,b   internal: the detached refresh `pick` spawns for accounts it already claimed',
      "Imports the peer machine's samples once per run (integrations.peerUsage, when configured); the usage GET has a 10 s timeout.",
    ],
  },
  {
    name: 'health',
    usage: 'health [--json] [--wake]',
    summary: 'login, quota and waiting-ask health of this machine and its configured peer; exit 1 on any fail',
    detail: [
      '--json   {state, rows}',
      "--wake   run integrations.health.notify (only when the picture changed) and integrations.health.peer.repush for the peer's pending asks younger than 24 h",
      'The peer is read through the first of integrations.health.peer.snapshots that answers (its `note` is printed when that was the last resort).',
    ],
  },
  {
    name: 'account',
    usage: 'account [--badge]',
    summary: 'registry id of this session (CLAUDE_CONFIG_DIR unset = the default account)',
    detail: ['--badge   upper-case id, printed only with more than one enabled account'],
  },
  {
    name: 'fable',
    usage: 'fable',
    summary: "the account `cf` launches on: the registry's `fable` when enabled, else the default",
    detail: [],
  },
  {
    name: 'env',
    usage: 'env <id>',
    summary: 'shell line forcing an enabled account (what `c --account <id>` evals)',
    detail: ['exit 2 when <id> is unknown or disabled'],
  },
  {
    name: 'session',
    usage: 'session <sessionId>',
    summary: 'registry id the session ran on, from the hook log (`c --resume` pins to it)',
    detail: ['exit 1 when unknown or disabled'],
  },
  {
    name: 'latest',
    usage: 'latest [dir]',
    summary: 'id of the newest session transcript for dir, default cwd (`c --continue` pins to it)',
    detail: ['exit 1 when there is none'],
  },
  {
    name: 'record',
    usage: 'record --account <id> --s <pct> [--s-reset <epoch>] [--w <pct>] [--w-reset <epoch>]',
    summary: 'write one quota sample into the cache',
    detail: [
      '--account <id>   the account the sample belongs to',
      '--s / --w         session / weekly percent used',
      '--s-reset / --w-reset   epoch seconds when the window resets',
    ],
    caller: 'the statusline hook (native rate_limits feed)',
  },
  {
    name: 'exhausted',
    usage: 'exhausted --account <id> --until <epoch>',
    summary: 'mark an account limit-hit, honoured by pick until then',
    detail: ['--account <id>   the account that hit its limit', '--until <epoch>   epoch seconds; required'],
    caller: 'none yet (reserved for a limit-event hook; docs/accounts.md)',
  },
]

export function helpText(): string {
  const agents = VERBS.filter((v) => !v.caller)
  const jobs = VERBS.filter((v) => v.caller)
  const line = (v: Verb) => `  claude-account ${v.usage}\n      ${v.summary}`
  return [
    'claude-account — Claude account registry, picker and per-account quota cache (docs/accounts.md)',
    '',
    'Usage: claude-account <verb> [flags]      claude-account <verb> --help   one verb in full',
    '',
    'Verbs:',
    ...agents.map(line),
    '',
    'Not for agents (a job or a hook calls these):',
    ...jobs.map((v) => `${line(v)}\n      caller: ${v.caller}`),
    '',
    'Exit: 0 ok · 1 negative answer (session, latest, health, refresh --all) · 2 usage error · 3 pick spill · 4 pick: registry unreadable',
    'Help never runs a verb: --help, -h and `help` print this text on stdout and exit 0. --version prints the package and its commit.',
    '',
  ].join('\n')
}

export function verbHelp(name: string): string | null {
  const v = VERBS.find((x) => x.name === name)
  if (!v) return null
  return [
    `claude-account ${v.usage}`,
    '',
    v.summary,
    ...(v.detail.length ? ['', ...v.detail.map((d) => `  ${d}`)] : []),
    ...(v.caller ? ['', `Not for agents. Caller: ${v.caller}`] : []),
    '',
  ].join('\n')
}

const HELP_FLAGS = new Set(['--help', '-h'])

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  if (cmd === '--version' || cmd === '-V') {
    console.log(versionLine())
    return 0
  }
  // Help runs before the registry loads and before any verb: it never reads state and never has a side effect.
  if (cmd === undefined || cmd === 'help' || HELP_FLAGS.has(cmd)) {
    const topic = cmd === 'help' ? rest[0] : undefined
    process.stdout.write((topic ? verbHelp(topic) : null) ?? helpText())
    return 0
  }
  const forVerb = verbHelp(cmd)
  if (forVerb === null) {
    console.error(
      `claude-account: unknown verb '${cmd}' (${VERBS.map((v) => v.name).join('|')}); claude-account --help lists them`,
    )
    return 2
  }
  if (rest.some((a) => HELP_FLAGS.has(a))) {
    process.stdout.write(forVerb)
    return 0
  }
  let reg: Registry
  try {
    reg = loadRegistry()
  } catch (e) {
    if (cmd !== 'pick') throw e
    console.error(`claude-account: registry unreadable: ${(e as Error).message}`)
    console.log('unset CLAUDE_CONFIG_DIR') // a pick must always answer: fall back to the default account...
    if (rest.includes('--why')) console.log('# picked=iu reason=registry-error stale=false')
    return REGISTRY_EXIT // ...but never silently: callers warn on 4
  }
  switch (cmd) {
    case 'pick': {
      const lane = flag(rest, '--lane')
      if (!lane) throw new Error('usage: claude-account pick --lane <lane>')
      const now = Date.now()
      // Never block while a usable sample exists: stale accounts refresh in the background (budgeted),
      // only an account with no sample at all is refreshed synchronously first.
      const dry = rest.includes('--dry')
      try {
        const cache0 = readClaudeJson(reg, loadCache())
        if (!dry)
          await refreshBeforePick({
            reg,
            lane,
            now,
            cache: cache0,
            claim: (ids) => claimRefresh(reg, ids, now, cache0),
            runSync: async (ids) => void (await refresh(reg, { claimed: ids, peer: false })),
            detach: (ids) => spawnDetachedRefresh(ids),
          })
      } catch (e) {
        console.error(`claude-account: refresh skipped: ${(e as Error).message}`) // a pick must always answer; go on with the current cache
      }
      const cache = readClaudeJson(reg, loadCache())
      const p = pick(reg, cache, lane, now, dry ? undefined : Math.random) // --dry stays deterministic (verify and previews)
      if (!dry) {
        try {
          mkdirSync(dirname(picksPath()), { recursive: true })
          appendFileSync(picksPath(), `${JSON.stringify(pickLine(reg, cache, lane, p, now))}\n`)
        } catch {
          // the pick log is a dataset, never a gate
        }
      }
      const line = shellLine(reg, p)
      console.log(line ?? SPILL)
      if (rest.includes('--why')) console.log(`# picked=${p.picked} reason=${p.reason} stale=${p.stale}`)
      return line === null ? SPILL_EXIT : 0
    }
    case 'rank': {
      const lane = flag(rest, '--lane')
      if (!lane) throw new Error('usage: claude-account rank --lane <lane> [--json]')
      const now = Date.now()
      const order = rank({ reg, cache: readClaudeJson(reg, loadCache()), lane, nowMs: now })
      if (rest.includes('--json')) console.log(JSON.stringify({ lane, order, at: new Date(now).toISOString() }))
      else order.forEach((e, i) => console.log(`${i + 1}. ${e.account}  ${e.reason}  w=${e.weight!.toFixed(3)}`))
      return 0
    }
    case 'usage':
      usage(reg, rest.includes('--json'))
      return 0
    case 'expiry':
      expiry(reg, rest.includes('--json'), flag(rest, '--ids')?.split(','))
      return 0
    case 'refresh': {
      const all = rest.includes('--all')
      const results = await refresh(reg, {
        ids: flag(rest, '--ids')?.split(','),
        claimed: flag(rest, '--claimed')?.split(','),
        all,
      })
      // The keepalive's verdict: an account that got neither a fresh sample nor an auth verdict was not kept alive.
      const unresolved = Object.entries(results)
        .filter(([, r]) => r === 'unresolved')
        .map(([id]) => id)
      const stale = Object.entries(results)
        .filter(([, r]) => r === 'stale')
        .map(([id]) => id)
      if (all && stale.length)
        console.error(
          `claude-account: refresh --all: ${stale.join(', ')} logged in but still without a fresh sample (stored one older than 6 h or missing, see the lines above)`,
        )
      if (all && unresolved.length)
        console.error(`claude-account: refresh --all: no fresh sample and no auth verdict for ${unresolved.join(', ')}`)
      if (all) askForRelogins(reg, results)
      if (all && (unresolved.length || stale.length)) return 1
      return 0
    }
    case 'health':
      return health(reg, rest)
    case 'record': {
      const id = account(reg, rest)
      const part = {
        s: num(rest, '--s'),
        w: num(rest, '--w'),
        s_reset: num(rest, '--s-reset'),
        w_reset: num(rest, '--w-reset'),
      }
      recordSample(id, part, Date.now(), undefined, hasSessionLimit(reg.accounts[id]))
      return 0
    }
    case 'account': {
      const id = accountFromConfigDir(reg, process.env.CLAUDE_CONFIG_DIR) // null: set to a dir no account owns
      if (!rest.includes('--badge')) console.log(id ?? '?')
      else if (id === null) console.log('?')
      else if (Object.values(reg.accounts).filter((a) => a.enabled).length > 1) console.log(id.toUpperCase())
      return 0
    }
    case 'fable':
      console.log(fableAccount(reg))
      return 0
    case 'env': {
      const id = rest[0]
      const a = id && Object.hasOwn(reg.accounts, id) ? reg.accounts[id] : undefined
      if (!a?.enabled)
        throw new Error(
          `env: '${id ?? ''}' is not an enabled account (${Object.keys(reg.accounts)
            .filter((k) => reg.accounts[k].enabled)
            .join(', ')})`,
        )
      console.log(shellLine(reg, { picked: id, reason: 'forced', stale: false }))
      return 0
    }
    case 'session': {
      const id = rest[0] ? sessionAccount(rest[0], join(homedir(), '.claude', 'logs')) : null
      if (!id || !Object.hasOwn(reg.accounts, id) || !reg.accounts[id].enabled) return 1
      console.log(id)
      return 0
    }
    case 'latest': {
      const id = latestSessionId(join(homedir(), '.claude', 'projects'), rest[0] ?? process.cwd())
      if (!id) return 1
      console.log(id)
      return 0
    }
    case 'exhausted': {
      const id = account(reg, rest)
      const until = num(rest, '--until')
      if (until === null) throw new Error('--until <epoch seconds> is required')
      markExhausted(id, until)
      return 0
    }
    default:
      throw new Error(`verb '${cmd}' is in VERBS but not dispatched`)
  }
}
