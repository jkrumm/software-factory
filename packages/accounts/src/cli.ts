#!/usr/bin/env bun
// claude-account — Claude account registry, picker and per-account quota cache (docs/accounts.md).
//
// Every verb and flag is in VERBS below; `claude-account --help` prints them, `claude-account <verb> --help` one in full.
//
// Idle-account samples: one read-only GET of the OAuth usage endpoint with the account's own Keychain token
// (never copied, logged or written back; on HTTP 401 `claude auth status` renews it first, one retry); `claude -p /usage` no longer refreshes cachedUsageUtilization (2.1.310).
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  type RefreshResult,
  type Registry,
  SPILL,
  defaultAccountId,
  fableAccount,
  modeOf,
  hasSessionLimit,
  reserveBudget,
  reserveHold,
  newestAge,
  POLICY_NAMES,
  isPolicyName,
  livePolicy,
  pick,
  pickLine,
  planTier,
  accountUnits,
  rank,
  ruleTag,
} from './policy.ts'
import { historyDir, picksPath, registryWritePath, shadowPath } from './paths.ts'
import { MEASURED } from './load-model.ts'
import { compareText, disagreement, liveResults, shadowLine, simulateText } from './lab.ts'
import { compare, mixedPool, simulate } from './sim.ts'
import { type ModeView, modeField } from './modes.ts'
import { clearModeOverride, liveAccounts, mergeClaudeJson, setModeOverride } from './read.ts'
import { accountFromConfigDir, loadRegistry, parseRegistry, shellLine } from './registry.ts'
import { claimRefresh, endOverrides, loadCache, markExhausted, recordSample } from './store.ts'
import { readLoginExpiry } from './keychain.ts'
import { httpGet } from './oauth.ts'
import { runRefresh, refreshBeforePick } from './refresh.ts'
import { askRelogins } from './relogin.ts'
import { fillHint, renderCommand, resolveMachine } from './host.ts'
import {
  ADD_PLANS,
  ensureConfigDir,
  leftBehind,
  loginCommand,
  readRegistryJson,
  verifyAccount,
  withAccount,
  withEnabled,
  writeRegistryJson,
} from './onboard.ts'
import { latestSessionId, sessionAccount } from './sessions.ts'
import { spawnDetached, spawner } from './spawn.ts'
import { type HealthRow, gradeMachine, worst } from './health.ts'
import { SSH_OPTS, fetchPeerUsage, machineSnapshot, notifyIfChanged, reloginAsk, spawnLogged } from './owner.ts'
import { versionLine } from './version.ts'
import {
  type HistoryTarget,
  importLines,
  loadHistory,
  readLedger,
  readSampleLines,
  syncLedger,
} from './history-store.ts'
import { parseSampleLine } from './history.ts'
import { buildStatus, resetLine, statusLine } from './status.ts'

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

/** Where the history of this run is written: the sample log and the ledger, each line with the account's mode in force then. */
function historyTarget(reg: () => Registry): HistoryTarget {
  return {
    mode: (id) => {
      const r = reg() // only when a line is written: `record` runs on every statusline render
      return Object.hasOwn(r.accounts, id) ? modeOf(r, id, Date.now()).kind : null
    },
    rule: () => ruleTag(livePolicy(reg())),
  }
}

/** `simulate`: one run of the lab's simulation on the measured load model. */
function simulateVerb(reg: Registry, rest: string[]): number {
  const policy = flag(rest, '--policy') ?? livePolicy(reg)
  if (!isPolicyName(policy)) throw new Error(`--policy must be one of ${POLICY_NAMES.join(', ')}`)
  const sc = {
    accts: mixedPool(num(rest, '--accounts') ?? 3),
    demand: num(rest, '--demand') ?? 1,
    model: MEASURED,
    policy,
    weeks: num(rest, '--weeks') ?? 3,
    seed: num(rest, '--seed') ?? 7,
  }
  const r = simulate(sc)
  console.log(rest.includes('--json') ? JSON.stringify({ ...sc, model: undefined, result: r }) : simulateText(sc, r))
  return 0
}

/** `compare`: every policy over the demand range and the pool sizes, beside the live ledger and the shadow log. */
function compareVerb(reg: Registry, rest: string[]): number {
  const c = compare({ model: MEASURED, weeks: num(rest, '--weeks') ?? 3 })
  const live = liveResults(readLedger(), reg)
  let lines: unknown[] = []
  try {
    lines = readFileSync(shadowPath(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as unknown)
  } catch {
    // no shadow log yet
  }
  const shadow = disagreement(lines)
  if (rest.includes('--json')) console.log(JSON.stringify({ ...c, live, shadow, model: MEASURED.range }))
  else console.log(compareText(c, MEASURED, live, shadow))
  return 0
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
  const enabled = (id: string) => Object.hasOwn(reg.accounts, id) && reg.accounts[id].enabled
  reg = liveAccounts(reg).reg // a reserve (registry or override) is due for its scoped limit
  const peer = resolveMachine(reg.host).peer
  const todo = o.claimed
    ? o.claimed.filter(enabled)
    : claimRefresh(
        reg,
        (o.ids ?? Object.keys(reg.accounts)).filter(enabled),
        Date.now(),
        mergeClaudeJson(reg, loadCache()),
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
    peerUsage: o.peer === false || !peer ? undefined : () => fetchPeerUsage(peer), // the synchronous pick-time refresh never waits on ssh
    machine: resolveMachine(reg.host).name,
    history: historyTarget(() => reg),
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
 * Keepalive only: a dead login, or one inside its last 7 days, asks its owner once per 24 h for a re-login through a
 * native approval dialog (claude-relogin --ask, detached; the dialog is the human's click, nothing runs by itself).
 */
function askForRelogins(reg: Registry, results: Record<string, RefreshResult>): void {
  if (!reg.host?.reloginAsk) return // no host block, no ask: the login is the user's to renew (health names the command)
  const now = Date.now()
  try {
    const o = askRelogins({
      results,
      logins: loginExpiry(reg, now),
      now,
      ask: reloginAsk(reg.host.reloginAsk),
      log: (m) => console.error(`claude-account: ${m}`),
    })
    for (const id of o.asked)
      console.error(`claude-account: asked for a re-login of ${id} (dialog on the MacBook, next ask in 24 h)`)
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

/** `modeField` plus the reserve's `hold` (`account` or `allowance`, null for any other mode): the `mode` of `usage --json` and `mode --json`. */
const modeWithHold = (v: ModeView) => ({
  ...modeField(v),
  hold: v.mode.kind === 'reserve' ? reserveHold(v.mode) : null,
})

const withAge = (list: Record<string, unknown>[] | undefined, ts: number | undefined, now: number) =>
  list && ts !== undefined ? list.map((l) => ({ ...l, age_s: Math.round((now - ts) / 1000) })) : null

function usage(reg0: Registry, json: boolean): void {
  const now = Date.now()
  const { reg, cache, views } = liveAccounts(reg0, now)
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
      // additive (registry v2): the mode in force, the raw override the peer imports, the endpoint's limits with their age
      mode: modeWithHold(views[id]),
      mode_override: views[id].override,
      limits: withAge(x?.limits, x?.limits_ts, now),
      weekly_scoped_shares: withAge(x?.scoped_shares, x?.limits_ts, now),
    }
  })
  if (json) return void console.log(JSON.stringify({ default_account: defaultAccountId(reg), accounts: rows }, null, 2))
  const reset = (e: number | null) => (e ? new Date(e * 1000).toISOString().slice(5, 16).replace('T', ' ') : '-')
  for (const r of rows) {
    console.log(
      `${r.id} ${r.plan}${r.enabled ? '' : ' (disabled)'}  ${r.session_limit ? `5h ${r.five_hour ?? '-'}% ↺${reset(r.five_hour_resets_at)}  ` : ''}7d ${r.seven_day ?? '-'}% ↺${reset(r.seven_day_resets_at)}  age ${r.age_s ?? '-'}s  auth ${r.auth_ok ? 'ok' : 'FAILED'}${r.exhausted_until ? '  EXHAUSTED' : ''}`,
    )
  }
}

// ── mode (overrides) ─────────────────────────────────────────────────────────────────────────────────────────────

function modeVerb(reg0: Registry, rest: string[]): number {
  const now = Date.now()
  const json = rest.includes('--json')
  const id = rest[0] && !rest[0].startsWith('--') ? rest[0] : null
  if (id === null) {
    const { reg, cache, views } = liveAccounts(reg0, now)
    endOverrides(cache, now, { machine: resolveMachine(reg0.host).name })
    const rows = Object.keys(reg.accounts).map((a) => {
      const b = reserveBudget(reg, cache, a, now)
      return {
        id: a,
        ...modeWithHold(views[a]),
        expired: views[a].expired,
        budget: b && {
          for: b.for,
          known: b.known,
          unused: b.unused,
          weekly: b.weekly,
          ceiling: b.ceiling,
          open: b.open,
          released: b.released,
        },
      }
    })
    if (json) {
      console.log(JSON.stringify({ accounts: rows }, null, 2))
      return 0
    }
    const when = (s: string | null) => (s ? new Date(s).toUTCString().slice(0, 22) : '')
    for (const r of rows) {
      const kind = r.kind === 'reserve' ? `reserve for ${r.for}` : r.kind
      const parts = [
        r.id.padEnd(6),
        kind.padEnd(18),
        r.source.padEnd(9),
        r.until ? `until ${r.until}${r.until_at ? ` (${when(r.until_at)})` : ''}` : '',
        r.set_at ? `set ${when(r.set_at)} on ${r.set_on}` : '',
        r.why ? JSON.stringify(r.why) : '',
        r.hold === 'account'
          ? 'holds the account'
          : r.budget
            ? r.budget.known
              ? `budget ${r.budget.open ? 'open' : 'closed'} (${r.budget.weekly! + r.budget.unused!}/${r.budget.ceiling}${r.budget.released ? ', released' : ''})`
              : 'budget unknown: last resort'
            : '',
        r.expired ? '(override ended)' : '',
      ]
      console.log(parts.filter(Boolean).join('  '))
    }
    return 0
  }
  if (!Object.hasOwn(reg0.accounts, id))
    throw new Error(`mode: unknown account '${id}' (${Object.keys(reg0.accounts).join(', ')})`)
  const machine = resolveMachine(reg0.host).name
  if (rest.includes('--clear')) {
    clearModeOverride(id, { nowMs: now, machine })
    console.log(`${id}: override cleared, the registry's mode applies`)
    return 0
  }
  const kind = rest[1] ?? ''
  const model = flag(rest, '--for')
  const hold = flag(rest, '--hold')
  const until = flag(rest, '--until')
  setModeOverride(id, { kind, for: model, until, why: flag(rest, '--why'), hold }, { nowMs: now, machine })
  const shown = until ?? (kind === 'drain' ? 'reset' : null)
  console.log(
    `${id}: ${kind}${model ? ` for ${model}` : ''}${kind === 'reserve' ? ` (holds the ${hold ?? 'account'})` : ''}${shown ? ` until ${shown}` : ''} (override)`,
  )
  return 0
}

// ── status and history ───────────────────────────────────────────────────────────────────────────────────────────

function statusVerb(reg0: Registry, rest: string[]): number {
  const now = Date.now()
  const { reg, cache, views } = liveAccounts(reg0, now)
  const history = Object.fromEntries(Object.keys(reg.accounts).map((id) => [id, loadHistory(id, now)]))
  const status = buildStatus({ reg, cache, views, history, nowMs: now, machine: resolveMachine(reg0.host).name })
  if (rest.includes('--json')) {
    console.log(JSON.stringify(status, null, 2))
    return 0
  }
  for (const a of status.accounts) console.log(statusLine(a, now))
  if (rest.includes('--resets'))
    for (const a of status.accounts) for (const r of a.resets) console.log(resetLine(a.id, r, now))
  return 0
}

/** `history`: the ledger of observed weekly resets; `history import <file>`: sample lines from a file into the log. */
function historyVerb(reg: Registry, rest: string[]): number {
  const now = Date.now()
  const dir = historyDir()
  if (rest[0] === 'import') {
    const path = rest[1]
    if (!path || path.startsWith('--'))
      throw new Error('usage: claude-account history import <file> (one JSON sample line per line)')
    const raw = readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
    const lines = raw.flatMap((l) => {
      try {
        const s = parseSampleLine(JSON.parse(l))
        return s && Object.hasOwn(reg.accounts, s.id) ? [s] : []
      } catch {
        return []
      }
    })
    const r = importLines(dir, lines)
    console.log(
      `history import: ${r.added} lines added, ${r.duplicates} already there, ${raw.length - lines.length} skipped (not a sample line or not a registered account), ${r.resets.length} resets added to the ledger`,
    )
    return 0
  }
  const id = flag(rest, '--id')
  if (id !== null && !Object.hasOwn(reg.accounts, id))
    throw new Error(`history: unknown account '${id}' (${Object.keys(reg.accounts).join(', ')})`)
  syncLedger(dir, id ? [id] : undefined) // the ledger is derived: a log written by an older build or an import gets its lines
  const since = now - (num(rest, '--days') ?? 28) * 86400_000
  const rows = readLedger(dir, id ?? undefined).filter((e) => e.at >= since)
  if (rest.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          since: new Date(since).toISOString(),
          samples: readSampleLines(dir, { id: id ?? undefined, sinceMs: since }).length,
          resets: rows,
        },
        null,
        2,
      ),
    )
    return 0
  }
  for (const e of rows)
    console.log(
      resetLine(
        e.id,
        {
          at: new Date(e.at).toISOString(),
          weekly: e.weekly,
          scoped: e.scoped,
          modes: e.modes,
          rule: e.rule,
          closed_hours: e.closed_hours,
          manual: e.manual,
        },
        now,
      ),
    )
  return 0
}

// ── health (wake check) ─────────────────────────────────────────────────────────────────────────────────────────

async function health(reg: Registry, argv: string[]): Promise<number> {
  const now = Date.now()
  const m = resolveMachine(reg.host)
  const mine = machineSnapshot(null, now)
  const theirs = m.peer ? machineSnapshot(m.peer, now) : null
  // the repair hint: the host block's template, else this machine's own login command (a peer's row has none to offer)
  const fixFor = (machine: string, local: boolean) => (id: string) =>
    reg.host?.reloginFix
      ? fillHint(reg.host.reloginFix, { id, machine })
      : local && Object.hasOwn(reg.accounts, id)
        ? loginCommand(reg.accounts[id])
        : null
  const rows: HealthRow[] = [
    ...gradeMachine(m.name, mine, fixFor(m.name, true)),
    ...(m.peer && theirs ? gradeMachine(m.peer.name, theirs, fixFor(m.peer.name, false)) : []),
  ]
  // The plain-ssh read cannot see the peer's Keychain: say so, whatever the format (stderr keeps --json parseable).
  if (m.peer && theirs?.via === 'ssh' && m.peer.herdrCore) {
    const note = `NOTE ${m.peer.name}: its herdr-core was not reachable, so this read went over plain ssh; Keychain logins may show as unreadable here`
    if (argv.includes('--json')) console.error(note)
    else console.log(note)
  }
  if (argv.includes('--json')) console.log(JSON.stringify({ state: worst(rows), rows }, null, 2))
  else
    for (const r of rows)
      console.log(
        `${r.state.toUpperCase().padEnd(4)} ${r.machine}/${r.id} ${r.check}: ${r.detail}${r.fix ? `  -> ${r.fix}` : ''}`,
      )
  if (argv.includes('--wake') && m.wake) {
    // The dialogs the peer could not deliver while this machine slept: push them again now that it is awake.
    if (m.wake.push && m.peer && theirs)
      for (const p of theirs.pendingIds)
        if (p.ageMs < 24 * 3600_000)
          spawnLogged('ssh', [...SSH_OPTS, ...m.peer.ssh, renderCommand(m.wake.push, { id: p.id })])
    if (m.wake.notify) notifyIfChanged(rows, now, m.wake.notify)
  }
  return worst(rows) === 'fail' ? 1 : 0
}

// ── onboarding: add, verify, remove ──────────────────────────────────────────────────────────────────────────────

function addVerb(rest: string[]): number {
  const id = rest[0] && !rest[0].startsWith('--') ? rest[0] : null
  const plan = flag(rest, '--plan')
  if (!id || !plan)
    throw new Error(`usage: claude-account add <id> --plan <${ADD_PLANS.join('|')}> [--dir <path>] [--lanes <a,b>]`)
  const path = registryWritePath()
  const { raw, account } = withAccount(readRegistryJson(path), {
    id,
    plan,
    dir: flag(rest, '--dir'),
    lanes: flag(rest, '--lanes')?.split(',') ?? null,
  })
  const reg = parseRegistry(raw, path) // never write a registry the readers would refuse
  const dir = ensureConfigDir(account)
  writeRegistryJson(path, raw)
  const u = accountUnits(account)
  console.log(
    `added ${id}: plan ${account.plan} (units session ${u.session}, weekly ${u.weekly}), dir ${account.dir ?? '~/.claude (the default account)'}, lanes ${account.homeLanes.join(',')}, disabled`,
  )
  console.log(`registry: ${path}`)
  console.log('sign in as that account on this machine, then check it:')
  console.log(`  ${loginCommand(account)}`)
  console.log(`  claude-account verify ${id} --enable`)
  const after = reg.host?.afterAdd
  if (!after) return 0
  const r = Bun.spawnSync(['sh', '-c', renderCommand(after, { id, dir, plan: account.plan })], {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: { ...process.env, CLAUDE_ACCOUNT_ID: id, CLAUDE_ACCOUNT_DIR: dir, CLAUDE_ACCOUNT_PLAN: account.plan },
  })
  if (r.exitCode === 0) return 0
  console.error(
    `claude-account: the afterAdd command of the host block exited ${r.exitCode}; ${id} is registered (disabled), run the command again after fixing it`,
  )
  return 1
}

async function verifyVerb(reg: Registry, rest: string[]): Promise<number> {
  const id = rest[0] && !rest[0].startsWith('--') ? rest[0] : null
  if (!id || !Object.hasOwn(reg.accounts, id))
    throw new Error(`usage: claude-account verify <id> [--enable] (${Object.keys(reg.accounts).join(', ')})`)
  const checks = await verifyAccount({
    reg,
    id,
    spawn: spawner,
    httpGet,
    claudeBin: claudeBin(),
    securityBin: process.env.CLAUDE_ACCOUNTS_SECURITY_BIN,
    baseEnv: process.env,
    now: Date.now,
    log: (m) => console.error(m),
  })
  for (const c of checks) console.log(`${id}  ${c.name.padEnd(6)} ${c.ok ? 'ok  ' : 'FAIL'} ${c.detail}`)
  const ok = checks.length === 3 && checks.every((c) => c.ok)
  if (!ok) {
    console.log(`${id}: not verified${rest.includes('--enable') ? ', left as it is' : ''}`)
    return 1
  }
  if (!rest.includes('--enable')) {
    console.log(
      reg.accounts[id].enabled
        ? `${id}: verified (enabled)`
        : `${id}: verified; claude-account verify ${id} --enable enables it`,
    )
    return 0
  }
  if (reg.accounts[id].enabled) console.log(`${id}: verified, already enabled`)
  else {
    const path = registryWritePath()
    writeRegistryJson(path, withEnabled(readRegistryJson(path), id, true))
    console.log(`${id}: verified and enabled in ${path}`)
  }
  return 0
}

function removeVerb(reg: Registry, rest: string[]): number {
  const id = rest[0] && !rest[0].startsWith('--') ? rest[0] : null
  if (!id || !Object.hasOwn(reg.accounts, id))
    throw new Error(`usage: claude-account remove <id> (${Object.keys(reg.accounts).join(', ')})`)
  const path = registryWritePath()
  const was = reg.accounts[id].enabled
  if (was) writeRegistryJson(path, withEnabled(readRegistryJson(path), id, false))
  console.log(`${id}: ${was ? 'disabled' : 'already disabled'}: it takes no work and is out of every rank`)
  const others = Object.entries(reg.accounts).filter(([k, a]) => k !== id && a.enabled).length
  if (was && others === 0)
    console.log('note: no enabled account is left; pick will answer unset CLAUDE_CONFIG_DIR or spill')
  console.log('left on disk:')
  for (const l of leftBehind(reg, id, path)) console.log(`  ${l}`)
  return 0
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
    name: 'status',
    usage: 'status [--json] [--resets]',
    summary:
      'one line per account, led by its forecast; --json is the whole read model (per lane: open, place, why not, when it opens)',
    detail: [
      'plain: `me2 drain until reset · weekly 92 % · full Fri 14:00 · resets Sat 18:00`; a closed account adds why and when it opens',
      '--resets   also the last resets of each account (the ledger)',
      "--json     {schema, at, machine, rule, lanes, accounts:[{limits, mode, reserve, closed, lanes, forecast, resets}]}; every lane's order is `rank`'s",
      'The forecast is burn-rate-24h-v1: the weekly percent at the reset if the last 24 h of burn goes on (docs/accounts.md §History).',
      'A file read: no Keychain, no network.',
    ],
  },
  {
    name: 'history',
    usage: 'history [--json] [--id <id>] [--days n] | history import <file>',
    summary:
      'the reset ledger: every observed weekly reset with the last weekly and scoped percent before it, the modes of that week, hours closed',
    detail: [
      '--days n     resets of the last n days (default 28)',
      'import <f>   adds sample lines (JSON per line: ts in epoch ms, id, s, s_reset, w, w_reset, scoped) to the sample log and the ledger they imply;',
      '             lines already in the log (same account and time) are skipped',
      '~/.local/share/claude-accounts/samples-YYYY-MM.jsonl and resets.jsonl ($CLAUDE_ACCOUNTS_HISTORY is the directory)',
    ],
  },
  {
    name: 'simulate',
    usage: 'simulate [--policy <name>] [--demand <x>] [--accounts <n>] [--weeks <n>] [--seed <n>] [--json]',
    summary:
      "one run of the policy lab's simulation on the measured load model: each account's weekly % at its resets, blocked work, moved sessions",
    detail: [
      `--policy <name>   ${POLICY_NAMES.join(' | ')}; default the live one (the registry's \`policy\`)`,
      "--demand <x>      the pool's demand as a share of its weekly capacity (default 1)",
      '--accounts <n>    1..8 accounts of mixed plans (one Ultra, then Max and Ultra with staggered resets; default 3)',
      '--weeks <n>       simulated weeks (default 3; resets of the first week are warm-up)',
      "--seed <n>        the run's random seed (default 7)",
      'The load model (session length, burn, 5 h share of a week, demand curve, lane mix) is packages/accounts/src/load-model.json,',
      'measured by packages/accounts/scripts/measure-load.ts (docs/accounts.md §The policy lab). A pure computation: no file is read.',
    ],
  },
  {
    name: 'compare',
    usage: 'compare [--weeks <n>] [--json]',
    summary:
      'every policy over demand 0.85..1.2 and 1, 2, 3, 5 and 8 accounts, the verdict against v1.9, the live ledger per policy, the shadow log',
    detail: [
      '--weeks <n>   simulated weeks per run (default 3)',
      'Each cell is the mean of 10 seeded runs: used at reset (capacity-weighted) / blocked / moved sessions.',
      'A candidate beats v1.9 with more quota used beyond 2 standard errors of the paired difference, no more moved sessions,',
      'and no more work blocked at demand 1.0 or below.',
      'The live rows group the reset ledger by the rule each week ran under; the shadow rows are disagreement rates only.',
    ],
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
      "Imports the peer machine's samples once per run (`usage --json` over ssh); the usage GET has a 10 s timeout.",
    ],
  },
  {
    name: 'health',
    usage: 'health [--json] [--wake]',
    summary: 'login, quota and waiting-ask health of this machine and its peer; exit 1 on any fail',
    detail: [
      '--json   {state, rows}',
      "--wake   notify (MacBook, only when the picture changed) and re-push the peer's pending ask dialogs younger than 24 h",
      'The peer is read through its herdr-core, plain ssh only when no core answers (with a NOTE line).',
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
    summary: 'the account `cf` launches on: the open reserve-for-fable account with the most unused allowance',
    detail: [
      "none open: the first enabled reserve-for-fable account (the registry's `fable` in v1); none at all: the default account",
    ],
  },
  {
    name: 'mode',
    usage:
      'mode [--json] | mode <id> <normal|drain|reserve|paused> [--for <model>] [--hold account|allowance] [--until reset|<iso>] [--why <text>] | mode <id> --clear',
    summary: "every account's mode in force with its source, expiry and why; or set / clear an override",
    detail: [
      "no id         every account: mode, source (override | registry), until, set, why, a reserve's budget",
      '<id> <mode>   an override in the state file (~/.local/share/claude-accounts/modes.json), one audit line each;',
      '              the peer machine adopts it at its next refresh',
      '--for <model> reserve only, required: the model the account is kept for (fable)',
      "--hold        reserve only: account (default: the last resort for every pick but the model's launcher) or allowance (only the",
      "              model's unused weekly allowance, inside a budget; released in the last 24 h)",
      '--until       reset (the next observed weekly reset, a manual one too) or an ISO time; drain defaults to reset',
      '--why <text>  shown wherever the mode is',
      '--clear       remove the override (a tombstone, so the peer drops it too)',
      'exit 2 on an unknown id or mode, a reserve without --for, an --until that is past',
    ],
  },
  {
    name: 'add',
    usage: 'add <id> --plan <max|ultra> [--dir <path>] [--lanes <a,b>]',
    summary: 'register a new account, disabled, and print the login command for this machine',
    detail: [
      '<id>           letters, digits, _ and -; it names the cache files',
      '--plan         max (5 h session window and weekly) or ultra (weekly only); units come from the plan table',
      '--dir <path>   the config directory; default ~/.claude-<id>, and the first account of a registry takes the default ~/.claude (dir null)',
      '--lanes a,b    the lanes whose spawns start here; default interactive,headless for the default account, bulk for the others',
      "Creates the registry when there is none (~/.config/claude-accounts/registry.json) and the config directory, runs the host block's afterAdd command",
      'when there is one, and prints the login command and the verify command. The account takes no work until `verify <id> --enable`.',
      'exit 2 on a bad id, plan, dir or lane list, or an id already registered; 1 when the afterAdd command failed',
    ],
  },
  {
    name: 'verify',
    usage: 'verify <id> [--enable]',
    summary: 'check an account on this machine: the login, the plan, a readable sample',
    detail: [
      "login    `claude auth status` for the account's config directory says logged in",
      'plan     the plan the login item reports (max or ultra) is the registered one',
      "sample   a weekly quota sample can be read (the usage endpoint with the account's own token, else its own cached usage); it lands in the cache",
      '--enable  enable the account when all three pass (a disabled account is checked all the same)',
      'exit 0 verified; 1 a check failed (nothing is changed); 2 unknown account',
    ],
  },
  {
    name: 'remove',
    usage: 'remove <id>',
    summary: 'disable an account and name what it leaves on disk',
    detail: [
      'Sets enabled: false: no pick, rank or refresh touches it. The registry entry, the config directory, the login, the cache files and the history stay;',
      'the output lists each with where it is and how to delete it. Running it again changes nothing.',
      'exit 2 on an unknown account',
    ],
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
  if (cmd === 'add') return addVerb(rest) // the one verb that starts from no registry
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
        const { reg: applied0, cache: cache0 } = liveAccounts(reg, now)
        if (!dry)
          await refreshBeforePick({
            reg: applied0,
            lane,
            now,
            cache: cache0,
            claim: (ids) => claimRefresh(applied0, ids, now, cache0),
            runSync: async (ids) => void (await refresh(reg, { claimed: ids, peer: false })),
            detach: (ids) => spawnDetachedRefresh(ids),
          })
      } catch (e) {
        console.error(`claude-account: refresh skipped: ${(e as Error).message}`) // a pick must always answer; go on with the current cache
      }
      const { reg: applied, cache } = liveAccounts(reg, now)
      // --dry stays deterministic (verify and previews); a live pick keeps its draws for the shadow policies
      const draws: number[] = []
      const rng = () => {
        const v = Math.random()
        draws.push(v)
        return v
      }
      const p = pick(applied, cache, lane, now, dry ? undefined : rng)
      if (!dry) {
        try {
          mkdirSync(dirname(picksPath()), { recursive: true })
          appendFileSync(picksPath(), `${JSON.stringify(pickLine(reg, cache, lane, p, now))}\n`)
        } catch {
          // the pick log is a dataset, never a gate
        }
        try {
          mkdirSync(dirname(shadowPath()), { recursive: true })
          appendFileSync(shadowPath(), `${JSON.stringify(shadowLine(applied, cache, lane, now, p, draws))}\n`)
        } catch {
          // so is the shadow log
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
      const order = rank({ ...liveAccounts(reg, now), lane, nowMs: now })
      if (rest.includes('--json')) console.log(JSON.stringify({ lane, order, at: new Date(now).toISOString() }))
      else order.forEach((e, i) => console.log(`${i + 1}. ${e.account}  ${e.reason}  w=${e.weight!.toFixed(3)}`))
      return 0
    }
    case 'usage':
      usage(reg, rest.includes('--json'))
      return 0
    case 'status':
      return statusVerb(reg, rest)
    case 'history':
      return historyVerb(reg, rest)
    case 'simulate':
      return simulateVerb(reg, rest)
    case 'compare':
      return compareVerb(reg, rest)
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
      recordSample(
        id,
        part,
        Date.now(),
        undefined,
        hasSessionLimit(reg.accounts[id]),
        historyTarget(() => liveAccounts(reg).reg),
      )
      endOverrides(loadCache(), Date.now(), { machine: resolveMachine(reg.host).name })
      return 0
    }
    case 'account': {
      const id = accountFromConfigDir(reg, process.env.CLAUDE_CONFIG_DIR) // null: set to a dir no account owns
      if (!rest.includes('--badge')) console.log(id ?? '?')
      else if (id === null) console.log('?')
      else if (Object.values(reg.accounts).filter((a) => a.enabled).length > 1) console.log(id.toUpperCase())
      return 0
    }
    case 'fable': {
      const now = Date.now()
      const { reg: applied, cache } = liveAccounts(reg, now)
      console.log(fableAccount(applied, cache, now))
      return 0
    }
    case 'mode':
      return modeVerb(reg, rest)
    case 'verify':
      return verifyVerb(reg, rest)
    case 'remove':
      return removeVerb(reg, rest)
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
