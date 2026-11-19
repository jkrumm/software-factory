// The history of an account (docs/accounts.md §History): the sample line, the reset ledger replayed from a series of
// lines, and the forecast. Pure: no file, process or clock access (test/policy-pure.test.ts holds that); the files are
// history-store.ts.
import {
  type Sample,
  ID,
  RESET_DROP,
  RESET_JUMP_S,
  WEEKLY_MAX,
  weeklyCeiling,
  CEILING_EXPIRING_S,
  FINAL_S,
  isNum,
  numOrNull,
} from './policy.ts'

/** One line of the sample log: the account's limits as they stood after a change of a percent or a reset time. */
export interface SampleLine {
  v: 1
  /** epoch ms the values were true (a peer sample keeps the time it was taken, not the time it arrived) */
  ts: number
  id: string
  /** 5 h percent and its reset (epoch s); null for a plan without a 5 h window */
  s: number | null
  s_reset: number | null
  /** weekly_all percent and its reset (epoch s) */
  w: number | null
  w_reset: number | null
  /** the highest weekly_scoped percent (Fable), null when the endpoint never gave one this week */
  scoped: number | null
  src: string
  /** the mode kind in force when the line was written (drain lifts the weekly ceiling to 100) */
  mode: string | null
  /** the rule that judged the account then */
  rule: string | null
}

/** One observed weekly reset of an account: the ledger line. */
export interface ResetEntry {
  v: 1
  id: string
  /** one per account and week: the reset time rounded to 10 minutes (the observation hour when it is unknown) */
  key: string
  /** epoch ms of the reset: the scheduled time, or the first sample that showed it when that came earlier (a manual reset) */
  at: number
  /** the weekly reset (epoch s) the window ended with, null when unknown */
  reset_at: number | null
  /** the last weekly_all and scoped percent before the reset */
  weekly: number | null
  scoped: number | null
  /** the modes seen on the week's lines, first seen first */
  modes: string[]
  rule: string | null
  /** hours the account stood at or over its weekly ceiling before the reset */
  closed_hours: number
  /** the reset came more than an hour before its scheduled time */
  manual: boolean
}

/** Reset times that differ by less than this are the same (the statusline rounds to the second, the endpoint does not). */
export const RESET_JITTER_S = 60
/** A reset seen this long before the scheduled one is a manual one. */
export const MANUAL_MARGIN_MS = 3600_000

/** The highest weekly_scoped percent of the endpoint's limit set; null when there is none. */
export function scopedPercent(x: Pick<Sample, 'limits'>): number | null {
  const ps = (x.limits ?? [])
    .filter((l) => l.kind === 'weekly_scoped' && isNum(l.percent))
    .map((l) => l.percent as number)
  return ps.length ? Math.max(...ps) : null
}

const moved = (a: number | null, b: number | null) =>
  a !== b && (a === null || b === null || Math.abs(a - b) > RESET_JITTER_S)

/** True when `next` differs from `prev` in a percent or a reset time of one of the limits: what the sample log records. */
export function sampleChanged(prev: Sample | null, next: Sample): boolean {
  if (!prev) return true
  return (
    prev.s !== next.s ||
    prev.w !== next.w ||
    moved(prev.s_reset, next.s_reset) ||
    moved(prev.w_reset, next.w_reset) ||
    scopedPercent(prev) !== scopedPercent(next)
  )
}

/** The line a changed sample becomes: stamped with the newest window it took from the feed, never later than `nowMs`. */
export function lineOf(
  id: string,
  prev: Sample | null,
  next: Sample,
  nowMs: number,
  ctx: { mode: string | null; rule: string | null },
): SampleLine {
  const stamps = [
    prev === null || prev.s !== next.s || moved(prev.s_reset, next.s_reset) ? next.s_ts : null,
    prev === null || prev.w !== next.w || moved(prev.w_reset, next.w_reset) ? next.w_ts : null,
    prev === null || scopedPercent(prev) !== scopedPercent(next) ? (next.limits_ts ?? null) : null,
  ].filter(isNum)
  const ts = stamps.length ? Math.min(nowMs, Math.max(...stamps)) : nowMs
  return {
    v: 1,
    ts,
    id,
    s: next.s,
    s_reset: next.s_reset,
    w: next.w,
    w_reset: next.w_reset,
    scoped: scopedPercent(next),
    src: next.src,
    mode: ctx.mode,
    rule: ctx.rule,
  }
}

/** A sample line from a parsed JSON value (a file line, an import); null when it is not one. Missing fields read as null. */
export function parseSampleLine(raw: unknown): SampleLine | null {
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== 'object' || !isNum(r.ts) || typeof r.id !== 'string' || !ID.test(r.id)) return null
  const n = (k: string) => (r[k] === undefined ? null : r[k])
  const fields = ['s', 's_reset', 'w', 'w_reset', 'scoped'] as const
  if (!fields.every((k) => numOrNull(n(k)))) return null
  if (fields.every((k) => n(k) === null)) return null
  const str = (k: string) => (typeof r[k] === 'string' ? r[k] : null)
  return {
    v: 1,
    ts: r.ts,
    id: r.id,
    s: n('s') as number | null,
    s_reset: n('s_reset') as number | null,
    w: n('w') as number | null,
    w_reset: n('w_reset') as number | null,
    scoped: n('scoped') as number | null,
    src: str('src') ?? 'import',
    mode: str('mode'),
    rule: str('rule'),
  }
}

/** What the replay holds between two lines: the log records changes only, so a state stands until the next line. */
export interface Held {
  ts: number
  w: number | null
  w_reset: number | null
  scoped: number | null
  mode: string | null
  rule: string | null
}

const isReset = (prev: Held, cur: Pick<Held, 'w' | 'w_reset'>): boolean => {
  const jumped = prev.w_reset !== null && cur.w_reset !== null && cur.w_reset - prev.w_reset > RESET_JUMP_S
  const fell = prev.w !== null && cur.w !== null && prev.w - cur.w >= RESET_DROP
  return jumped || fell
}

/** Milliseconds of [a, b) in which weekly `w` is at or over the ceiling of a window resetting at `wReset` (epoch s). */
export function closedMs(a: number, b: number, w: number | null, wReset: number | null, drain: boolean): number {
  if (w === null || b <= a) return 0
  const overlap = (from: number, to: number, ceiling: number) =>
    w >= ceiling ? Math.max(0, Math.min(b, to) - Math.max(a, from)) : 0
  if (drain) return overlap(-Infinity, Infinity, weeklyCeiling(null, 0, true))
  if (wReset === null) return overlap(-Infinity, Infinity, WEEKLY_MAX)
  const end = wReset * 1000
  const edges: [number, number, number] = [end - CEILING_EXPIRING_S * 1000, end - FINAL_S * 1000, end]
  return (
    overlap(-Infinity, edges[0], weeklyCeiling(wReset, edges[0] - 1)) +
    overlap(edges[0], edges[1], weeklyCeiling(wReset, edges[0] + 1)) +
    overlap(edges[1], edges[2], weeklyCeiling(wReset, edges[1] + 1)) +
    overlap(edges[2], Infinity, WEEKLY_MAX)
  )
}

/** Hours the week's held states stood closed at the weekly ceiling until the week ended at `endMs`. */
export function closedHours(week: Held[], endMs: number): number {
  let ms = 0
  week.forEach((h, i) => {
    const from = Math.min(h.ts, endMs)
    const next = week[i + 1]
    const to = Math.min(next ? next.ts : endMs, endMs)
    ms += closedMs(from, to, h.w, h.w_reset, h.mode === 'drain')
  })
  return Math.round(ms / 360_000) / 10
}

const resetKey = (id: string, resetS: number | null, obsMs: number) =>
  resetS !== null ? `${id}:${Math.round(resetS / 600)}` : `${id}:t${Math.floor(obsMs / 3600_000)}`

/** The ledger line for the week `week` ending in a reset that sample `obsTs` was the first to show. */
function resetEntry(id: string, last: Held, week: Held[], obsTs: number): ResetEntry {
  const sched = last.w_reset === null ? null : last.w_reset * 1000
  const at = sched === null ? obsTs : Math.min(sched, obsTs)
  const modes = [...new Set(week.map((h) => h.mode).filter((m): m is string => m !== null))]
  const rule = [...week].reverse().find((h) => h.rule !== null)?.rule ?? null
  return {
    v: 1,
    id,
    key: resetKey(id, last.w_reset, obsTs),
    at,
    reset_at: last.w_reset,
    weekly: last.w,
    scoped: last.scoped,
    modes,
    rule,
    closed_hours: closedHours(week, at),
    manual: sched !== null && sched - obsTs > MANUAL_MARGIN_MS,
  }
}

/**
 * Replays one account's lines (in any order; they are sorted by time, equal times keep their order) into its resets and
 * the week still running. A reset is what `observedReset` calls one (the weekly reset moved on by more than a day, or the
 * percent fell by 50 points or more), judged between consecutive held states, so a manual reset counts as one and a
 * duplicate line, a peer's echo of the same state, a jitter of a reset time never adds one.
 */
export function replayAccount(id: string, lines: SampleLine[]): { resets: ResetEntry[]; week: Held[] } {
  const sorted = lines.filter((l) => l.id === id).sort((a, b) => a.ts - b.ts)
  const resets: ResetEntry[] = []
  let week: Held[] = []
  let state: Held | null = null
  for (const l of sorted) {
    const cur: Held = {
      ts: l.ts,
      w: l.w ?? state?.w ?? null,
      w_reset: l.w_reset ?? state?.w_reset ?? null,
      scoped: l.scoped ?? state?.scoped ?? null,
      mode: l.mode,
      rule: l.rule,
    }
    if (state && isReset(state, cur)) {
      const entry = resetEntry(id, state, week, l.ts)
      // a manual reset shows twice: the percent falls first, the reset time moves on a sample later; one reset, one line
      if (resets[resets.length - 1]?.key !== entry.key) {
        resets.push(entry)
        week = [] // the new week starts with what the line itself says: the old scoped percent does not carry over
        cur.scoped = l.scoped
      }
    }
    week.push(cur)
    state = cur
  }
  return { resets, week }
}

/** Every account's resets from a series of lines of several accounts, oldest first. */
export function replayResets(lines: SampleLine[]): ResetEntry[] {
  const ids = [...new Set(lines.map((l) => l.id))]
  return ids.flatMap((id) => replayAccount(id, lines).resets).sort((a, b) => a.at - b.at)
}

// ── Forecast ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The one method `status` names: the weekly percent at the reset if the last 24 h's burn rate goes on. */
export const FORECAST_METHOD = 'burn-rate-24h-v1'
export const FORECAST_BASIS_H = 24
/** The rate is never taken over less than this many hours: the first hour of a window would otherwise project a week from a minute. */
export const FORECAST_MIN_SPAN_H = 3

export interface Forecast {
  method: string
  /** the weekly percent when the window resets, capped at 100 */
  weekly_at_reset: number
  /** epoch ms the weekly limit is reached before the reset, null when it is not (or the account is already there: then the time it was) */
  full_at: number | null
  /** points of the weekly limit left unused at the reset */
  waste_percent: number
  /** the same in capacity units, so a Max and an Ultra compare */
  waste_units: number
  /** percent per hour the projection used, and the hours of history behind it (0: no history, the projection is flat) */
  burn_per_hour: number
  basis_hours: number
}

const round1 = (n: number) => Math.round(n * 10) / 10

/**
 * `burn-rate-24h-v1`: the rate is the weekly percent gained over the last 24 hours of this week's history (since the first
 * line when the week is younger; never over less than 3 h), held to the reset. `series` is the week's held states, oldest
 * first (replayAccount's `week`). Null without a weekly percent and a reset still ahead. It does not know the account's
 * ceiling or its mode: a projection above the ceiling reads as the time it reaches 100.
 */
export function forecastWeekly(i: {
  nowMs: number
  w: number | null
  wReset: number | null
  weeklyUnits: number
  series: Pick<Held, 'ts' | 'w'>[]
}): Forecast | null {
  const { nowMs, w, wReset } = i
  if (w === null || wReset === null || wReset * 1000 <= nowMs) return null
  const hoursLeft = (wReset * 1000 - nowMs) / 3600_000
  const want = nowMs - FORECAST_BASIS_H * 3600_000
  const series = i.series.filter((h) => h.w !== null && h.ts <= nowMs)
  const before = [...series].reverse().find((h) => h.ts <= want)
  const base = before ? { ts: want, w: before.w! } : series[0] ? { ts: series[0].ts, w: series[0].w! } : null
  const span = base ? (nowMs - base.ts) / 3600_000 : 0
  const rate = base && span > 0 ? Math.max(0, w - base.w) / Math.max(span, FORECAST_MIN_SPAN_H) : 0
  const projected = w + rate * hoursLeft
  const full = w >= 100
  const atReset = Math.min(100, projected)
  const fullAt = full
    ? (series.find((h) => h.w! >= 100)?.ts ?? nowMs)
    : projected >= 100 && rate > 0
      ? nowMs + ((100 - w) / rate) * 3600_000
      : null
  const waste = round1(100 - atReset)
  return {
    method: FORECAST_METHOD,
    weekly_at_reset: round1(atReset),
    full_at: fullAt === null ? null : Math.round(fullAt),
    waste_percent: waste,
    waste_units: Math.round((waste / 100) * i.weeklyUnits * 100) / 100,
    burn_per_hour: Math.round(rate * 100) / 100,
    basis_hours: base ? round1(span) : 0,
  }
}

/** What `quotaUsedAtResetIn` found: the capacity-weighted mean of the weekly percent at reset, and how many resets stand under it. */
export interface QuotaAtReset {
  /** null when no reset of an account with a known capacity and a weekly percent fell in the span */
  percent: number | null
  resets: number
}

/**
 * Quota used at reset: the capacity-weighted mean of the weekly percent each account stood at when its weekly window reset
 * (`at` in `[from, to)`, epoch ms), from the reset ledger. The weight is the account's weekly capacity (`weeklyUnits`), so a
 * big plan counts for more than a small one; an account with no capacity given, or a reset with no weekly percent, is left out.
 */
export function quotaUsedAtResetIn(i: {
  entries: readonly ResetEntry[]
  weeklyUnits: Readonly<Record<string, number>>
  from: number
  to: number
}): QuotaAtReset {
  let weight = 0
  let sum = 0
  let resets = 0
  for (const e of i.entries) {
    const units = i.weeklyUnits[e.id]
    if (e.at < i.from || e.at >= i.to || e.weekly === null || units === undefined || !(units > 0)) continue
    weight += units
    sum += units * e.weekly
    resets += 1
  }
  return { percent: weight > 0 ? sum / weight : null, resets }
}

/** One week of `quotaUsedAtReset`. */
export interface QuotaAtResetWeek extends QuotaAtReset {
  /** epoch ms, the week's start (inclusive) and end (exclusive) */
  from: number
  to: number
}

/** `quotaUsedAtResetIn` per week: the `weeks` blocks of seven days that end at `nowMs`, oldest first, the last the newest. */
export function quotaUsedAtReset(i: {
  entries: readonly ResetEntry[]
  weeklyUnits: Readonly<Record<string, number>>
  nowMs: number
  weeks: number
}): QuotaAtResetWeek[] {
  const WEEK = 7 * 24 * 3600_000
  return Array.from({ length: i.weeks }, (_, k): QuotaAtResetWeek => {
    const to = i.nowMs - (i.weeks - 1 - k) * WEEK
    const from = to - WEEK
    return { from, to, ...quotaUsedAtResetIn({ entries: i.entries, weeklyUnits: i.weeklyUnits, from, to }) }
  })
}
