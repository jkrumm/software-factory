// `claude-account status` (docs/accounts.md §status): the one read model of the accounts. Pure over a snapshot of the registry,
// the cache, the modes in force, the history and the clock; the CLI hands the snapshot in and prints the result.
import {
  type Cache,
  type Registry,
  type Sample,
  CLOSED_CODES,
  SESSION_MAX,
  accountUnits,
  closure,
  defaultAccountId,
  hasSessionLimit,
  isNum,
  livePolicy,
  planTier,
  rank,
  required,
  ruleTag,
  reserveBudget,
  weeklyCeiling,
  withoutSessionWindows,
  isDrain,
  weeklyCeiling as ceilingOf,
} from './policy.ts'
import { type ModeView, modeField } from './modes.ts'
import { type Forecast, type Held, type ResetEntry, forecastWeekly } from './history.ts'

export const STATUS_SCHEMA_VERSION = 1

/** One account's history as `status` reads it: the week still running (replayAccount's `week`) and its ledger. */
export interface AccountHistory {
  week: Held[]
  resets: ResetEntry[]
}

export interface StatusInput {
  reg: Registry
  cache: Cache
  views: Record<string, ModeView>
  history: Record<string, AccountHistory>
  nowMs: number
  machine: string
}

/** How many past resets each account row lists. */
export const STATUS_RESETS = 8

const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString())
const isoS = (s: number | null | undefined) => (s === null || s === undefined ? null : iso(s * 1000))

/** The lanes status answers for: interactive, bulk, every exact home lane, and `other` for a lane no account claims. */
export function statusLanes(reg: Registry): string[] {
  const homes = Object.values(reg.accounts).flatMap((a) => a.homeLanes.filter((l) => !l.endsWith(':*')))
  return [...new Set(['interactive', 'bulk', ...homes, 'other'])]
}

export interface LaneStatus {
  open: boolean
  /** 1-based place in `rank --lane <lane>`, null when closed */
  position: number | null
  /** the rule's reason for the place (`rank`'s), null when closed */
  reason: string | null
  /** why the account takes no work, one of CLOSED_CODES, null when open */
  closed: (typeof CLOSED_CODES)[number] | null
  /** the reason in plain words, null when open */
  why: string | null
  /** when it takes work again, as far as the sample says */
  opens_at: string | null
}

const pct = (n: number | null) => (n === null ? '?' : `${Math.round(n * 10) / 10}`)

/** The plain-words reason of a closure (docs/accounts.md §status). */
function closedWhy(
  code: (typeof CLOSED_CODES)[number],
  x: Sample | undefined,
  a: { ceiling: number; model?: string | null; mode?: string },
): string {
  switch (code) {
    case 'disabled':
      return 'not set up (enabled: false in the registry)'
    case 'paused':
      return 'paused by its mode: sampled and checked, takes no work'
    case 'auth':
      return 'its login failed the last check on this machine'
    case 'no-sample':
      return 'no quota sample younger than 6 h to judge it by'
    case 'session-max':
      return `its 5 h window is at ${pct(x?.s ?? null)} % (limit ${SESSION_MAX})`
    case 'weekly-ceiling':
      return `weekly at ${pct(x?.w ?? null)} %, at its ceiling of ${a.ceiling} %${a.mode === 'drain' ? ' (drain)' : ''}`
    case 'exhausted':
      return 'a limit hit marked it out until the window resets'
    case 'reserve-budget':
      return `holding the unused ${a.model ?? 'model'} allowance: weekly plus the allowance is at its ceiling of ${a.ceiling} %`
  }
}

export interface AccountStatus {
  id: string
  plan: string
  units: { session: number; weekly: number }
  enabled: boolean
  auth_ok: boolean
  exhausted_until: string | null
  limits: Record<string, unknown>[]
  mode: ReturnType<typeof modeField> & { expired: boolean }
  reserve: { for: string; known: boolean; unused: number | null; budget_left: number | null; released: boolean } | null
  /** the first reason it takes no work in any lane, null when it is open */
  closed: { closed: (typeof CLOSED_CODES)[number]; why: string; opens_at: string | null } | null
  lanes: Record<string, LaneStatus>
  forecast: (Omit<Forecast, 'full_at'> & { full_at: string | null }) | null
  resets: {
    at: string
    weekly: number | null
    scoped: number | null
    modes: string[]
    rule: string | null
    closed_hours: number
    manual: boolean
  }[]
}

export interface Status {
  schema: number
  at: string
  machine: string
  rule: string
  default_account: string
  lanes: string[]
  accounts: AccountStatus[]
}

const limitsOf = (x: Sample | undefined, hasSession: boolean, nowMs: number): Record<string, unknown>[] => {
  if (!x) return []
  const age = (ts: number | null | undefined) => (isNum(ts) ? Math.round((nowMs - ts) / 1000) : null)
  const out: Record<string, unknown>[] = []
  if (hasSession && x.s !== null)
    out.push({ kind: 'session', percent: x.s, resets_at: isoS(x.s_reset), age_s: age(x.s_ts), source: x.src })
  if (x.w !== null)
    out.push({ kind: 'weekly_all', percent: x.w, resets_at: isoS(x.w_reset), age_s: age(x.w_ts), source: x.src })
  // the scoped limits come from the endpoint only: the sample keeps them as it was given, with the age of that fetch
  ;(x.limits ?? []).forEach((l, i) => {
    if (l.kind !== 'weekly_scoped') return
    const m = (l.scope as { model?: { display_name?: unknown; id?: unknown } } | null)?.model
    const name = typeof m?.display_name === 'string' ? m.display_name : typeof m?.id === 'string' ? m.id : null
    const share = x.scoped_shares?.find((s) => s.limit_index === i)
    out.push({
      kind: 'weekly_scoped',
      model: name,
      percent: isNum(l.percent) ? l.percent : null,
      resets_at: typeof l.resets_at === 'string' ? l.resets_at : isoS(x.w_reset),
      age_s: age(x.limits_ts),
      source: 'oauth',
      allowance_percent_of_weekly: isNum(share?.allowance_percent_of_weekly) ? share.allowance_percent_of_weekly : null,
      used_percent_of_weekly: isNum(share?.used_percent_of_weekly) ? share.used_percent_of_weekly : null,
    })
  })
  return out
}

/** Every account with its limits, its mode, whether it takes work per lane and why not, its forecast and its last resets. */
export function buildStatus(i: StatusInput): Status {
  const { reg, nowMs } = i
  const cache = withoutSessionWindows(reg, i.cache)
  const lanes = statusLanes(reg)
  const order = Object.fromEntries(lanes.map((lane) => [lane, rank({ reg, cache, lane, nowMs })]))
  const accounts = Object.entries(reg.accounts).map(([id, a]): AccountStatus => {
    const x = cache.samples[id]
    const view = required(i.views, id)
    const hist = i.history[id] ?? { week: [], resets: [] }
    const units = accountUnits(a)
    const drain = isDrain(reg, id, nowMs)
    const b = reserveBudget(reg, cache, id, nowMs)
    const cl = closure(reg, cache, id, nowMs)
    const ctx = {
      ceiling: weeklyCeiling(x?.w_reset ?? null, nowMs, drain),
      model: view.mode.for ?? null,
      mode: view.mode.kind,
    }
    const why = (code: (typeof CLOSED_CODES)[number]) => closedWhy(code, x, ctx)
    const until = cache.exhausted[id]
    const laneStatus = Object.fromEntries(
      lanes.map((lane): [string, LaneStatus] => {
        const rows = required(order, lane)
        const at = rows.findIndex((e) => e.account === id)
        const hit = rows[at]
        if (hit)
          return [lane, { open: true, position: at + 1, reason: hit.reason, closed: null, why: null, opens_at: null }]
        // closure() is null exactly for the accounts rank lists; the guard keeps a disagreement visible instead of silent
        const c = cl ?? { closed: 'no-sample' as const, opens_at: null }
        return [
          lane,
          {
            open: false,
            position: null,
            reason: null,
            closed: c.closed,
            why: why(c.closed),
            opens_at: iso(c.opens_at),
          },
        ]
      }),
    )
    const series: Pick<Held, 'ts' | 'w'>[] = hist.week
    const f =
      x && x.w !== null ? forecastWeekly({ nowMs, w: x.w, wReset: x.w_reset, weeklyUnits: units.weekly, series }) : null
    const forecast = f && { ...f, full_at: iso(f.full_at) }
    return {
      id,
      plan: planTier(a.plan),
      units,
      enabled: a.enabled,
      auth_ok: !cache.auth_failed[id],
      exhausted_until: until && until * 1000 > nowMs ? iso(until * 1000) : null,
      limits: limitsOf(x, hasSessionLimit(a), nowMs),
      mode: { ...modeField(view), expired: view.expired },
      reserve: b && {
        for: b.for,
        known: b.known,
        unused: b.unused,
        budget_left: b.known ? Math.round((b.ceiling - b.weekly! - b.unused!) * 10) / 10 : null,
        released: b.released,
      },
      closed: cl && { closed: cl.closed, why: why(cl.closed), opens_at: iso(cl.opens_at) },
      lanes: laneStatus,
      forecast,
      resets: hist.resets
        .slice(-STATUS_RESETS)
        .reverse()
        .map((r) => ({
          at: iso(r.at)!,
          weekly: r.weekly,
          scoped: r.scoped,
          modes: r.modes,
          rule: r.rule,
          closed_hours: r.closed_hours,
          manual: r.manual,
        })),
    }
  })
  return {
    schema: STATUS_SCHEMA_VERSION,
    at: iso(nowMs)!,
    machine: i.machine,
    rule: ruleTag(livePolicy(reg)),
    default_account: defaultAccountId(reg),
    lanes,
    accounts,
  }
}

/** A window this close to its ceiling (points) is the one a limit hit most likely came from. */
export const WALL_NEAR_POINTS = 10

/**
 * Where a lead that ran into a wall should wait: the reset (epoch ms) of the window nearest its ceiling, when that window is
 * within `WALL_NEAR_POINTS` of it and the reset is ahead (a 5 h window wins a tie: it opens sooner); null otherwise. A rate
 * limit at 10 % use is a throttle, not a window. Read from the status row, so the ceilings are the rule's own.
 */
export function wallResetAt(
  a: { limits: AccountStatus['limits']; mode: { kind: string } },
  nowMs: number,
): number | null {
  const find = (kind: string) => a.limits.find((l) => l.kind === kind)
  const session = find('session')
  const weekly = find('weekly_all')
  const resetOf = (l: Record<string, unknown> | undefined): number | null => {
    const t = typeof l?.resets_at === 'string' ? Date.parse(l.resets_at) : Number.NaN
    return Number.isNaN(t) ? null : t
  }
  const percentOf = (l: Record<string, unknown> | undefined): number | null => (isNum(l?.percent) ? l.percent : null)
  const sessionPct = percentOf(session)
  const weeklyPct = percentOf(weekly)
  const weeklyReset = resetOf(weekly)
  const sessionLeft = sessionPct === null ? null : SESSION_MAX - sessionPct
  const weeklyLeft =
    weeklyPct === null
      ? null
      : ceilingOf(weeklyReset === null ? null : weeklyReset / 1000, nowMs, a.mode.kind === 'drain') - weeklyPct
  const left = Math.min(sessionLeft ?? Number.POSITIVE_INFINITY, weeklyLeft ?? Number.POSITIVE_INFINITY)
  if (left > WALL_NEAR_POINTS) return null
  const useWeekly = weeklyLeft !== null && (sessionLeft === null || weeklyLeft < sessionLeft)
  const at = useWeekly ? weeklyReset : resetOf(session)
  return at !== null && at > nowMs ? at : null
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
/** "Fri 14:00" in the machine's local time; the date follows when it is more than six days away. */
export function shortTime(isoTime: string | null, nowMs: number): string {
  if (!isoTime) return '-'
  const d = new Date(isoTime)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const far = Math.abs(d.getTime() - nowMs) > 6 * 86400_000
  return far ? `${d.getMonth() + 1}/${d.getDate()} ${hm}` : `${DAYS[d.getDay()]} ${hm}`
}

/**
 * One line per account, led by the forecast: `me2 drain until reset · weekly 92 % · full Fri 14:00 · resets Sat 18:00`.
 * A closed account says why and when it opens; a forecast that does not fill the week says what it ends at.
 */
export function statusLine(a: AccountStatus, nowMs: number): string {
  const w = a.limits.find((l) => l.kind === 'weekly_all')
  const m = a.mode
  const kind = m.kind === 'reserve' ? `reserve for ${m.for}` : m.kind
  const modeText =
    m.kind === 'normal'
      ? 'normal'
      : `${kind}${m.until ? ` until ${m.until === 'reset' ? 'reset' : shortTime(m.until_at, nowMs)}` : ''}`
  const f = a.forecast
  const parts = [`${a.id} ${modeText}`]
  if (!a.enabled) parts.push('disabled')
  parts.push(w ? `weekly ${pct(w.percent as number)} %` : 'no weekly sample')
  if (f)
    parts.push(
      f.full_at !== null
        ? `full ${shortTime(f.full_at, nowMs)}`
        : `ends at ${pct(f.weekly_at_reset)} % (${f.waste_units} units unused)`,
    )
  if (w?.resets_at) parts.push(`resets ${shortTime(w.resets_at as string, nowMs)}`)
  if (a.closed)
    parts.push(`closed: ${a.closed.why}${a.closed.opens_at ? `, opens ${shortTime(a.closed.opens_at, nowMs)}` : ''}`)
  return parts.join(' · ')
}

/** The ledger rows of one account as text: `Sat 18:00  weekly 99 %  scoped 12 %  drain  closed 3.5 h`. */
export function resetLine(id: string, r: AccountStatus['resets'][number], nowMs: number): string {
  return [
    id.padEnd(6),
    `reset ${shortTime(r.at, nowMs)}${r.manual ? ' (manual)' : ''}`,
    `weekly ${r.weekly === null ? '-' : pct(r.weekly)} %`,
    `scoped ${r.scoped === null ? '-' : pct(r.scoped)} %`,
    r.modes.join('+') || 'normal',
    `closed ${r.closed_hours} h`,
  ].join('  ')
}

// ── The schema `status --json` validates against (JSON Schema, the subset test/schema.ts understands) ───────────────────────

const nullable = (t: string | string[]) => ({ type: [...(Array.isArray(t) ? t : [t]), 'null'] })
const num = { type: 'number' }
const str = { type: 'string' }
const NUM_OR_NULL = nullable('number')
const STR_OR_NULL = nullable('string')

export const STATUS_SCHEMA = {
  type: 'object',
  required: ['schema', 'at', 'machine', 'rule', 'default_account', 'lanes', 'accounts'],
  properties: {
    schema: { type: 'number', enum: [STATUS_SCHEMA_VERSION] },
    at: str,
    machine: str,
    rule: str,
    default_account: str,
    lanes: { type: 'array', items: str },
    accounts: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'id',
          'plan',
          'units',
          'enabled',
          'auth_ok',
          'exhausted_until',
          'limits',
          'mode',
          'reserve',
          'closed',
          'lanes',
          'forecast',
          'resets',
        ],
        properties: {
          id: str,
          plan: str,
          units: { type: 'object', required: ['session', 'weekly'], properties: { session: num, weekly: num } },
          enabled: { type: 'boolean' },
          auth_ok: { type: 'boolean' },
          exhausted_until: STR_OR_NULL,
          limits: {
            type: 'array',
            items: {
              type: 'object',
              required: ['kind', 'percent', 'resets_at', 'age_s', 'source'],
              properties: {
                kind: { type: 'string', enum: ['session', 'weekly_all', 'weekly_scoped'] },
                model: STR_OR_NULL,
                percent: NUM_OR_NULL,
                resets_at: STR_OR_NULL,
                age_s: NUM_OR_NULL,
                source: str,
                allowance_percent_of_weekly: NUM_OR_NULL,
                used_percent_of_weekly: NUM_OR_NULL,
              },
            },
          },
          mode: {
            type: 'object',
            required: ['kind', 'for', 'until', 'until_at', 'why', 'source', 'set_at', 'set_on', 'expired'],
            properties: {
              kind: { type: 'string', enum: ['normal', 'drain', 'reserve', 'paused'] },
              for: STR_OR_NULL,
              until: STR_OR_NULL,
              until_at: STR_OR_NULL,
              why: STR_OR_NULL,
              source: { type: 'string', enum: ['override', 'registry'] },
              set_at: STR_OR_NULL,
              set_on: STR_OR_NULL,
              expired: { type: 'boolean' },
            },
          },
          reserve: {
            ...nullable('object'),
            required: ['for', 'known', 'unused', 'budget_left', 'released'],
            properties: {
              for: str,
              known: { type: 'boolean' },
              unused: NUM_OR_NULL,
              budget_left: NUM_OR_NULL,
              released: { type: 'boolean' },
            },
          },
          closed: {
            ...nullable('object'),
            required: ['closed', 'why', 'opens_at'],
            properties: { closed: { type: 'string', enum: [...CLOSED_CODES] }, why: str, opens_at: STR_OR_NULL },
          },
          lanes: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              required: ['open', 'position', 'reason', 'closed', 'why', 'opens_at'],
              properties: {
                open: { type: 'boolean' },
                position: NUM_OR_NULL,
                reason: STR_OR_NULL,
                closed: { type: ['string', 'null'], enum: [...CLOSED_CODES, null] },
                why: STR_OR_NULL,
                opens_at: STR_OR_NULL,
              },
            },
          },
          forecast: {
            ...nullable('object'),
            required: [
              'method',
              'weekly_at_reset',
              'full_at',
              'waste_percent',
              'waste_units',
              'burn_per_hour',
              'basis_hours',
            ],
            properties: {
              method: str,
              weekly_at_reset: num,
              full_at: STR_OR_NULL,
              waste_percent: num,
              waste_units: num,
              burn_per_hour: num,
              basis_hours: num,
            },
          },
          resets: {
            type: 'array',
            items: {
              type: 'object',
              required: ['at', 'weekly', 'scoped', 'modes', 'rule', 'closed_hours', 'manual'],
              properties: {
                at: str,
                weekly: NUM_OR_NULL,
                scoped: NUM_OR_NULL,
                modes: { type: 'array', items: str },
                rule: STR_OR_NULL,
                closed_hours: num,
                manual: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
  },
} as const
