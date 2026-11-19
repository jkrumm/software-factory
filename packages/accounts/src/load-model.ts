// The simulation's load model (docs/accounts.md §The policy lab): what the pool's work looks like, measured from this
// machine's sample log, pick log and session transcripts by scripts/measure-load.ts into load-model.json. Pure: the JSON
// is bundled, nothing here reads a file or the clock.
import measured from './load-model.json' with { type: 'json' }
import { requiredAt } from './required.ts'

/** Lane classes as the registry routes them: `homeless` is every lane no account names as a home (`lead`, `fan`, ...). */
export const LANE_CLASSES = ['interactive', 'headless', 'bulk', 'homeless'] as const
export type LaneClass = (typeof LANE_CLASSES)[number]

export interface LoadModel {
  v: 1
  /** when the numbers were measured and the span of the data they came from (ISO) */
  measured_at: string
  range: { from: string; to: string }
  /** what each number was read from, in words */
  sources: Record<string, string>
  /** session length in hours: [quantile, hours] from 0 to 1, read as a piecewise linear inverse CDF */
  session_hours: [number, number][]
  /** capacity units (one Max-week = 1) a running session burns per hour */
  units_per_session_hour: number
  /** weekly points per 5 h point of a plan with a 5 h window, at session units 1 (a Max); null for a plan without one */
  weekly_per_session_point: Record<string, number | null>
  /** the work the pool did per week as a share of its weekly capacity (a floor of the demand: walls cut the rest) */
  demand: number
  /** the demand curve: factors by UTC hour of day (24) and by day of week (7, Monday first); the simulation normalises their product */
  curve: { hour_of_day_utc: number[]; day_of_week: number[] }
  /** share of the spawns per lane class */
  mix: Record<LaneClass, number>
}

/** The checked-in measurement (test/lab.test.ts holds its shape). */
export const MEASURED = measured as unknown as LoadModel

const WEEK_H = 168

/** Mean of the hour-of-week curve, so curveAt averages 1 over a week. */
const curveMean = (m: LoadModel) => {
  let s = 0
  for (let d = 0; d < 7; d++)
    for (let h = 0; h < 24; h++) s += requiredAt(m.curve.day_of_week, d) * requiredAt(m.curve.hour_of_day_utc, h)
  return s / WEEK_H
}
const means = new WeakMap<LoadModel, number>()

/** The demand factor at `ms` (mean 1 over a week). */
export function curveAt(m: LoadModel, ms: number): number {
  let mean = means.get(m)
  if (mean === undefined) means.set(m, (mean = curveMean(m)))
  const t = new Date(ms)
  const dow = (t.getUTCDay() + 6) % 7
  return mean > 0
    ? (requiredAt(m.curve.day_of_week, dow) * requiredAt(m.curve.hour_of_day_utc, t.getUTCHours())) / mean
    : 1
}

/** Session hours at quantile `u` (0..1) of the measured distribution. */
export function sessionHoursAt(m: LoadModel, u: number): number {
  const q = m.session_hours
  for (let i = 1; i < q.length; i++) {
    const [p0, h0] = requiredAt(q, i - 1)
    const [p1, h1] = requiredAt(q, i)
    if (u <= p1) return p1 === p0 ? h1 : h0 + ((u - p0) / (p1 - p0)) * (h1 - h0)
  }
  return requiredAt(q, q.length - 1)[1]
}

/** True when every session has the same length: the simulation then draws none. */
export const fixedSessions = (m: LoadModel) => m.session_hours.every(([, h]) => h === requiredAt(m.session_hours, 0)[1])

/** Weekly points per 5 h point for a plan tier (`max` stands for any plan with a 5 h window); null without one. */
export const sessionRatio = (m: LoadModel, tier: string): number | null =>
  m.weekly_per_session_point[tier] ?? m.weekly_per_session_point.max ?? null

/** Share of the spawns on lanes other than `interactive`: the work the bulk steps of a rule can move. */
export const bulkShare = (m: LoadModel) => 1 - (m.mix.interactive ?? 0)
