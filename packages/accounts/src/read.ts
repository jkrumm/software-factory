// The library face of the accounts: what a process that is not the CLI (the factory server) calls to read the one model and to
// set or clear a mode override. The CLI's reading verbs run on the same functions, so the picker, `claude-account status` and
// the server cannot disagree (packages/accounts/docs/accounts.md §status). Every location defaults to the CLI's (paths.ts); a caller may hand
// others in (a test does).
import {
  type Cache,
  type ModeKind,
  type Registry,
  HOLDS,
  type Hold,
  MODE_KINDS,
  mergeSample,
  withoutSessionWindows,
} from './policy.ts'
import { accountUnits } from './policy.ts'
import { type ModeView, type OverrideRecord, applyModes, baselineReset, resolveModes } from './modes.ts'
import { loadRegistry, readClaudeJsonSample } from './registry.ts'
import { loadCache, loadOverrides, writeOverride } from './store.ts'
import { loadHistory, readLedger } from './history-store.ts'
import { type QuotaAtReset, type QuotaAtResetWeek, quotaUsedAtReset, quotaUsedAtResetIn } from './history.ts'
import { buildStatus, type Status } from './status.ts'
import { resolveMachine } from './host.ts'
import { readHealthCache } from './health-cache.ts'

/** Where the registry, the cache, the mode overrides and the history live; absent: the CLI's defaults (`paths.ts`). */
export interface AccountPaths {
  registry?: string
  cacheDir?: string
  modes?: string
  history?: string
}

/** Merge each enabled account's own .claude.json cachedUsageUtilization into the cache. */
export function mergeClaudeJson(reg: Registry, cache: Cache): Cache {
  for (const [id, a] of Object.entries(reg.accounts)) {
    if (!a.enabled) continue
    const s = readClaudeJsonSample(a) // a missing or unreadable .claude.json: the account simply has no sample
    if (s) cache = { ...cache, samples: { ...cache.samples, [id]: mergeSample(cache.samples[id] ?? null, s) } }
  }
  return withoutSessionWindows(reg, cache) // a plan without a 5 h window never shows or judges a leftover session half
}

/** What every reading verb works on: the cache, each account's mode in force, and the registry with the live overrides applied. */
export function liveAccounts(
  reg0: Registry,
  nowMs = Date.now(),
  paths: AccountPaths = {},
): { reg: Registry; cache: Cache; views: Record<string, ModeView> } {
  const cache = mergeClaudeJson(reg0, loadCache(paths.cacheDir))
  const views = resolveModes(reg0, loadOverrides(paths.modes), cache, nowMs)
  return { reg: applyModes(reg0, views), cache, views }
}

/**
 * `claude-account status` as a value: every account with its limits, mode, lanes (place and why not), forecast and last resets.
 * `history: false` skips the sample log and the ledger (the forecast and the resets are then empty): what a poll that only
 * needs the lanes asks.
 */
export function readStatus(
  o: { nowMs?: number; paths?: AccountPaths; history?: boolean; machine?: string } = {},
): Status {
  const nowMs = o.nowMs ?? Date.now()
  const reg0 = loadRegistry(o.paths?.registry)
  const { reg, cache, views } = liveAccounts(reg0, nowMs, o.paths)
  const history =
    o.history === false
      ? {}
      : Object.fromEntries(Object.keys(reg.accounts).map((id) => [id, loadHistory(id, nowMs, o.paths?.history)]))
  return buildStatus({
    reg,
    cache,
    views,
    history,
    nowMs,
    machine: o.machine ?? resolveMachine(reg.host).name,
    health: readHealthCache(o.paths?.cacheDir),
  })
}

/** A mode override as a caller states it; `until` is an ISO time or `reset` (the account's next weekly reset). */
export interface ModeRequest {
  kind: string
  for?: string | null
  until?: string | null
  why?: string | null
  /** a reserve only: `account` (default) holds the whole account, `allowance` keeps the budget */
  hold?: string | null
}

/**
 * Sets the mode override of one account (packages/accounts/docs/accounts.md §Modes) and returns the record written. `drain` without an `until`
 * lasts to the account's weekly reset. Throws an Error that says what is wrong with the request.
 */
export function setModeOverride(
  id: string,
  req: ModeRequest,
  o: { nowMs?: number; paths?: AccountPaths; machine?: string } = {},
): OverrideRecord {
  const now = o.nowMs ?? Date.now()
  const reg0 = loadRegistry(o.paths?.registry)
  if (!Object.hasOwn(reg0.accounts, id))
    throw new Error(`mode: unknown account '${id}' (${Object.keys(reg0.accounts).join(', ')})`)
  const kind = req.kind as ModeKind
  if (!MODE_KINDS.includes(kind)) throw new Error(`mode: <mode> must be one of ${MODE_KINDS.join(', ')}, or --clear`)
  const model = req.for ?? null
  if (kind === 'reserve' && !model) throw new Error('mode: reserve needs --for <model>')
  if (kind !== 'reserve' && model) throw new Error('mode: --for belongs to reserve only')
  const hold = req.hold ?? null
  if (hold !== null && kind !== 'reserve') throw new Error('mode: --hold belongs to reserve only')
  if (hold !== null && !HOLDS.includes(hold as Hold))
    throw new Error(`mode: --hold must be ${HOLDS.join(' or ')}, not '${hold}'`)
  const until = req.until ?? (kind === 'drain' ? 'reset' : null)
  if (until !== null && until !== 'reset') {
    const t = Date.parse(until)
    if (Number.isNaN(t)) throw new Error(`mode: --until must be reset or an ISO time, not '${until}'`)
    if (t <= now) throw new Error(`mode: --until ${until} is already past`)
  }
  const cache = mergeClaudeJson(reg0, loadCache(o.paths?.cacheDir))
  const machine = o.machine ?? resolveMachine(reg0.host).name
  const record: OverrideRecord = {
    kind,
    for: model,
    ...(kind === 'reserve' ? { hold: (hold as Hold | null) ?? 'account' } : {}),
    until,
    why: req.why ?? null,
    set_at: now,
    set_on: machine,
    baseline_w_reset: until === 'reset' ? baselineReset(cache.samples[id], now) : null,
  }
  writeOverride(id, record, { action: 'set', machine, nowMs: now, ...(o.paths?.modes ? { path: o.paths.modes } : {}) })
  return record
}

/** Clears the override of one account (a tombstone: it wins on the other machine too); the registry's mode applies again. */
export function clearModeOverride(
  id: string,
  o: { nowMs?: number; paths?: AccountPaths; machine?: string } = {},
): void {
  const now = o.nowMs ?? Date.now()
  const reg0 = loadRegistry(o.paths?.registry)
  if (!Object.hasOwn(reg0.accounts, id))
    throw new Error(`mode: unknown account '${id}' (${Object.keys(reg0.accounts).join(', ')})`)
  const machine = o.machine ?? resolveMachine(reg0.host).name
  writeOverride(
    id,
    { cleared: true, set_at: now, set_on: machine },
    { action: 'clear', machine, nowMs: now, ...(o.paths?.modes ? { path: o.paths.modes } : {}) },
  )
}

/** The weekly capacity of each account of the registry, in units: the weights of the KPI "quota used at reset". */
const weeklyUnitsOf = (registry?: string): Record<string, number> =>
  Object.fromEntries(Object.entries(loadRegistry(registry).accounts).map(([id, a]) => [id, accountUnits(a).weekly]))

/** The KPI "quota used at reset" (`quotaUsedAtReset`) over the ledger of this machine's history directory, per week. */
export function readQuotaAtReset(o: { nowMs?: number; weeks: number; paths?: AccountPaths }): QuotaAtResetWeek[] {
  return quotaUsedAtReset({
    entries: readLedger(o.paths?.history),
    weeklyUnits: weeklyUnitsOf(o.paths?.registry),
    nowMs: o.nowMs ?? Date.now(),
    weeks: o.weeks,
  })
}

/** The same figure over any span (epoch ms, `to` exclusive): what the KPI of a window of days asks. */
export function readQuotaAtResetIn(o: { from: number; to: number; paths?: AccountPaths }): QuotaAtReset {
  return quotaUsedAtResetIn({
    entries: readLedger(o.paths?.history),
    weeklyUnits: weeklyUnitsOf(o.paths?.registry),
    from: o.from,
    to: o.to,
  })
}
