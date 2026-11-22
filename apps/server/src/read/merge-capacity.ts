import type { SQL } from 'bun'
import * as z from 'zod'
import type { MergeFigures } from '../kernel/merge-capacity.ts'

const num = z.coerce.number()
const DAY_MS = 86_400_000

const Windows = z.object({
  windows: num,
  merges: num,
  held: num.nullable(),
  hold: num.nullable(),
  wait: num.nullable(),
  wait_p90: num.nullable(),
})
const Ci = z.object({ queue: num.nullable(), run: num.nullable() })

/**
 * What a project's merge windows and CI runs measured over the `days` before `to`: the windows that got the window with how long
 * they held it and waited for it, and the finished runs' wait for a runner and run time. Stored rows only; `mergeCapacityOf`
 * turns them into what the repo can merge.
 */
export async function readMergeFigures(
  sql: SQL,
  options: { project: string; to: Date; days: number },
): Promise<MergeFigures> {
  const { project, to, days } = options
  const from = new Date(to.getTime() - days * DAY_MS)
  const [windows] = (await sql`
    SELECT count(*)::float8 AS windows, (count(*) FILTER (WHERE exit_code = 0))::float8 AS merges,
      sum(extract(epoch FROM released_at - acquired_at))::float8 / 60 AS held,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM released_at - acquired_at) / 60.0)::float8 AS hold,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM acquired_at - requested_at) / 60.0)::float8 AS wait,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM acquired_at - requested_at) / 60.0)::float8 AS wait_p90
    FROM factory.merge_windows
    WHERE project = ${project} AND acquired_at IS NOT NULL AND released_at >= ${from} AND released_at < ${to}`) as unknown[]
  const [ci] = (await sql`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM started_at - queued_at) / 60.0)::float8 AS queue,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - started_at) / 60.0)::float8 AS run
    FROM factory.ci_runs
    WHERE repo = ${project} AND conclusion IN ('success', 'failure', 'timed_out') AND finished_at >= ${from} AND finished_at < ${to}`) as unknown[]
  const w = Windows.parse(windows)
  const c = Ci.parse(ci)
  return {
    days,
    windows: w.windows,
    merges: w.merges,
    heldMinutes: w.held ?? 0,
    holdMedianMinutes: w.hold ?? 0,
    waitMedianMinutes: w.wait ?? 0,
    waitP90Minutes: w.wait_p90 ?? 0,
    ciQueueMedianMinutes: c.queue,
    ciRunMedianMinutes: c.run,
  }
}
