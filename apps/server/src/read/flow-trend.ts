import type { SQL } from 'bun'
import * as z from 'zod'
import { type FlowTrendSeries, WORK_TREND_KEYS, type WorkTrendKey, workTrendOfState } from '@software-factory/contract'

const HOUR_MS = 3_600_000
const BUCKET_MS = { hour: HOUR_MS, day: 24 * HOUR_MS } as const
const WINDOW_MS = { '24h': 24 * HOUR_MS, '7d': 7 * 24 * HOUR_MS, '30d': 30 * 24 * HOUR_MS } as const

/** One stretch of an Issue in one state: from the applied event that put it there to the next one (null: still there). */
export interface StateInterval {
  state: string
  from: Date
  to: Date | null
}

const Row = z.object({ state: z.string(), from: z.date(), to: z.date().nullable() })

/** The bucket starts the trend plots: the last one holds `now`, the one before it ends where it starts. UTC hours or days. */
export function bucketStarts(
  now: Date,
  window: FlowTrendSeries['window'],
  bucket: FlowTrendSeries['bucket'],
): number[] {
  const size = BUCKET_MS[bucket]
  const count = Math.floor(WINDOW_MS[window] / size)
  const last = Math.floor(now.getTime() / size) * size
  return Array.from({ length: count }, (_, i) => last - (count - 1 - i) * size)
}

const round2 = (value: number): number => Math.round(value * 100) / 100

/**
 * The four counts per bucket (running, paused, not started, checking) from the Issues' state intervals. An instant counts
 * an Issue once in the count its state belongs to (`WORK_TREND_STATES`), however many events put it there; the peak is the most at any instant of the
 * bucket, the average the mean over the part of the bucket that has passed. Pure.
 */
export function trendOf(
  intervals: readonly StateInterval[],
  options: { now: Date; window: FlowTrendSeries['window']; bucket: FlowTrendSeries['bucket'] },
): FlowTrendSeries {
  const { now, window, bucket } = options
  const nowMs = now.getTime()
  const starts = bucketStarts(now, window, bucket)
  const size = BUCKET_MS[bucket]
  const origin = starts[0] ?? nowMs

  // per count: the change of the count at each instant, an interval of any of its states adding one from its start to its end
  const changes: Record<WorkTrendKey, Map<number, number>> = {
    running: new Map(),
    paused: new Map(),
    notStarted: new Map(),
    checking: new Map(),
  }
  for (const interval of intervals) {
    const count = workTrendOfState(interval.state)
    if (!count) continue
    const from = Math.max(interval.from.getTime(), origin)
    const to = Math.min(interval.to?.getTime() ?? nowMs, nowMs)
    if (to <= from) continue
    const map = changes[count]
    map.set(from, (map.get(from) ?? 0) + 1)
    map.set(to, (map.get(to) ?? 0) - 1)
  }

  const points = Object.fromEntries(
    WORK_TREND_KEYS.map((count) => {
      const steps = [...changes[count]].sort((a, b) => a[0] - b[0])
      let next = 0
      let level = 0
      const perBucket = starts.map((start) => {
        const end = Math.min(start + size, nowMs)
        // everything at or before the bucket's start is already in the level
        while (next < steps.length && (steps[next]?.[0] ?? Infinity) <= start) level += steps[next++]?.[1] ?? 0
        let peak = level
        let area = 0
        let cursor = start
        while (next < steps.length && (steps[next]?.[0] ?? Infinity) < end) {
          const [at, delta] = steps[next++] ?? [end, 0]
          area += level * (at - cursor)
          cursor = at
          level += delta
          peak = Math.max(peak, level)
        }
        area += level * (end - cursor)
        const covered = end - start
        return { peak, avg: round2(covered > 0 ? area / covered : level) }
      })
      return [count, perBucket]
    }),
  ) as Record<WorkTrendKey, { peak: number; avg: number }[]>

  return {
    at: now.toISOString(),
    window,
    bucket,
    buckets: starts.map((start, i) => ({
      at: new Date(start).toISOString(),
      running: points.running[i] ?? { peak: 0, avg: 0 },
      paused: points.paused[i] ?? { peak: 0, avg: 0 },
      notStarted: points.notStarted[i] ?? { peak: 0, avg: 0 },
      checking: points.checking[i] ?? { peak: 0, avg: 0 },
    })),
  }
}

/**
 * The flow trend of the last `window` in `bucket`s, from the applied events of every Issue: the state an Issue was in
 * at any instant is the `to_state` of its latest applied event at or before it. Read-only SQL, counts only.
 */
export async function readFlowTrend(
  sql: SQL,
  options: { now: Date; window: FlowTrendSeries['window']; bucket: FlowTrendSeries['bucket'] },
): Promise<FlowTrendSeries> {
  const { now, window, bucket } = options
  const origin = new Date(bucketStarts(now, window, bucket)[0] ?? now.getTime())
  const rows: unknown[] = await sql`
    SELECT e.to_state AS state, e.at AS "from", e.next_at AS "to"
    FROM (
      SELECT x.to_state, x.at, lead(x.at) OVER (PARTITION BY x.issue_id ORDER BY x.version) AS next_at
      FROM factory.issue_events x
      WHERE x.result = 'applied' AND x.at <= ${now}::timestamptz
    ) e
    WHERE e.to_state IN ('settling', 'queued', 'working', 'waiting', 'watching')
      AND (e.next_at IS NULL OR e.next_at > ${origin}::timestamptz)`
  return trendOf(
    rows.map((raw) => Row.parse(raw)),
    options,
  )
}
