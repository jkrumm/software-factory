// Measures the load model (load-model.ts) from what a machine recorded: the sample log (history.ts), the pick log and the
// session transcripts' first and last write. Pure: scripts/measure-load.ts reads the files and writes the result.
import { type SampleLine } from './history.ts'
import { type LaneClass, type LoadModel } from './load-model.ts'
import {
  type Registry,
  RESET_DROP,
  RESET_JUMP_S,
  accountUnits,
  hasSessionLimit,
  homeIds,
  planTier,
  required,
  requiredAt,
} from './policy.ts'

const HOUR_MS = 3600_000
const WEEK_MS = 168 * HOUR_MS
/** A gap between two samples longer than this is a hole in the sampling: its increment is put into its last hours. */
export const SPREAD_MAX_H = 6
/** Session lengths are cut at this quantile: a transcript resumed days later is not one running session. */
export const SESSION_WINSOR = 0.95
const QUANTILES = [0, 0.1, 0.25, 0.5, 0.75, 0.9, SESSION_WINSOR]

export interface MeasureInput {
  reg: Registry
  lines: SampleLine[]
  picks: { ts: string; lane: string }[]
  /** each session transcript's first and last write, epoch ms */
  sessions: [number, number][]
  fromMs: number
  toMs: number
  nowMs: number
  sources: Record<string, string>
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d

/** The class a lane falls in under `reg`: the interactive lane, a lane some account calls home, or a homeless one. */
export function laneClass(reg: Registry, lane: string): LaneClass {
  if (lane === 'interactive') return 'interactive'
  if (!homeIds(reg, lane).length) return 'homeless'
  return lane === 'headless' ? 'headless' : 'bulk'
}

/**
 * Weekly units each account consumed in [from, to), each increment spread over the time since the account's previous line
 * (at most SPREAD_MAX_H). A week's level is its running maximum, so two feeds that disagree by a point never count twice;
 * a new week (the reset moved on by a day, or the percent fell by RESET_DROP) starts from its first line's percent.
 */
export function consumption(i: Pick<MeasureInput, 'reg' | 'lines' | 'fromMs' | 'toMs'>) {
  const byHourOfWeek = new Array<number>(168).fill(0)
  const perAccount: Record<string, number> = {}
  for (const id of Object.keys(i.reg.accounts)) {
    const a = required(i.reg.accounts, id)
    const lines = i.lines.filter((l) => l.id === id && l.w !== null).sort((p, q) => p.ts - q.ts)
    let week: number | null = null
    let top = 0
    let last: number | null = null
    for (const l of lines) {
      const w = l.w!
      if (last === null) {
        ;[top, week, last] = [w, l.w_reset, l.ts]
        continue
      }
      // a late line of the week before (a feed that carried the old window) neither resets nor adds
      if (l.w_reset !== null && week !== null && week - l.w_reset > RESET_JUMP_S) continue
      const newWeek = (l.w_reset !== null && week !== null && l.w_reset - week > RESET_JUMP_S) || top - w >= RESET_DROP
      if (newWeek) top = 0
      const gained = w - top
      if (gained > 0 && l.ts >= i.fromMs && l.ts < i.toMs) {
        const u = (gained * accountUnits(a).weekly) / 100
        perAccount[id] = (perAccount[id] ?? 0) + u
        const t0 = Math.max(last, l.ts - SPREAD_MAX_H * HOUR_MS)
        const n = Math.max(1, Math.round((l.ts - t0) / (15 * 60_000)))
        for (let k = 0; k < n; k++) {
          const t = new Date(t0 + ((k + 0.5) * (l.ts - t0)) / n)
          const hour = ((t.getUTCDay() + 6) % 7) * 24 + t.getUTCHours()
          byHourOfWeek[hour] = requiredAt(byHourOfWeek, hour) + u / n
        }
      }
      if (w > top) top = w
      week = l.w_reset ?? week
      last = l.ts
    }
  }
  return { byHourOfWeek, perAccount, total: Object.values(perAccount).reduce((s, u) => s + u, 0) }
}

/** Weekly points per 5 h point per plan tier, normalised to session units 1: from consecutive lines inside one 5 h window and one week. */
export function sessionRatios(
  i: Pick<MeasureInput, 'reg' | 'lines' | 'fromMs' | 'toMs'>,
): Record<string, number | null> {
  const sums: Record<string, { w: number; s: number }> = {}
  const out: Record<string, number | null> = {}
  for (const [id, a] of Object.entries(i.reg.accounts)) {
    const tier = planTier(a.plan)
    if (!hasSessionLimit(a)) {
      out[tier] = null
      continue
    }
    const u = accountUnits(a)
    const lines = i.lines
      .filter((l) => l.id === id && l.ts >= i.fromMs && l.ts < i.toMs && l.s !== null && l.w !== null)
      .sort((p, q) => p.ts - q.ts)
    for (let k = 1; k < lines.length; k++) {
      const [p, q] = [requiredAt(lines, k - 1), requiredAt(lines, k)]
      const sameWindow = p.s_reset !== null && q.s_reset !== null && Math.abs(p.s_reset - q.s_reset) <= 120
      const sameWeek = p.w_reset !== null && q.w_reset !== null && Math.abs(p.w_reset - q.w_reset) <= 120
      if (!sameWindow || !sameWeek || q.s! < p.s! || q.w! < p.w!) continue
      const sum = (sums[tier] ??= { w: 0, s: 0 })
      sum.w += ((q.w! - p.w!) * u.weekly) / 100
      sum.s += ((q.s! - p.s!) * u.session) / 100
    }
  }
  for (const [tier, sum] of Object.entries(sums)) out[tier] = sum.s > 0 ? round(sum.w / sum.s) : null
  return out
}

/** The load model of the data in [from, to). */
export function measureLoad(i: MeasureInput): LoadModel {
  const enabled = Object.values(i.reg.accounts).filter((a) => a.enabled)
  const poolUnits = enabled.reduce((s, a) => s + accountUnits(a).weekly, 0)
  const use = consumption(i)
  const weeks = (i.toMs - i.fromMs) / WEEK_MS

  const hours = i.sessions
    .filter(([start, end]) => start >= i.fromMs && start < i.toMs && end >= start)
    .map(([start, end]) => (end - start) / HOUR_MS)
    .sort((a, b) => a - b)
  if (!hours.length) throw new Error('no session in the range: the session length cannot be measured')
  const at = (p: number) => requiredAt(hours, Math.floor(p * (hours.length - 1)))
  const cap = at(SESSION_WINSOR)
  const sessionHours = hours.reduce((s, h) => s + Math.min(h, cap), 0)

  const hod = Array.from({ length: 24 }, (_, h) =>
    [0, 1, 2, 3, 4, 5, 6].reduce((s, d) => s + requiredAt(use.byHourOfWeek, d * 24 + h), 0),
  )
  const dow = Array.from({ length: 7 }, (_, d) =>
    use.byHourOfWeek.slice(d * 24, d * 24 + 24).reduce((s, x) => s + x, 0),
  )
  const norm = (xs: number[]) => {
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length
    return xs.map((x) => (mean > 0 ? round(x / mean, 3) : 1))
  }

  const picks = i.picks.filter((p) => {
    const t = Date.parse(p.ts)
    return t >= i.fromMs && t < i.toMs
  })
  const mix: Record<LaneClass, number> = { interactive: 0, headless: 0, bulk: 0, homeless: 0 }
  for (const p of picks) mix[laneClass(i.reg, p.lane)]++
  for (const k of Object.keys(mix) as LaneClass[]) mix[k] = picks.length ? round(mix[k] / picks.length, 3) : 0

  return {
    v: 1,
    measured_at: new Date(i.nowMs).toISOString(),
    range: { from: new Date(i.fromMs).toISOString(), to: new Date(i.toMs).toISOString() },
    sources: {
      ...i.sources,
      counts: `${i.lines.filter((l) => l.ts >= i.fromMs && l.ts < i.toMs).length} sample lines, ${picks.length} picks, ${hours.length} sessions`,
    },
    session_hours: QUANTILES.map((p) => [p === SESSION_WINSOR ? 1 : p, round(at(p), 3)]),
    units_per_session_hour: round(use.total / sessionHours, 6),
    weekly_per_session_point: sessionRatios(i),
    demand: round(use.total / weeks / poolUnits, 3),
    curve: { hour_of_day_utc: norm(hod), day_of_week: norm(dow) },
    mix,
  }
}
