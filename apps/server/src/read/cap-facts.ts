import type { SQL } from 'bun'
import * as z from 'zod'
import { DEFAULT_LEADS } from '@software-factory/contract/project'
import type { CapFact, CapFigures } from '../domains/improve/caps.ts'
import { CAP_WINDOW_HOURS } from '../kernel/throughput-limits.ts'
import type { ProjectShape } from '../domains/improve/throughput.ts'
import { boundedRead } from './bounded.ts'

const num = z.coerce.number()
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const MERGE_DAYS = 7

const BindingRow = z.object({ project: z.string(), kind: z.string(), minutes: num, issues: num, idle: num })

/**
 * The caps that held Issues back while seats idled, over the newest `CAP_WINDOW_HOURS` before `to`, with the figures a cap's
 * comment may be about. A cap counts only while it is still set: a repo whose `leads` is back at the default, or whose lane
 * has no cap, is left out. The binding minutes are the host's minute samples in which an Issue of the repo was queued for a
 * claim (a lane's cap: for the lane) and the accounts had a seat free (`seats` more than `leads` running); the comment of a cap
 * is the caller's to fill in. Every figure is SQL over stored rows, bounded so a slow read ends as an error the pass notes.
 */
export async function readCapFacts(
  sql: SQL,
  options: {
    to: Date
    shapes: ReadonlyMap<string, ProjectShape>
    /** the free and total disk now; null: unread */
    disk: { freeMib: number; totalMib: number } | null
  },
): Promise<CapFact[]> {
  const { to } = options
  const from = new Date(to.getTime() - CAP_WINDOW_HOURS * HOUR_MS)
  return boundedRead(sql, 20_000, async (tx) => {
    const rows: unknown[] = await tx`
      SELECT q.project, q.kind, count(DISTINCT h.at)::float8 AS minutes, count(DISTINCT q.issue_id)::float8 AS issues,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY h.seats - h.leads)::float8 AS idle
      FROM factory.host_samples h
      JOIN factory.queue_intervals q ON q.kind IN ('claim', 'lane') AND q.from_at <= h.at AND coalesce(q.to_at, ${to}) > h.at
      WHERE h.at >= ${from} AND h.at < ${to} AND h.seats IS NOT NULL AND h.leads IS NOT NULL AND h.seats > h.leads
      GROUP BY q.project, q.kind`
    const facts: CapFact[] = []
    const figuresOf = new Map<string, CapFigures>()
    for (const raw of rows) {
      const row = BindingRow.parse(raw)
      const shape = options.shapes.get(row.project)
      if (!shape) continue
      // a claim wait is the repo's `leads`; a lane wait names no lane here, so every capped lane of the repo stands for it
      const caps: { lane: string | null; cap: number }[] =
        row.kind === 'claim'
          ? shape.leads < DEFAULT_LEADS
            ? [{ lane: null, cap: shape.leads }]
            : []
          : [...shape.lanes].flatMap(([lane, cap]) => (cap === null ? [] : [{ lane, cap }]))
      if (caps.length === 0) continue
      let figures = figuresOf.get(row.project)
      if (!figures) {
        figures = await figuresFor(tx, row.project, to, options.disk)
        figuresOf.set(row.project, figures)
      }
      for (const cap of caps) {
        facts.push({
          project: row.project,
          lane: cap.lane,
          cap: cap.cap,
          comment: null,
          bindingMinutes: row.minutes,
          issues: row.issues,
          idleSeats: Math.round(row.idle),
          hours: CAP_WINDOW_HOURS,
          figures,
        })
      }
    }
    return facts
  })
}

async function figuresFor(
  tx: SQL,
  project: string,
  to: Date,
  disk: { freeMib: number; totalMib: number } | null,
): Promise<CapFigures> {
  const weekAgo = new Date(to.getTime() - MERGE_DAYS * DAY_MS)
  const [sizes] = (await tx`
    SELECT count(*)::float8 AS attempts, percentile_cont(0.8) WITHIN GROUP (ORDER BY mib)::float8 AS p80, max(mib)::float8 AS largest
    FROM factory.worktree_sizes WHERE repo = ${project}`) as unknown[]
  const [lead] = (await tx`
    SELECT count(*)::float8 AS attempts, percentile_cont(0.8) WITHIN GROUP (ORDER BY peak)::float8 AS p80
    FROM (SELECT max(rss_mib) AS peak FROM factory.lead_samples
          WHERE repo = ${project} AND outside_slots AND at >= ${weekAgo} AND at < ${to} GROUP BY worktree) peaks`) as unknown[]
  const [merge] = (await tx`
    SELECT count(*)::float8 AS windows,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM released_at - acquired_at) / 60.0)::float8 AS hold,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM acquired_at - requested_at) / 60.0)::float8 AS wait
    FROM factory.merge_windows
    WHERE project = ${project} AND acquired_at IS NOT NULL AND released_at >= ${weekAgo} AND released_at < ${to}`) as unknown[]
  const size = z.object({ attempts: num, p80: num.nullable(), largest: num.nullable() }).parse(sizes)
  const peak = z.object({ attempts: num, p80: num.nullable() }).parse(lead)
  const window = z.object({ windows: num, hold: num.nullable(), wait: num.nullable() }).parse(merge)
  return {
    worktrees:
      size.attempts > 0 && size.p80 !== null && size.largest !== null
        ? { attempts: size.attempts, p80Mib: Math.round(size.p80), largestMib: Math.round(size.largest) }
        : null,
    disk,
    lead: peak.attempts > 0 && peak.p80 !== null ? { attempts: peak.attempts, p80Mib: Math.round(peak.p80) } : null,
    mergeWindows:
      window.windows > 0
        ? {
            days: MERGE_DAYS,
            windows: window.windows,
            holdMedianMinutes: window.hold ?? 0,
            waitMedianMinutes: window.wait ?? 0,
          }
        : null,
  }
}
