import type { SQL } from 'bun'
import * as z from 'zod'
import {
  ISSUE_OUTCOMES,
  type IssueOutcome,
  YIELD_LOOPS,
  type LoopYield,
  type LoopYieldModel,
  type LoopYieldWindow,
} from '@software-factory/contract'
import { percentile, windowOf } from './stats.ts'

/** The two windows every loop is read over, in days. */
const YIELD_DAYS = [7, 30] as const

type YieldLoop = (typeof YIELD_LOOPS)[number]

/** One Issue a loop's signal opened or reached, with how it ended; `closedAt` and `outcome` are null while it is open. */
interface YieldIssue {
  loop: YieldLoop
  class: string
  issue: string
  filedAt: Date
  closedAt: Date | null
  outcome: IssueOutcome | null
  verdict: 'moved' | 'flat' | 'worse' | 'unmeasured' | null
}

/** What a loop recorded over a window besides its Issues. `passes` is null for a loop that keeps no record of its passes. */
interface YieldRecord {
  passes: number | null
  signals: number
}

const by = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** One loop over one window, from its Issues (filed in the window) and its own record. Pure. */
function yieldWindow(
  issues: readonly YieldIssue[],
  record: YieldRecord,
  window: { days: number; from: Date; to: Date },
): LoopYieldWindow {
  const rows = issues.filter((i) => i.filedAt >= window.from && i.filedAt < window.to)
  // an Issue may carry findings of several classes (a hygiene batch): it counts once in the totals and once in each class
  // its verdict is moved only when every one of its findings moved
  const byIssue = new Map<string, YieldIssue>()
  for (const i of rows) {
    const seen = byIssue.get(i.issue)
    if (!seen) byIssue.set(i.issue, i)
    else if (seen.verdict === 'moved' && i.verdict !== 'moved') byIssue.set(i.issue, { ...seen, verdict: i.verdict })
  }
  const inWindow = [...byIssue.values()]
  const closes = inWindow.flatMap((i) => (i.closedAt ? [(i.closedAt.getTime() - i.filedAt.getTime()) / 1000] : []))
  const finders = new Map<string, { issues: number; noise: number }>()
  for (const i of rows) {
    const row = finders.get(i.class) ?? { issues: 0, noise: 0 }
    row.issues += 1
    if (i.outcome === 'dropped' || i.outcome === 'cancelled') row.noise += 1
    finders.set(i.class, row)
  }
  const count = (outcome: YieldIssue['outcome']): number => inWindow.filter((i) => i.outcome === outcome).length
  const moved = inWindow.filter((i) => i.outcome === 'done' && i.verdict === 'moved')
  return {
    days: window.days,
    passes: record.passes,
    signals: record.signals,
    issues: inWindow.length,
    done: count('done'),
    moved: moved.length,
    movedShare: count('done') === 0 ? null : moved.length / count('done'),
    healed: count('healed'),
    dropped: count('dropped'),
    cancelled: count('cancelled'),
    open: inWindow.filter((i) => i.closedAt === null).length,
    medianCloseSeconds: percentile(closes, 0.5),
    finders: [...finders]
      .map(([name, row]) => ({ finder: name, ...row }))
      .sort((a, b) => b.issues - a.issues || by(a.finder, b.finder))
      .slice(0, 3),
  }
}

const Row = z.object({
  loop: z.enum(YIELD_LOOPS),
  class: z.string(),
  issue: z.string(),
  filed_at: z.date(),
  closed_at: z.date().nullable(),
  outcome: z.enum(ISSUE_OUTCOMES).nullable(),
  verdict: z.enum(['moved', 'flat', 'worse', 'unmeasured']).nullable(),
})

const Count = z.object({ passes: z.coerce.number().int(), signals: z.coerce.number().int() })

/**
 * What each signal-filing loop yielded over the last 7 and 30 days: the Issues its signals opened or reached (all four loops
 * by `loop_findings`), how they ended, whether the figure each was filed against moved once it closed, how long they took
 * to close and which kinds of finding they were. No model; read-only SQL. A loop's Issue counts in the window it
 * was filed in, so a young Issue is `open` until it closes.
 */
export async function readLoopYield(sql: SQL, options: { now: Date }): Promise<LoopYieldModel> {
  const { now } = options
  const widest = windowOf(now, Math.max(...YIELD_DAYS))
  const rows: unknown[] = await sql`
    SELECT lf.loop, lf.class, i.id AS issue, f.at AS filed_at, i.outcome,
      -- an Issue with several keys of one class is as moved as its least moved key (a key not read yet is the least)
      (array_agg(lf.verdict ORDER BY CASE WHEN lf.verdict IS NULL THEN 0 WHEN lf.verdict = 'worse' THEN 1
        WHEN lf.verdict = 'flat' THEN 2 WHEN lf.verdict = 'unmeasured' THEN 3 ELSE 4 END))[1] AS verdict,
      (SELECT c.at FROM factory.issue_events c WHERE c.issue_id = i.id AND c.result = 'applied' AND c.to_state = 'closed'
        ORDER BY c.version DESC LIMIT 1) AS closed_at
    FROM factory.loop_findings lf
    JOIN factory.issues i ON i.id = lf.issue_id
    JOIN factory.issue_events f ON f.issue_id = i.id AND f.kind = 'filed' AND f.version = 1
    WHERE f.at >= ${widest.from} AND f.at < ${widest.to}
    GROUP BY lf.loop, lf.class, i.id, f.at, i.outcome
    ORDER BY lf.loop, lf.class, i.id`
  const issues: YieldIssue[] = rows.map((raw) => {
    const row = Row.parse(raw)
    return {
      loop: row.loop,
      class: row.class,
      issue: row.issue,
      filedAt: row.filed_at,
      closedAt: row.closed_at,
      outcome: row.outcome,
      verdict: row.verdict,
    }
  })

  // `filed` is a jsonb array or, as the pass stores write it (`JSON.stringify(...)::jsonb`), a jsonb string holding one: the count reads both
  const recordOf = async (loop: YieldLoop, from: Date): Promise<YieldRecord> => {
    const to = now
    const [row] =
      loop === 'friction'
        ? await sql`SELECT count(*) AS passes, coalesce(sum(jsonb_array_length(CASE WHEN jsonb_typeof(filed) = 'string' THEN (filed #>> '{}')::jsonb ELSE filed END)), 0) AS signals
            FROM factory.friction_passes WHERE at >= ${from} AND at < ${to}`
        : loop === 'hygiene'
          ? // a pass files its findings as one signal: the passes that filed anything
            await sql`SELECT count(*) AS passes, count(*) FILTER (WHERE jsonb_array_length(CASE WHEN jsonb_typeof(filed) = 'string' THEN (filed #>> '{}')::jsonb ELSE filed END) > 0) AS signals
              FROM factory.hygiene_passes WHERE at >= ${from} AND at < ${to}`
          : await sql`SELECT 0 AS passes, count(*) AS signals
              FROM factory.loop_findings WHERE loop = ${loop} AND filed_at >= ${from} AND filed_at < ${to}`
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
