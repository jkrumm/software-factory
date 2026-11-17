import type { SQL } from 'bun'
import * as z from 'zod'
import { YIELD_LOOPS, type LoopYield, type LoopYieldModel, type LoopYieldWindow } from '@software-factory/contract'
import { percentile, windowOf } from './stats.ts'

/** The two windows every loop is read over, in days. */
export const YIELD_DAYS = [7, 30] as const

type YieldLoop = (typeof YIELD_LOOPS)[number]

/** One Issue a loop's signal opened or reached, with how it ended; `closedAt` and `outcome` are null while it is open. */
export interface YieldIssue {
  loop: YieldLoop
  class: string
  issue: string
  filedAt: Date
  closedAt: Date | null
  outcome: 'done' | 'healed' | 'dropped' | 'cancelled' | null
}

/** What a loop recorded over a window besides its Issues. `passes` is null for a loop that keeps no record of its passes. */
export interface YieldRecord {
  passes: number | null
  signals: number
}

const by = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** One loop over one window, from its Issues (filed in the window) and its own record. Pure. */
export function yieldWindow(
  issues: readonly YieldIssue[],
  record: YieldRecord,
  window: { days: number; from: Date; to: Date },
): LoopYieldWindow {
  const inWindow = issues.filter((i) => i.filedAt >= window.from && i.filedAt < window.to)
  const closes = inWindow.flatMap((i) => (i.closedAt ? [(i.closedAt.getTime() - i.filedAt.getTime()) / 1000] : []))
  const classes = new Map<string, { issues: number; noise: number }>()
  for (const i of inWindow) {
    const row = classes.get(i.class) ?? { issues: 0, noise: 0 }
    row.issues += 1
    if (i.outcome === 'dropped' || i.outcome === 'cancelled') row.noise += 1
    classes.set(i.class, row)
  }
  const count = (outcome: YieldIssue['outcome']): number => inWindow.filter((i) => i.outcome === outcome).length
  return {
    days: window.days,
    passes: record.passes,
    signals: record.signals,
    issues: inWindow.length,
    done: count('done'),
    healed: count('healed'),
    dropped: count('dropped'),
    cancelled: count('cancelled'),
    open: inWindow.filter((i) => i.closedAt === null).length,
    medianCloseSeconds: percentile(closes, 0.5),
    classes: [...classes]
      .map(([name, row]) => ({ class: name, ...row }))
      .sort((a, b) => b.issues - a.issues || by(a.class, b.class))
      .slice(0, 3),
  }
}

const Row = z.object({
  loop: z.enum(YIELD_LOOPS),
  class: z.string(),
  issue: z.string(),
  filed_at: z.date(),
  closed_at: z.date().nullable(),
  outcome: z.enum(['done', 'healed', 'dropped', 'cancelled']).nullable(),
})

const Count = z.object({ passes: z.coerce.number().int(), signals: z.coerce.number().int() })

/**
 * What each signal-filing loop yielded over the last 7 and 30 days: the Issues its signals opened or reached (friction and
 * hygiene by `loop_findings`, selfwatch by the signal its row holds, throughput by its ledger), how they ended, how long
 * they took to close and which kinds of finding they were. No model; read-only SQL. A loop's Issue counts in the window it
 * was filed in, so a young Issue is `open` until it closes.
 */
export async function readLoopYield(sql: SQL, options: { now: Date }): Promise<LoopYieldModel> {
  const { now } = options
  const widest = windowOf(now, Math.max(...YIELD_DAYS))
  const rows: unknown[] = await sql`
    WITH found AS (
      SELECT loop, class, issue_id FROM factory.loop_findings
      UNION ALL
      SELECT 'selfwatch', sw.kind, sw.issue_id FROM (
        SELECT DISTINCT ON (s.issue_id) f.kind, s.issue_id
        FROM factory.selfwatch_findings f JOIN factory.intake_signals s ON s.id = f.signal_id
        WHERE s.issue_id IS NOT NULL
        ORDER BY s.issue_id, f.first_seen_at) sw
      UNION ALL
      SELECT 'throughput', kpi, issue_id FROM factory.throughput_findings WHERE issue_id IS NOT NULL
    )
    SELECT found.loop, found.class, i.id AS issue, f.at AS filed_at, i.outcome,
      (SELECT c.at FROM factory.issue_events c WHERE c.issue_id = i.id AND c.result = 'applied' AND c.to_state = 'closed'
        ORDER BY c.version DESC LIMIT 1) AS closed_at
    FROM found
    JOIN factory.issues i ON i.id = found.issue_id
    JOIN factory.issue_events f ON f.issue_id = i.id AND f.kind = 'filed' AND f.version = 1
    WHERE f.at >= ${widest.from} AND f.at < ${widest.to}
    ORDER BY found.loop, found.class, i.id`
  const issues: YieldIssue[] = rows.map((raw) => {
    const row = Row.parse(raw)
    return {
      loop: row.loop,
      class: row.class,
      issue: row.issue,
      filedAt: row.filed_at,
      closedAt: row.closed_at,
      outcome: row.outcome,
    }
  })

  const recordOf = async (loop: YieldLoop, from: Date): Promise<YieldRecord> => {
    const to = now
    const [row] =
      loop === 'friction'
        ? await sql`SELECT count(*) AS passes, coalesce(sum(jsonb_array_length(filed)), 0) AS signals
            FROM factory.friction_passes WHERE at >= ${from} AND at < ${to}`
        : loop === 'hygiene'
          ? await sql`SELECT count(*) AS passes, coalesce(sum(jsonb_array_length(filed)), 0) AS signals
              FROM factory.hygiene_passes WHERE at >= ${from} AND at < ${to}`
          : loop === 'selfwatch'
            ? await sql`SELECT 0 AS passes, count(*) AS signals
                FROM factory.selfwatch_findings WHERE last_filed_at >= ${from} AND last_filed_at < ${to}`
            : await sql`SELECT 0 AS passes, count(*) AS signals
                FROM factory.throughput_findings WHERE filed_at >= ${from} AND filed_at < ${to}`
    const parsed = Count.parse(row)
    // selfwatch and throughput keep no row per pass
    return { passes: loop === 'friction' || loop === 'hygiene' ? parsed.passes : null, signals: parsed.signals }
  }

  const loops: LoopYield[] = []
  for (const loop of YIELD_LOOPS) {
    const own = issues.filter((i) => i.loop === loop)
    const windows: LoopYieldWindow[] = []
    for (const days of YIELD_DAYS) {
      const w = windowOf(now, days)
      windows.push(yieldWindow(own, await recordOf(loop, w.from), { days, ...w }))
    }
    loops.push({ loop, windows })
  }
  return { at: now.toISOString(), loops }
}
