import type { SQL } from 'bun'
import * as z from 'zod'
import type { ThroughputModel } from '@software-factory/contract'

const num = z.coerce.number()

const CountRow = z.object({ at: z.coerce.date(), key: z.string(), n: num })
const PeakRow = z.object({
  at: z.coerce.date(),
  running: z.coerce.number().nullable(),
  queued: z.coerce.number().nullable(),
})
const SpanRow = z.object({ from: z.coerce.date().nullable(), to: z.coerce.date().nullable() })

type Series = ThroughputModel['series']
type Point = Series['points'][number]

const bump = (into: Record<string, number>, key: string, n: number): void => {
  into[key] = (into[key] ?? 0) + n
}

/**
 * Leads running and Issues queued at the start of each bucket of `[from, to)`, from `lead_attempts` (started, not gone, its Issue not closed since)
 * and `queue_intervals` (open at the instant), with the host minute samples' peaks per bucket beside. A figure is read at
 * the instant, so a state shorter than a bucket can fall between two points: `peakRunning` and `peakQueued` are the
 * minute samples' maxima and see it.
 */
export async function readSeries(tx: SQL, window: { from: Date; to: Date; bucketMinutes: number }): Promise<Series> {
  const { from, to, bucketMinutes } = window
  const bucketSeconds = bucketMinutes * 60
  // the grid is aligned to the bucket as the host timeline is, so the two line up
  const start = new Date(Math.floor(from.getTime() / 1000 / bucketSeconds) * bucketSeconds * 1000)
  const step = `${bucketMinutes} minutes`

  // an attempt runs from its start to the earlier of its `gone_at` (set only for a lost lead) and the first close of its Issue
  // after the start: a lead whose Issue closed is finished, whatever its row says
  const running: unknown[] = await tx`
    WITH attempts AS (
      SELECT a.issue_id, a.started_at,
        least(a.gone_at, (SELECT min(e.at) FROM factory.issue_events e
          WHERE e.issue_id = a.issue_id AND e.result = 'applied' AND e.to_state = 'closed' AND e.at >= a.started_at)) AS ended_at
      FROM factory.lead_attempts a WHERE a.started_at IS NOT NULL AND a.started_at <= ${to})
    SELECT b.t AS at, i.repo AS key, count(*) AS n
    FROM generate_series(${start}::timestamptz, ${to}::timestamptz, ${step}::interval) AS b(t)
    JOIN attempts a ON a.started_at <= b.t AND (a.ended_at IS NULL OR a.ended_at > b.t)
    JOIN factory.issues i ON i.id = a.issue_id
    GROUP BY b.t, i.repo`
  const queuedByReason: unknown[] = await tx`
    SELECT b.t AS at, q.kind AS key, count(*) AS n
    FROM generate_series(${start}::timestamptz, ${to}::timestamptz, ${step}::interval) AS b(t)
    JOIN factory.queue_intervals q ON q.from_at <= b.t AND (q.to_at IS NULL OR q.to_at > b.t)
    GROUP BY b.t, q.kind`
  const queuedByRepo: unknown[] = await tx`
    SELECT b.t AS at, q.project AS key, count(*) AS n
    FROM generate_series(${start}::timestamptz, ${to}::timestamptz, ${step}::interval) AS b(t)
    JOIN factory.queue_intervals q ON q.from_at <= b.t AND (q.to_at IS NULL OR q.to_at > b.t)
    GROUP BY b.t, q.project`
  const peaks: unknown[] = await tx`
    SELECT to_timestamp(floor(extract(epoch FROM at) / ${bucketSeconds}::int) * ${bucketSeconds}::int) AS at,
      max(leads)::int AS running, max(queued)::int AS queued
    FROM factory.host_samples WHERE at >= ${from} AND at < ${to} GROUP BY 1`

  const points = new Map<number, Point>()
  for (let t = start.getTime(); t <= to.getTime(); t += bucketSeconds * 1000) {
    points.set(t, {
      at: new Date(t).toISOString(),
      running: 0,
      runningByRepo: {},
      queued: 0,
      queuedByReason: {},
      queuedByRepo: {},
      peakRunning: null,
      peakQueued: null,
    })
  }
  for (const raw of running) {
    const row = CountRow.parse(raw)
    const point = points.get(row.at.getTime())
    if (!point) continue
    point.running += row.n
    bump(point.runningByRepo, row.key, row.n)
  }
  for (const raw of queuedByReason) {
    const row = CountRow.parse(raw)
    const point = points.get(row.at.getTime())
    if (!point) continue
    point.queued += row.n
    bump(point.queuedByReason, row.key, row.n)
  }
  for (const raw of queuedByRepo) {
    const row = CountRow.parse(raw)
    const point = points.get(row.at.getTime())
    if (point) bump(point.queuedByRepo, row.key, row.n)
  }
  for (const raw of peaks) {
    const row = PeakRow.parse(raw)
    const point = points.get(row.at.getTime())
    if (!point) continue
    point.peakRunning = row.running
    point.peakQueued = row.queued
  }
  return { bucketMinutes, points: [...points.values()] }
}

/** The oldest and newest row of each source the throughput reads draw on, whatever the window or the epoch. */
export async function readStored(tx: SQL): Promise<ThroughputModel['stored']> {
  const span = async (rows: Promise<unknown[]>) => {
    const [row] = await rows
    const parsed = SpanRow.parse(row)
    return parsed.from && parsed.to ? { from: parsed.from.toISOString(), to: parsed.to.toISOString() } : null
  }
  return {
    hostSamples: await span(tx`SELECT min(at) AS "from", max(at) AS "to" FROM factory.host_samples`),
    hostClassSamples: await span(tx`SELECT min(at) AS "from", max(at) AS "to" FROM factory.host_class_samples`),
    queueIntervals: await span(
      tx`SELECT min(from_at) AS "from", max(coalesce(to_at, from_at)) AS "to" FROM factory.queue_intervals`,
    ),
    leadAttempts: await span(
      tx`SELECT min(first_try_at) AS "from", max(first_try_at) AS "to" FROM factory.lead_attempts`,
    ),
    stepCosts: await span(tx`SELECT min(at) AS "from", max(at) AS "to" FROM factory.step_costs`),
    mergeWindows: await span(
      tx`SELECT min(requested_at) AS "from", max(requested_at) AS "to" FROM factory.merge_windows`,
    ),
  }
}
