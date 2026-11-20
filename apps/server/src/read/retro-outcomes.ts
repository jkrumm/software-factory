import type { SQL } from 'bun'
import * as z from 'zod'
import type { RetroOutcomes } from '../domains/loops/retro.ts'
import { windowOf } from './stats.ts'

const Count = z.object({ n: z.coerce.number().int() })

/** Issues closed from `since` to `now`, as the cycle KPI counts them: an applied event into `closed`. What the friction loop's volume trigger counts. */
export async function readClosedSince(sql: SQL, options: { since: Date; now: Date }): Promise<number> {
  const [row] = await sql`
    SELECT count(*) AS n FROM factory.issue_events
    WHERE to_state = 'closed' AND result = 'applied' AND at > ${options.since} AND at <= ${options.now}`
  return Count.parse(row).n
}

/** When the subject last had an Issue filed for it, null when never: what the friction loop reads to file the retro once a week. */
export async function readLastFiled(sql: SQL, options: { source: string; subject: string }): Promise<Date | null> {
  const [row] = await sql`
    SELECT max(filed_at) AS at FROM factory.intake_subjects
    WHERE source = ${options.source} AND subject = ${options.subject}`
  return z.object({ at: z.date().nullable() }).parse(row).at
}

const Row = z.object({
  signals: z.coerce.number().int(),
  shipped: z.coerce.number().int(),
  done: z.coerce.number().int(),
  dropped: z.coerce.number().int(),
  open: z.coerce.number().int(),
})

/**
 * What the retro signals of the last `days` days (those ending in a `Retro:` marker, as the ledger finds them) led to: the
 * Issue each opened, shipped or closed, and the signals that reached none (the throughput loop's improvements end in the same
 * marker and are left out: they have a row in its own ledger). Each signal is counted once, in the first of
 * shipped, done, dropped, open that fits.
 */
export async function readRetroOutcomes(sql: SQL, options: { now: Date; days: number }): Promise<RetroOutcomes> {
  const w = windowOf(options.now, options.days)
  const [row] = await sql`
    SELECT count(*) AS signals,
      count(*) FILTER (WHERE shipped) AS shipped,
      count(*) FILTER (WHERE NOT shipped AND state = 'closed' AND outcome IN ('done', 'healed')) AS done,
      count(*) FILTER (WHERE NOT shipped AND state = 'closed' AND outcome IN ('dropped', 'cancelled')) AS dropped,
      count(*) FILTER (WHERE NOT shipped AND state IS NOT NULL AND state <> 'closed') AS open
    FROM (
      SELECT i.state, i.outcome, EXISTS (
        SELECT 1 FROM factory.issue_events e WHERE e.issue_id = s.issue_id AND e.kind = 'shipped' AND e.result = 'applied') AS shipped
      FROM factory.intake_signals s LEFT JOIN factory.issues i ON i.id = s.issue_id
      WHERE NOT EXISTS (SELECT 1 FROM factory.loop_findings t WHERE t.loop = 'throughput' AND t.signal_id = s.id)
        AND s.text ~ 'Retro: [0-9]{4}-[0-9]{2}-[0-9]{2} kpi=[a-z0-9_]+ before=' AND s.received_at >= ${w.from} AND s.received_at < ${w.to}
    ) r`
  return { days: options.days, ...Row.parse(row) }
}
