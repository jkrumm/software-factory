import type { SQL } from 'bun'
import * as z from 'zod'

/** The span a read looks at; an interval still open runs to `to`. */
export interface QueueSpan {
  from: Date
  to: Date
}

/** The queued time of one Issue under one reason in one repo, clipped to the window. */
export interface QueuedHours {
  issue: string
  project: string
  /** `queue_intervals.kind`: what held the Issue */
  kind: string
  hours: number
  /** how many intervals the hours are the sum of */
  intervals: number
}

const Row = z.object({
  issue_id: z.string(),
  project: z.string(),
  kind: z.string(),
  hours: z.coerce.number().nullable(),
  intervals: z.coerce.number().int(),
})

/**
 * The one definition of queue time: the intervals of `factory.queue_intervals` that touch the window, clipped to it (an open
 * interval runs to the window's end), summed per Issue, project and reason. Every read of queued time (the KPI's parts, the
 * capacity loop, the retro's waste, the throughput loop's waits) is a fold of these rows, so they agree for one window.
 */
export async function queuedHours(sql: SQL, w: QueueSpan): Promise<QueuedHours[]> {
  const rows: unknown[] = await sql`
    SELECT issue_id, project, kind, count(*) AS intervals,
      sum(extract(epoch FROM least(coalesce(to_at, ${w.to}::timestamptz), ${w.to}::timestamptz) - greatest(from_at, ${w.from}::timestamptz)))::float8 / 3600 AS hours
    FROM factory.queue_intervals
    WHERE from_at < ${w.to}::timestamptz AND coalesce(to_at, ${w.to}::timestamptz) > ${w.from}::timestamptz
    GROUP BY issue_id, project, kind`
  return rows.map((raw) => {
    const r = Row.parse(raw)
    return { issue: r.issue_id, project: r.project, kind: r.kind, hours: r.hours ?? 0, intervals: r.intervals }
  })
}

/** Queue reasons (`queue_intervals.kind`) in the four groups the owner reads, and the rest (`other`). */
export const QUEUE_GROUPS: ReadonlyArray<readonly [key: string, label: string, kinds: readonly string[]]> = [
  ['capacity', 'Capacity', ['memory', 'memory_fit', 'disk', 'claim', 'lane', 'window', 'cap', 'load', 'boot']],
  ['chain', 'An after edge', ['chain']],
  ['drain', 'Draining: the queue or a project', ['drain']],
  ['production_red', 'Production red', ['line']],
]

/** The kinds that count as capacity: what the KPI's `capacity` part and the capacity loop's capacity share both sum. */
export const CAPACITY_KINDS: readonly string[] = QUEUE_GROUPS[0]?.[2] ?? []

/** The hours per kind, folded from `queuedHours`. */
export function hoursByKind(spans: readonly QueuedHours[]): Map<string, number> {
  const byKind = new Map<string, number>()
  for (const s of spans) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + s.hours)
  return byKind
}
