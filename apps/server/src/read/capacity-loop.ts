import type { SQL } from 'bun'
import * as z from 'zod'
import type { CapacityLoopModel } from '@software-factory/contract'
import { boundedRead } from './bounded.ts'
import { readLeadCosts } from './lead-costs.ts'
import { windowOf } from './stats.ts'

/** The settings in force that the capacity loop tunes; the server hands them over from the settings it holds. */
export type CapacityConstants = CapacityLoopModel['constants']

const TOP = 8
const NEWEST_REAPED = 5
const DAY_MS = 24 * 3_600_000

const Day = z.object({ day: z.string(), v: z.coerce.number().nullable() })
const Total = z.object({ v: z.coerce.number().nullable() })

/**
 * What the capacity loop did over the last `days` days, all computed in SQL over the window `[now - days, now)`. A day is
 * a UTC date. Percentiles are `percentile_cont` (linear interpolation, the same rule as `stats.ts`'s `percentile`, which
 * the KPIs use in memory), so the figures are the database's own and the test restates each one in plain SQL.
 * Reuses the closed-Issue definition of the cycle KPI: an applied event into `closed`.
 */
export async function readCapacityLoop(
  sql: SQL,
  options: { now: Date; days: number; constants: CapacityConstants },
): Promise<CapacityLoopModel> {
  const { now, days } = options
  const w = windowOf(now, days)
  const leadCosts = await readLeadCosts(sql)

  const body = await boundedRead(sql, 10_000, async (tx) => {
    // every UTC date the window touches, so a day with no rows is a 0 (or null for a percentile), not a gap
    const dates: string[] = []
    for (
      let t = Date.UTC(w.from.getUTCFullYear(), w.from.getUTCMonth(), w.from.getUTCDate());
      t <= w.to.getTime();
      t += DAY_MS
    )
      dates.push(new Date(t).toISOString().slice(0, 10))

    const perDay = (rows: unknown[], empty: number | null) => {
      const found = new Map(rows.map((raw) => Day.parse(raw)).map((r) => [r.day, r.v]))
      return dates.map((day) => ({ day, value: found.get(day) ?? empty }))
    }
    const total = async (rows: Promise<unknown[]>) => Number(Total.parse((await rows)[0]).v ?? 0)

    const closedDay: unknown[] = await tx`
      SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*) AS v
      FROM factory.issue_events
      WHERE result = 'applied' AND to_state = 'closed' AND at >= ${w.from} AND at < ${w.to} GROUP BY 1`
    const closed = await total(tx`
      SELECT count(*) AS v FROM factory.issue_events
      WHERE result = 'applied' AND to_state = 'closed' AND at >= ${w.from} AND at < ${w.to}`)

    const idleDay: unknown[] = await tx`
      SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, sum(greatest(seats - leads, 0))::float8 / 60 AS v
      FROM factory.host_samples
      WHERE queued > 0 AND seats IS NOT NULL AND leads IS NOT NULL AND at >= ${w.from} AND at < ${w.to} GROUP BY 1`
    const idle = await total(tx`
      SELECT sum(greatest(seats - leads, 0))::float8 / 60 AS v FROM factory.host_samples
      WHERE queued > 0 AND seats IS NOT NULL AND leads IS NOT NULL AND at >= ${w.from} AND at < ${w.to}`)

    // the same idle minutes with the memory gate shut: the swapout rate, swap in use, or either, above the ceilings
    const { swapoutCeilingMb, swapCeilingPct } = options.constants
    const [memoryRow] = await tx`
      SELECT
        sum(greatest(seats - leads, 0)) FILTER (WHERE swapout_mb_per_300s > ${swapoutCeilingMb} OR swap_used_pct > ${swapCeilingPct})::float8 / 60 AS total,
        sum(greatest(seats - leads, 0)) FILTER (WHERE swapout_mb_per_300s > ${swapoutCeilingMb})::float8 / 60 AS swapout,
        sum(greatest(seats - leads, 0)) FILTER (WHERE swap_used_pct > ${swapCeilingPct})::float8 / 60 AS swap_used
      FROM factory.host_samples
      WHERE queued > 0 AND seats IS NOT NULL AND leads IS NOT NULL AND at >= ${w.from} AND at < ${w.to}`
    const memoryIdle = z
      .object({
        total: z.coerce.number().nullable(),
        swapout: z.coerce.number().nullable(),
        swap_used: z.coerce.number().nullable(),
      })
      .parse(memoryRow)
    const idleMemory = {
      total: memoryIdle.total ?? 0,
      swapout: memoryIdle.swapout ?? 0,
      swapUsed: memoryIdle.swap_used ?? 0,
    }

    const overDay: unknown[] = await tx`
      SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*) AS v
      FROM factory.host_samples
      WHERE load > load_ceiling AND at >= ${w.from} AND at < ${w.to} GROUP BY 1`
    const over = await total(tx`
      SELECT count(*) AS v FROM factory.host_samples WHERE load > load_ceiling AND at >= ${w.from} AND at < ${w.to}`)

    const waitDay: unknown[] = await tx`
      SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_ms)::float8 AS v
      FROM factory.step_costs WHERE at >= ${w.from} AND at < ${w.to} GROUP BY 1`
    const [wait] = await tx`
      SELECT count(*) AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_ms)::float8 AS p50,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY wait_ms)::float8 AS p90
      FROM factory.step_costs WHERE at >= ${w.from} AND at < ${w.to}`
    const waitRow = z
      .object({ n: z.coerce.number().int(), p50: z.coerce.number().nullable(), p90: z.coerce.number().nullable() })
      .parse(wait)

    // MiB per minute: a sample's figure is that minute's delta scaled to 300 s
    const swapDay: unknown[] = await tx`
      SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, sum(swapout_mb_per_300s)::float8 / 5 AS v
      FROM factory.host_samples WHERE at >= ${w.from} AND at < ${w.to} GROUP BY 1`
    const swap = await total(tx`
      SELECT sum(swapout_mb_per_300s)::float8 / 5 AS v FROM factory.host_samples WHERE at >= ${w.from} AND at < ${w.to}`)
    const pressureDay: unknown[] = await tx`
      SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*) AS v
      FROM factory.host_samples WHERE pressure_level >= 2 AND at >= ${w.from} AND at < ${w.to} GROUP BY 1`
    const pressured = await total(tx`
      SELECT count(*) AS v FROM factory.host_samples
      WHERE pressure_level >= 2 AND at >= ${w.from} AND at < ${w.to}`)

    const moreDay: unknown[] = await tx`
      SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*) AS v
      FROM factory.admission_shadow WHERE shadow_admits > live_admits AND at >= ${w.from} AND at < ${w.to} GROUP BY 1`
    const fewerDay: unknown[] = await tx`
      SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*) AS v
      FROM factory.admission_shadow WHERE shadow_admits < live_admits AND at >= ${w.from} AND at < ${w.to} GROUP BY 1`
    const [shadowSpan] = await tx`
      SELECT count(*) AS n, min(at) AS first_at, max(at) AS last_at,
        count(*) FILTER (WHERE shadow_admits > live_admits) AS more, count(*) FILTER (WHERE shadow_admits < live_admits) AS fewer
      FROM factory.admission_shadow WHERE at >= ${w.from} AND at < ${w.to}`
    // what the host did in each shadow minute: the minute samples, joined by the minute they fall in
    const shadowHost: unknown[] = await tx`
      SELECT CASE WHEN s.shadow_admits > s.live_admits THEN 'more' WHEN s.shadow_admits < s.live_admits THEN 'fewer' ELSE 'same' END AS kind,
        count(DISTINCT s.at) AS n,
        avg(h.swapout_mb_per_300s)::float8 AS swap_avg, max(h.swapout_mb_per_300s)::float8 AS swap_max,
        max(h.pressure_level) AS pressure_max, count(h.at) FILTER (WHERE h.pressure_level >= 2) AS pressured
      FROM factory.admission_shadow s
      LEFT JOIN factory.host_samples h ON date_trunc('minute', h.at) = s.at
      WHERE s.at >= ${w.from} AND s.at < ${w.to} GROUP BY 1`
    const Span = z.object({
      n: z.coerce.number().int(),
      first_at: z.coerce.date().nullable(),
      last_at: z.coerce.date().nullable(),
      more: z.coerce.number().int(),
      fewer: z.coerce.number().int(),
    })
    const Host = z.object({
      kind: z.enum(['more', 'fewer', 'same']),
      n: z.coerce.number().int(),
      swap_avg: z.coerce.number().nullable(),
      swap_max: z.coerce.number().nullable(),
      pressure_max: z.coerce.number().int().nullable(),
      pressured: z.coerce.number().int(),
    })
    const span = Span.parse(shadowSpan)
    const hostOf = (kind: 'more' | 'fewer' | 'same') => {
      const row = shadowHost.map((raw) => Host.parse(raw)).find((h) => h.kind === kind)
      return {
        minutes: row?.n ?? 0,
        swapoutMbAvg: row?.swap_avg == null ? null : Math.round(row.swap_avg),
        swapoutMbMax: row?.swap_max == null ? null : Math.round(row.swap_max),
        pressureLevelMax: row?.pressure_max ?? null,
        pressureMinutes: row?.pressured ?? 0,
      }
    }

    const steps: unknown[] = await tx`
      SELECT name, count(*) AS runs, max(peak_rss_mib) AS max_peak,
        percentile_cont(0.8) WITHIN GROUP (ORDER BY peak_rss_mib)::float8 AS p80_peak,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::float8 AS median_duration,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_ms)::float8 AS median_wait
      FROM factory.step_costs WHERE at >= ${w.from} AND at < ${w.to} AND peak_rss_mib IS NOT NULL
      GROUP BY name ORDER BY max(peak_rss_mib) DESC, name LIMIT ${TOP}`

    const reapDay: unknown[] = await tx`
      SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*) AS v
      FROM factory.reaped_processes
      WHERE signal IN ('SIGTERM', 'SIGKILL') AND at >= ${w.from} AND at < ${w.to} GROUP BY 1`
    const reaped = await total(tx`
      SELECT count(*) AS v FROM factory.reaped_processes
      WHERE signal IN ('SIGTERM', 'SIGKILL') AND at >= ${w.from} AND at < ${w.to}`)
    const newest: unknown[] = await tx`
      SELECT comm, session, reason, at FROM factory.reaped_processes
      WHERE signal IN ('SIGTERM', 'SIGKILL') AND at >= ${w.from} AND at < ${w.to}
      ORDER BY at DESC, pid DESC LIMIT ${NEWEST_REAPED}`

    const Step = z.object({
      name: z.string(),
      runs: z.coerce.number().int(),
      max_peak: z.coerce.number().int(),
      p80_peak: z.coerce.number(),
      median_duration: z.coerce.number(),
      median_wait: z.coerce.number(),
    })
    const Reaped = z.object({
      comm: z.string(),
      session: z.string(),
      reason: z.enum(['session', 'worktree']),
      at: z.coerce.date(),
    })
    return {
      throughput: { total: closed, perDay: perDay(closedDay, 0) },
      idleSeatHours: { total: idle, perDay: perDay(idleDay, 0) },
      idleSeatHoursMemory: idleMemory,
      minutesOverCeiling: { total: over, perDay: perDay(overDay, 0) },
      slotWait: { n: waitRow.n, p50Ms: waitRow.p50, p90Ms: waitRow.p90, perDayP50: perDay(waitDay, null) },
      swapoutMib: { total: swap, perDay: perDay(swapDay, 0) },
      minutesUnderPressure: { total: pressured, perDay: perDay(pressureDay, 0) },
      shadow: {
        minutes: span.n,
        firstAt: span.first_at?.toISOString() ?? null,
        lastAt: span.last_at?.toISOString() ?? null,
        shadowMore: { total: span.more, perDay: perDay(moreDay, 0) },
        shadowFewer: { total: span.fewer, perDay: perDay(fewerDay, 0) },
        whenMore: hostOf('more'),
        whenFewer: hostOf('fewer'),
        whenSame: hostOf('same'),
      },
      topSteps: steps.map((raw) => {
        const s = Step.parse(raw)
        return {
          name: s.name,
          runs: s.runs,
          maxPeakMib: s.max_peak,
          p80PeakMib: s.p80_peak,
          medianDurationMs: s.median_duration,
          medianWaitMs: s.median_wait,
        }
      }),
      reaped: {
        total: reaped,
        perDay: perDay(reapDay, 0),
        newest: newest.map((raw) => {
          const r = Reaped.parse(raw)
          return { comm: r.comm, session: r.session, reason: r.reason, at: r.at.toISOString() }
        }),
      },
    }
  })

  return {
    at: now.toISOString(),
    days,
    window: { from: w.from.toISOString(), to: w.to.toISOString() },
    ...body,
    leadCosts: [...leadCosts].sort((a, b) => b.peakMibP80 - a.peakMibP80 || a.repo.localeCompare(b.repo)).slice(0, TOP),
    constants: options.constants,
  }
}
