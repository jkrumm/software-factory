import type {
  AccountHealthRow,
  AccountMode,
  AccountModeBody,
  AccountRow,
  AccountsView,
  Kpi,
} from '@software-factory/contract'
import type { Tone } from '../components/kit/tone.ts'
import { resetWords } from './strip.ts'

// The Accounts screen's words. Every verdict (state, lane, forecast, ledger, order) is `packages/accounts`': this file only
// words them and builds the bodies of the four intents. No limit, threshold or rule lives here.

/** What the owner calls each mode kind. */
const MODE_WORDS: Record<AccountMode['kind'], string> = {
  normal: 'Normal',
  drain: 'Fill first',
  reserve: 'Held back',
  paused: 'Paused',
}

/** The tone of each mode kind, decided here and nowhere else: never derived from the word. */
export const MODE_TONES: Record<AccountMode['kind'], Tone> = {
  normal: 'neutral',
  drain: 'accent',
  reserve: 'accent',
  paused: 'warn',
}

/** The mode as a short label: "Fill first", "Holds fable", "Paused"; "Normal" for none. */
export const modeLabel = (mode: Pick<AccountMode, 'kind' | 'for'>): string =>
  mode.kind === 'reserve' ? `Holds ${mode.for ?? 'a model'}` : MODE_WORDS[mode.kind]

/** When the mode ends, in words: "until Sun 18:00", "until the reset", "until cleared". */
export function modeUntil(mode: Pick<AccountMode, 'until' | 'until_at'>, now: Date): string {
  const at = mode.until_at ? resetWords(new Date(mode.until_at).toISOString(), now, 'short') : null
  if (mode.until === 'reset') return at ? `until the reset, ${at}` : 'until the reset'
  if (at) return `until ${at}`
  return 'until cleared'
}

/** Where the mode in force came from. */
export const modeSource = (mode: Pick<AccountMode, 'source'>): string =>
  mode.source === 'override' ? 'Set by hand' : 'In the registry'

/** One limit of an account as the package reports it, read defensively (the contract keeps the record open). */
export interface LimitView {
  key: 'session' | 'weekly_all' | 'weekly_scoped'
  label: string
  percent: number | null
  resetsAt: string | null
}

const LIMIT_KEYS = ['session', 'weekly_all', 'weekly_scoped'] as const

export function limitsOf(row: Pick<AccountRow, 'limits'>): LimitView[] {
  const out: LimitView[] = []
  for (const limit of row.limits) {
    const key = LIMIT_KEYS.find((k) => k === limit.kind)
    if (!key) continue
    const model = typeof limit.model === 'string' ? limit.model : null
    out.push({
      key,
      label: key === 'session' ? '5 h' : key === 'weekly_all' ? 'This week' : `${model ?? 'Scoped'} this week`,
      percent: typeof limit.percent === 'number' ? Math.min(100, Math.max(0, Math.round(limit.percent))) : null,
      resetsAt: typeof limit.resets_at === 'string' ? limit.resets_at : null,
    })
  }
  return out
}

export interface ForecastWords {
  /** the headline: "Full Fri 14:00", "Ends at 38 %" */
  head: string
  /** what follows it: "the rest expires Tue 16:00"; null when nothing does */
  rest: string | null
  /** the weekly percent the week ends at, for the projected part of the meter; null without a forecast */
  endsAt: number | null
}

/** The forecast in words; no forecast says why, never a number. */
export function forecastWords(
  row: Pick<AccountRow, 'forecast'>,
  weeklyResetsAt: string | null,
  now: Date,
): ForecastWords {
  const forecast = row.forecast
  if (!forecast) return { head: 'No forecast', rest: 'No weekly reading to project from', endsAt: null }
  if (forecast.full_at !== null) {
    const at = new Date(forecast.full_at)
    return {
      head: at <= now ? 'At its weekly limit' : `Full ${resetWords(at.toISOString(), now, 'short')}`,
      rest: null,
      endsAt: 100,
    }
  }
  const ends = Math.round(forecast.weekly_at_reset)
  return {
    head: `Ends at ${ends} %`,
    rest:
      weeklyResetsAt === null
        ? `${Math.round(forecast.waste_percent)} % unused`
        : `the rest expires ${resetWords(weeklyResetsAt, now, 'short')}`,
    endsAt: ends,
  }
}

/** The plain words of the rule's reason for a place in a lane (`reason` of `rank`); an unknown code reads as it is. */
const REASON_WORDS: Record<string, string> = {
  drain: 'fills first',
  due: 'due to fill',
  'expiring-capacity': 'resets soonest',
  pace: 'paced',
  session: 'emptier 5 h window',
  home: 'its own lane',
  spill: 'spill',
}

export function reasonWords(reason: string | null): string | null {
  if (reason === null) return null
  const reserve = /^(.+)-reserve$/.exec(reason)
  if (reserve) return `held back for ${reserve[1]}`
  return REASON_WORDS[reason] ?? reason
}

export interface LaneEntry {
  account: string
  open: boolean
  position: number | null
  words: string | null
}

/** One lane's order now: the open accounts by the package's position, then the closed ones with why. */
export function laneOrder(view: Pick<AccountsView, 'accounts'>, lane: string): LaneEntry[] {
  const entries = view.accounts
    .filter((a) => a.enabled)
    .flatMap((a) => {
      const l = a.lanes[lane]
      return l
        ? [{ account: a.id, open: l.open, position: l.position, words: l.open ? reasonWords(l.reason) : l.why }]
        : []
    })
  return [
    ...entries.filter((e) => e.open).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
    ...entries.filter((e) => !e.open),
  ]
}

export interface LedgerBar {
  at: string
  weekly: number | null
  manual: boolean
  rule: string | null
}

/** The last resets of an account, oldest first, at most `limit`. */
export function ledgerBars(row: Pick<AccountRow, 'resets'>, limit = 8): LedgerBar[] {
  return [...row.resets]
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-limit)
    .map((r) => ({ at: r.at, weekly: r.weekly === null ? null : Math.round(r.weekly), manual: r.manual, rule: r.rule }))
}

/** The tone of each grade the package gives a health row, decided here and nowhere else. */
const HEALTH_TONES: Record<AccountHealthRow['state'], Tone> = { ok: 'good', warn: 'warn', fail: 'bad' }

export interface LoginLine {
  key: string
  machine: string
  /** what the row checks: the login, or the quota sample the login should be keeping alive */
  label: 'Login' | 'Quota'
  state: AccountHealthRow['state']
  tone: Tone
  /** the line in words: "Valid until Sun 29 Nov · 6.9 d left", or the package's own detail when it has no date */
  words: string
}

const shortDate = (at: string): string =>
  new Date(at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

function loginWords(row: AccountHealthRow, now: Date): string {
  if (row.check !== 'login' || row.ends_at === undefined) return capital(row.detail)
  const date = shortDate(row.ends_at)
  if (new Date(row.ends_at) <= now) return `Expired ${date}`
  const left = row.days_left === undefined ? '' : ` · ${row.days_left} d left`
  return `${row.state === 'ok' ? 'Valid until' : 'Ends'} ${date}${left}`
}

/**
 * The login and quota rows of one account, this machine first. The grade of each row is the package's (`health.ts`): nothing
 * here weighs a date against a limit; the words and tones only present it.
 */
export function loginLines(view: Pick<AccountsView, 'health' | 'machine'>, account: string, now: Date): LoginLine[] {
  const rows = (view.health?.rows ?? []).filter((r) => r.id === account && (r.check === 'login' || r.check === 'quota'))
  const place = (r: AccountHealthRow) => (r.machine === view.machine ? 0 : 1)
  return rows
    .toSorted((a, b) => place(a) - place(b) || a.machine.localeCompare(b.machine) || a.check.localeCompare(b.check))
    .map((r) => ({
      key: `${r.machine}/${r.check}`,
      machine: r.machine,
      label: r.check === 'quota' ? 'Quota' : 'Login',
      state: r.state,
      tone: HEALTH_TONES[r.state],
      words: loginWords(r, now),
    }))
}

/** The lines the strip shows: only a login or quota the package grades warn or fail; an ok one adds nothing. */
export const loginAlerts = (view: Pick<AccountsView, 'health' | 'machine'>, account: string, now: Date): LoginLine[] =>
  loginLines(view, account, now).filter((line) => line.state !== 'ok')

/** The worst line of a list as the chip's mark: its label and tone (a fail outranks a warn). */
export function loginMark(lines: LoginLine[]): { label: LoginLine['label']; tone: Tone } | null {
  const worst = lines.find((l) => l.state === 'fail') ?? lines[0]
  return worst ? { label: worst.label, tone: worst.tone } : null
}

export interface MachineNote {
  key: string
  tone: Tone
  words: string
}

/** What the package says of a machine as a whole (unreachable, re-login requests waiting for a click), when it is not ok. */
export function machineNotes(view: Pick<AccountsView, 'health'>): MachineNote[] {
  return (view.health?.rows ?? [])
    .filter((r) => r.id === '-' && r.state !== 'ok')
    .map((r) => ({ key: `${r.machine}/${r.check}`, tone: HEALTH_TONES[r.state], words: `${r.machine}: ${r.detail}` }))
}

/** The four intents, named by what the owner wants; each builds the body of `POST /v1/accounts/:id/mode`. */
export type Intent = 'fill-first' | 'hold-for-a-model' | 'pause'

export interface ExpiryChoice {
  key: string
  label: string
  /** `until` of the body: an ISO time, `reset`, or undefined for until cleared */
  until: (now: Date) => string | undefined
}

const hours = (n: number): ExpiryChoice => ({
  key: `${n}h`,
  label: `${n} h`,
  until: (now) => new Date(now.getTime() + n * 3_600_000).toISOString(),
})
const TO_RESET: ExpiryChoice = { key: 'reset', label: 'To the reset', until: () => 'reset' }
const WEEK: ExpiryChoice = {
  key: '1w',
  label: '1 week',
  until: (now) => new Date(now.getTime() + 7 * 86_400_000).toISOString(),
}
const UNTIL_CLEARED: ExpiryChoice = { key: 'cleared', label: 'Until I clear it', until: () => undefined }

/** Each intent's expiry choices, the default first; Fill first has the reset only. */
export const EXPIRIES: Record<Intent, readonly [ExpiryChoice, ...ExpiryChoice[]]> = {
  'fill-first': [TO_RESET],
  'hold-for-a-model': [TO_RESET, WEEK, UNTIL_CLEARED],
  pause: [hours(4), hours(1), TO_RESET, UNTIL_CLEARED],
}

export const INTENT_LABELS: Record<Intent, string> = {
  'fill-first': 'Fill first',
  'hold-for-a-model': 'Hold for a model',
  pause: 'Pause',
}

/** The model a reserve starts from: the one the account holds now, else `fable`. */
export const defaultHoldModel = (row: Pick<AccountRow, 'mode' | 'reserve'>): string =>
  row.reserve?.for ?? row.mode.for ?? 'fable'

/** The body of an intent; null when a Hold for a model has no model. */
export function intentBody(intent: Intent, expiry: ExpiryChoice, now: Date, model: string): AccountModeBody | null {
  const until = expiry.until(now)
  const base = { why: 'set in the Console', ...(until === undefined ? {} : { until }) }
  if (intent === 'fill-first') return { mode: 'drain', ...base }
  if (intent === 'pause') return { mode: 'paused', ...base }
  const trimmed = model.trim()
  return trimmed === '' ? null : { mode: 'reserve', for: trimmed, ...base }
}

/** The KPI's weekly points as percents (oldest first) with a label each; a window with no reset reads 0 and says so. */
export function quotaWeeks(kpi: Pick<Kpi, 'history'>): { values: number[]; labels: string[] } {
  const last = kpi.history.length - 1
  return {
    values: kpi.history.map((p) => Math.round((p.value ?? 0) * 100)),
    labels: kpi.history.map((p, i) => {
      const weeksAgo = last - i
      const start = weeksAgo === 0 ? 'This week' : `${weeksAgo} ${weeksAgo === 1 ? 'week' : 'weeks'} ago`
      return p.value === null
        ? `${start}: no resets`
        : `${start}: ${Math.round(p.value * 100)} % at ${p.n} ${p.n === 1 ? 'reset' : 'resets'}`
    }),
  }
}
