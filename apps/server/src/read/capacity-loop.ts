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
      minutesOverCeiling: { total: over, perDay: perDay(overDay, 0) },
      slotWait: { n: waitRow.n, p50Ms: waitRow.p50, p90Ms: waitRow.p90, perDayP50: perDay(waitDay, null) },
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
