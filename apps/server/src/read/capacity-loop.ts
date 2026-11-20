import type { SQL } from 'bun'
import * as z from 'zod'
import type { CapacityLoopModel } from '@software-factory/contract'
import { OWNED_ELSEWHERE_KINDS } from '../kernel/throughput-limits.ts'
import { boundedRead } from './bounded.ts'
import { queuedHours } from './queue-time.ts'
import { countedFrom, epochNote } from '../kernel/epoch.ts'
import { EDGE_NEED_DAYS, notNeededShare, stopsEdges } from '../kernel/edge-need.ts'
import { readEdgeNeed } from './edge-need.ts'
import { readLeadCosts } from './lead-costs.ts'
import { REPO_OF_STEP } from './retro-build.ts'
import { windowOf } from './stats.ts'

/** The settings in force that the capacity loop tunes; the server hands them over from the settings it holds. */
export type CapacityConstants = CapacityLoopModel['constants']

const TOP = 8
/** The queue kind of a drained queue (`QUEUE_REASONS`): Issues wait for the owner or the orchestrator, not for capacity. */
const DRAIN_KIND = 'drain'
const NEWEST_REAPED = 5
const DAY_MS = 24 * 3_600_000

const Day = z.object({ day: z.string(), v: z.coerce.number().nullable() })
const Total = z.object({ v: z.coerce.number().nullable() })

/** The edges the factory added over the window, whether they were needed, per source and in all. */
async function edgesOf(tx: SQL, window: { from: Date; to: Date }): Promise<CapacityLoopModel['edges']> {
  const need = await readEdgeNeed(tx, window)
  // `stopped` is what the loops decide: over the last `EDGE_NEED_DAYS` ending with the window, not over the days asked for
  const deciding = await readEdgeNeed(tx, {
    from: new Date(window.to.getTime() - EDGE_NEED_DAYS * DAY_MS),
    to: window.to,
  })
  const stopped = (source: string) => stopsEdges(deciding.find((n) => n.source === source))
  const total = need.reduce((sum, n) => ({ needed: sum.needed + n.needed, notNeeded: sum.notNeeded + n.notNeeded }), {
    needed: 0,
    notNeeded: 0,
  })
  return {
    notNeededShare: notNeededShare(total),
    bySource: need.map((n) => ({ ...n, notNeededShare: notNeededShare(n), stopped: stopped(n.source) })),
  }
}

/**
 * What the capacity loop did over the last `days` days, all computed in SQL over the window `[now - days, now)`. A day is
 * a UTC date. Percentiles are `percentile_cont` (linear interpolation, the same rule as `stats.ts`'s `percentile`, which
 * the KPIs use in memory), so the figures are the database's own and the test restates each one in plain SQL.
 * Reuses the closed-Issue definition of the cycle KPI: an applied event into `closed`.
 */
export async function readCapacityLoop(
  sql: SQL,
  options: { now: Date; days: number; constants: CapacityConstants; epoch?: Date | null },
): Promise<CapacityLoopModel> {
  const { now } = options
  const epoch = options.epoch ?? null
  const asked = windowOf(options.now, options.days)
  const w = { from: countedFrom(asked.from, epoch), to: asked.to }
  // the days the counted window spans: the asked days, fewer when the epoch cut it (a per-day figure divides by these)
  const days = Math.max(1, Math.min(options.days, Math.ceil((w.to.getTime() - w.from.getTime()) / DAY_MS)))
  const leadCosts = await readLeadCosts(sql, epoch)

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

    // what the queue waited for: intervals clipped to the window, and the idle minutes split among the kinds queued in them
    const queued = await queuedHours(tx, w)
    const queuedByKind = new Map(
      [...Map.groupBy(queued, (s) => s.kind)].map(([kind, spans]) => [
        kind,
        { issues: new Set(spans.map((s) => s.issue)).size, hours: spans.reduce((sum, s) => sum + s.hours, 0) },
      ]),
    )
    const reposByKind = new Map<string, Array<{ repo: string; queuedHours: number; issues: number }>>()
    for (const [kind, spans] of Map.groupBy(queued, (s) => s.kind))
      reposByKind.set(
        kind,
        [...Map.groupBy(spans, (s) => s.project)].map(([repo, rows]) => ({
          repo,
          queuedHours: rows.reduce((sum, s) => sum + s.hours, 0),
          issues: new Set(rows.map((s) => s.issue)).size,
        })),
      )
    // The idle samples are read twice from the table (not from one CTE): a CTE used twice is materialized, and the join from
    // each interval to the samples it covers (the primary key's range scan) is then a nested loop over every pair, 7,500 samples
    // by 19,000 intervals took 6 s (the route's p95 of 2026-11-18). The samples with no interval left-join back as 'unrecorded'.
    const idleRows: unknown[] = await tx`
      WITH ivs AS (
        SELECT kind, from_at, to_at FROM factory.queue_intervals
        WHERE from_at < ${w.to} AND coalesce(to_at, ${w.to}) > ${w.from}),
      covered AS (
        SELECT h.at,
          array_agg(DISTINCT q.kind) FILTER (WHERE q.kind NOT IN ${tx([...OWNED_ELSEWHERE_KINDS])}) AS capacity_kinds,
          array_agg(DISTINCT q.kind) AS all_kinds
        FROM ivs q JOIN factory.host_samples h ON h.at >= q.from_at AND h.at < coalesce(q.to_at, ${w.to})
        WHERE h.queued > 0 AND h.seats IS NOT NULL AND h.leads IS NOT NULL AND greatest(h.seats - h.leads, 0) > 0
          AND h.at >= ${w.from} AND h.at < ${w.to}
        GROUP BY h.at),
      kinds AS (
        SELECT h.at, greatest(h.seats - h.leads, 0) AS seats,
          coalesce(c.capacity_kinds, c.all_kinds, ARRAY['unrecorded']) AS kinds
        FROM factory.host_samples h LEFT JOIN covered c ON c.at = h.at
        WHERE h.queued > 0 AND h.seats IS NOT NULL AND h.leads IS NOT NULL AND greatest(h.seats - h.leads, 0) > 0
          AND h.at >= ${w.from} AND h.at < ${w.to})
      SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, kind, sum(seats::float8 / 60 / cardinality(kinds)) AS hours
      FROM kinds, unnest(kinds) AS kind GROUP BY 1, 2`
    const Idle = z.object({ day: z.string(), kind: z.string(), hours: z.coerce.number().nullable() })
    const idleParsed = idleRows.map((raw) => Idle.parse(raw))
    const idleByKind = new Map<string, number>()
    for (const r of idleParsed) idleByKind.set(r.kind, (idleByKind.get(r.kind) ?? 0) + (r.hours ?? 0))
    // the share behind a drained queue (an owner or orchestrator state, not capacity going unused), by the same split
    const drainRows = idleParsed.filter((r) => r.kind === DRAIN_KIND).map((r) => ({ day: r.day, v: r.hours ?? 0 }))
    const queueByReason = [...new Set([...queuedByKind.keys(), ...idleByKind.keys()])]
      .map((kind) => ({
        kind,
        queuedHours: queuedByKind.get(kind)?.hours ?? 0,
        issues: queuedByKind.get(kind)?.issues ?? 0,
        idleSeatHours: idleByKind.get(kind) ?? 0,
        byRepo: (reposByKind.get(kind) ?? []).toSorted(
          (a, b) => b.queuedHours - a.queuedHours || a.repo.localeCompare(b.repo),
        ),
      }))
      .toSorted(
        (a, b) => b.queuedHours - a.queuedHours || b.idleSeatHours - a.idleSeatHours || a.kind.localeCompare(b.kind),
      )

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
    const waitDayP90: unknown[] = await tx`
      SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY wait_ms)::float8 AS v
      FROM factory.step_costs WHERE at >= ${w.from} AND at < ${w.to} GROUP BY 1`
    const leadsDay: unknown[] = await tx`
      SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, avg(leads)::float8 AS v
      FROM factory.host_samples WHERE leads IS NOT NULL AND at >= ${w.from} AND at < ${w.to} GROUP BY 1`
    const [wait] = await tx`
      SELECT count(*) AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_ms)::float8 AS p50,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY wait_ms)::float8 AS p90
      FROM factory.step_costs WHERE at >= ${w.from} AND at < ${w.to}`
    const waitRow = z
      .object({ n: z.coerce.number().int(), p50: z.coerce.number().nullable(), p90: z.coerce.number().nullable() })
      .parse(wait)

    // what each wait waited for: a wait's ms are split by reason, so a reason's figures are over the waits that spent time under it
    const REASON_STATS = `count(*) AS waits, sum(ms) AS total, percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) AS p50,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY ms) AS p90, max(ms) AS max`
    const reasonRows: unknown[] = await tx`
      WITH x AS (
        SELECT coalesce(${tx.unsafe(REPO_OF_STEP)}, '(unknown)') AS repo, w.key AS reason, w.value::float8 AS ms
        FROM factory.slot_waits s, jsonb_each_text(s.split) w WHERE s.at >= ${w.from} AND s.at < ${w.to})
      SELECT repo, reason, ${tx.unsafe(REASON_STATS)} FROM x GROUP BY repo, reason`
    const repoRows: unknown[] = await tx`
      WITH x AS (
        SELECT coalesce(${tx.unsafe(REPO_OF_STEP)}, '(unknown)') AS repo, wait_ms::float8 AS ms
        FROM factory.slot_waits s WHERE s.at >= ${w.from} AND s.at < ${w.to})
      SELECT repo, ${tx.unsafe(REASON_STATS)} FROM x GROUP BY repo`
    const allReasonRows: unknown[] = await tx`
      WITH x AS (
        SELECT w.key AS reason, w.value::float8 AS ms
        FROM factory.slot_waits s, jsonb_each_text(s.split) w WHERE s.at >= ${w.from} AND s.at < ${w.to})
      SELECT reason, ${tx.unsafe(REASON_STATS)} FROM x GROUP BY reason`
    const Stats = {
      waits: z.coerce.number().int(),
      total: z.coerce.number(),
      p50: z.coerce.number().nullable(),
      p90: z.coerce.number().nullable(),
      max: z.coerce.number().nullable(),
    }
    const Reason = z.enum(['slots', 'memory', 'swap', 'load', 'unsized', 'line', 'cores', 'class'])
    const statsOf = (r: {
      waits: number
      total: number
      p50: number | null
      p90: number | null
      max: number | null
    }) => ({
      waits: r.waits,
      totalMs: r.total,
      p50Ms: r.p50,
      p90Ms: r.p90,
      maxMs: r.max,
    })
    const byTotal = <T extends { totalMs: number }>(list: T[]) => list.toSorted((a, b) => b.totalMs - a.totalMs)
    const byReasonAll = byTotal(
      allReasonRows
        .map((raw) => z.object({ reason: Reason, ...Stats }).parse(raw))
        .map((r) => ({ reason: r.reason, ...statsOf(r) })),
    )
    const reasonsByRepo = new Map<string, typeof byReasonAll>()
    for (const raw of reasonRows) {
      const r = z.object({ repo: z.string(), reason: Reason, ...Stats }).parse(raw)
      reasonsByRepo.set(r.repo, [...(reasonsByRepo.get(r.repo) ?? []), { reason: r.reason, ...statsOf(r) }])
    }
    const byRepoAll = byTotal(
      repoRows
        .map((raw) => z.object({ repo: z.string(), ...Stats }).parse(raw))
        .map((r) => ({ repo: r.repo, ...statsOf(r), byReason: byTotal(reasonsByRepo.get(r.repo) ?? []) })),
    )

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

    const aimMinutes = (row: Record<string, unknown>, prefix: string) => ({
      minutes: Number(row[`${prefix}_minutes`] ?? 0),
      swapoutMbMean: row[`${prefix}_swapout`] === null ? null : Number(row[`${prefix}_swapout`]),
      pressureAboveNormal: row[`${prefix}_pressure`] === null ? null : Number(row[`${prefix}_pressure`]),
      critical: Number(row[`${prefix}_critical`] ?? 0),
    })
    const [aimRow] = await tx`
      SELECT
        count(*) AS minutes,
        count(*) FILTER (WHERE aim_slots > live_slots AND waiters > 0) AS more_waiting,
        count(*) FILTER (WHERE aim_slots > live_slots) AS more_minutes,
        avg(swapout_mb_per_300s) FILTER (WHERE aim_slots > live_slots)::float8 AS more_swapout,
        (count(*) FILTER (WHERE aim_slots > live_slots AND pressure_level > 1))::float8
          / nullif(count(*) FILTER (WHERE aim_slots > live_slots AND pressure_level IS NOT NULL), 0) AS more_pressure,
        count(*) FILTER (WHERE aim_slots > live_slots AND pressure_level = 4) AS more_critical,
        count(*) FILTER (WHERE aim_slots <= live_slots) AS other_minutes,
        avg(swapout_mb_per_300s) FILTER (WHERE aim_slots <= live_slots)::float8 AS other_swapout,
        (count(*) FILTER (WHERE aim_slots <= live_slots AND pressure_level > 1))::float8
          / nullif(count(*) FILTER (WHERE aim_slots <= live_slots AND pressure_level IS NOT NULL), 0) AS other_pressure,
        count(*) FILTER (WHERE aim_slots <= live_slots AND pressure_level = 4) AS other_critical
      FROM factory.slot_shadow WHERE at >= ${w.from} AND at < ${w.to}`
    const [aimNow] = await tx`SELECT target FROM factory.slot_aim WHERE id = 1`
    const aim = (aimRow ?? {}) as Record<string, unknown>
    const slotAim = {
      target: aimNow ? z.object({ target: z.coerce.number().int() }).parse(aimNow).target : null,
      minutes: Number(aim.minutes ?? 0),
      moreSlots: aimMinutes(aim, 'more'),
      otherwise: aimMinutes(aim, 'other'),
      moreSlotsWithWaiter: Number(aim.more_waiting ?? 0),
    }

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
      idleSeatHoursDrain: { total: idleByKind.get(DRAIN_KIND) ?? 0, perDay: perDay(drainRows, 0) },
      queueByReason,
      edges: await edgesOf(tx, w),
      minutesOverCeiling: { total: over, perDay: perDay(overDay, 0) },
      leadsRunning: perDay(leadsDay, null),
      slotAim,
      slotWait: {
        n: waitRow.n,
        p50Ms: waitRow.p50,
        p90Ms: waitRow.p90,
        perDayP50: perDay(waitDay, null),
        perDayP90: perDay(waitDayP90, null),
        byReason: byReasonAll,
        byRepo: byRepoAll,
      },
      swapoutMib: { total: swap, perDay: perDay(swapDay, 0) },
      minutesUnderPressure: { total: pressured, perDay: perDay(pressureDay, 0) },
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
    epoch: epochNote(asked.from, epoch),
    ...body,
    leadCosts: [...leadCosts].sort((a, b) => b.peakMibP80 - a.peakMibP80 || a.repo.localeCompare(b.repo)).slice(0, TOP),
    constants: options.constants,
  }
}
