// Runtime mode overrides (docs/accounts.md §Modes): the pure half. The state file holds one record per account, newest
// `set_at` wins (a last-writer-wins register per account, ties broken by the machine name), and a clear is a tombstone
// so it wins on the other machine too. Reading, expiry and the peer merge are here; the file lives in store.ts.
import {
  type Cache,
  type Hold,
  type Mode,
  type ModeKind,
  type Registry,
  type Sample,
  HOLDS,
  MODE_KINDS,
  RESET_JUMP_S,
  isNum,
  modeOf,
  untilPassed,
} from './policy.ts'

/** One account's override as the state file and `usage --json` (`mode_override`) carry it. */
export interface OverrideRecord {
  kind?: ModeKind
  for?: string | null
  hold?: Hold | null
  until?: string | null
  why?: string | null
  /** epoch ms */
  set_at: number
  set_on: string
  /** the account's weekly reset (epoch s) when the override was set: what `until: reset` measures against */
  baseline_w_reset?: number | null
  cleared?: boolean
}
export interface OverrideState {
  version: 1
  accounts: Record<string, OverrideRecord>
}
export const emptyOverrides = (): OverrideState => ({ version: 1, accounts: {} })

const strOrNull = (v: unknown) => v === undefined || v === null || typeof v === 'string'

export function isOverrideRecord(v: unknown): v is OverrideRecord {
  const r = v as OverrideRecord | null
  if (!r || typeof r !== 'object' || !isNum(r.set_at) || typeof r.set_on !== 'string') return false
  if (r.cleared === true) return true
  return (
    MODE_KINDS.includes(r.kind as ModeKind) &&
    strOrNull(r.for) &&
    (r.hold === undefined || r.hold === null || HOLDS.includes(r.hold)) &&
    strOrNull(r.until) &&
    strOrNull(r.why) &&
    (r.baseline_w_reset === undefined || r.baseline_w_reset === null || isNum(r.baseline_w_reset)) &&
    (r.kind !== 'reserve' || typeof r.for === 'string')
  )
}

/** The state as read from disk: a malformed record is dropped, a malformed file is an empty state (never a crash). */
export function parseOverrides(raw: unknown): OverrideState {
  const accounts = (raw as { accounts?: unknown } | null)?.accounts
  if (!accounts || typeof accounts !== 'object') return emptyOverrides()
  return {
    version: 1,
    accounts: Object.fromEntries(Object.entries(accounts).filter(([, r]) => isOverrideRecord(r))),
  }
}

/** `a` replaces `b`: set later, or at the same ms on a machine whose name sorts later (both machines agree). */
export const newerRecord = (a: OverrideRecord, b: OverrideRecord | undefined): boolean =>
  !b || a.set_at > b.set_at || (a.set_at === b.set_at && a.set_on > b.set_on)

/** When an override ends (epoch ms): its ISO time, or for `reset` the scheduled weekly reset it was set in; null = open-ended. */
export function untilAt(r: OverrideRecord): number | null {
  if (!r.until) return null
  if (r.until === 'reset') return isNum(r.baseline_w_reset) ? r.baseline_w_reset * 1000 : null
  const t = Date.parse(r.until)
  return Number.isNaN(t) ? null : t
}

/**
 * Ended at `nowMs`. `until: reset` ends at the scheduled reset it was set in, when a later sample's weekly reset lies more
 * than a day past it, or when a reset was observed after it was set (a manual reset ends it as a scheduled one does).
 */
export function overrideExpired(
  r: OverrideRecord,
  sample: Sample | undefined,
  cache: Cache,
  id: string,
  nowMs: number,
): boolean {
  if (r.cleared) return true
  if (r.until !== 'reset') return untilPassed(r.until, nowMs)
  const base = isNum(r.baseline_w_reset) ? r.baseline_w_reset : null
  if (base !== null && nowMs >= base * 1000) return true
  if (base !== null && sample?.w_reset != null && sample.w_reset - base > RESET_JUMP_S) return true
  // a reset seen after the set counts unless the window it closed had already ended before the set (a late-arriving rollover)
  const seen = cache.resets?.[id]
  return !!seen && seen.at > r.set_at && !(seen.w_reset_before !== null && seen.w_reset_before * 1000 <= r.set_at)
}

export interface ModeView {
  mode: Mode
  source: 'override' | 'registry'
  /** the raw record, a tombstone or an expired one included; null when the state file has none */
  override: OverrideRecord | null
  /** the account has a record that is no longer in force (ended or cleared) */
  expired: boolean
  /** when the mode in force ends (epoch ms), null when open-ended or unknown */
  until_at: number | null
}

/** Every account's mode in force with its source: the live override, else the registry (its `mode`, then the v1 keys). */
export function resolveModes(
  reg: Registry,
  state: OverrideState,
  cache: Cache,
  nowMs: number,
): Record<string, ModeView> {
  const out: Record<string, ModeView> = {}
  for (const id of Object.keys(reg.accounts)) {
    const r = Object.hasOwn(state.accounts, id) ? state.accounts[id] : undefined
    const live = r && !overrideExpired(r, cache.samples[id], cache, id, nowMs) ? r : undefined
    if (live) {
      out[id] = {
        mode: {
          kind: live.kind!,
          for: live.for ?? null,
          ...(live.hold ? { hold: live.hold } : {}),
          until: live.until ?? null,
          why: live.why ?? null,
        },
        source: 'override',
        override: r!,
        expired: false,
        until_at: untilAt(live),
      }
      continue
    }
    const mode = modeOf(reg, id, nowMs)
    const t = mode.until ? Date.parse(mode.until) : Number.NaN
    out[id] = { mode, source: 'registry', override: r ?? null, expired: !!r, until_at: Number.isNaN(t) ? null : t }
  }
  return out
}

/** The registry the rule reads: every live override put in its account's `mode` (the rest untouched). */
export function applyModes(reg: Registry, views: Record<string, ModeView>): Registry {
  const live = Object.entries(views).filter(([, v]) => v.source === 'override')
  if (!live.length) return reg
  return {
    ...reg,
    accounts: {
      ...reg.accounts,
      ...Object.fromEntries(live.map(([id, v]) => [id, { ...reg.accounts[id], mode: v.mode }])),
    },
  }
}

/** The weekly reset an override `until: reset` is measured against: the sample's, moved a week on while it lies in the past. */
export function baselineReset(sample: Sample | undefined, nowMs: number): number | null {
  let r = sample?.w_reset ?? null
  if (r === null) return null
  while (r * 1000 <= nowMs) r += 7 * 24 * 3600
  return r
}

const isoOf = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString())

/** The `mode` field of `usage --json`, `mode --json` and `status --json`: the mode in force with its source (docs/accounts.md §usage --json). */
export function modeField(v: ModeView) {
  const live = v.source === 'override' ? v.override : null
  return {
    kind: v.mode.kind,
    for: v.mode.for ?? null,
    until: v.mode.until ?? null,
    until_at: isoOf(v.until_at),
    why: v.mode.why ?? null,
    source: v.source,
    set_at: isoOf(live?.set_at),
    set_on: live?.set_on ?? null,
  }
}
