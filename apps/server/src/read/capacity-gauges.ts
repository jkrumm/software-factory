import type { SQL } from 'bun'
import * as z from 'zod'
import { boundedRead } from './bounded.ts'
import { REPO_OF_STEP } from './retro-build.ts'

/**
 * The capacity figures a monitoring feed shows: what `read capacity-loop` and `read throughput` hold as day totals, taken
 * as the state now and the last `windowMs` (queued Issues by reason, slot waits, step placements, seats held, the load
 * beside its ceiling). Same tables and the same definitions as those reads, so a chart and `factory read` agree.
 */
export interface CapacityGauges {
  /** Issues queued now, by the kind of the reason (`queue_intervals` with no end) */
  queue: { reason: string; issues: number }[]
  /** slot waits that ended inside the window, per reason and repo (a wait counts for each reason of its split) */
  slotWaits: { reason: string; repo: string; waits: number; totalMs: number }[]
  /** their 90th percentile per reason, over every repo */
  slotWaitP90: { reason: string; p90Ms: number }[]
  /** remote-capable steps placed inside the window, by the host and the reason */
  placements: { host: string; reason: string; steps: number }[]
  /** leads holding a claim now, per account */
  seats: { account: string; used: number }[]
  /** the newest minute sample, when it is not older than `HOST_FRESH_MS`; null otherwise */
  host: { load: number; loadCeiling: number | null } | null
}

/** A host sample older than this says nothing about now (a minute sample, three missed). */
export const HOST_FRESH_MS = 3 * 60_000

const Queue = z.object({ kind: z.string(), n: z.coerce.number() })
const Waits = z.object({
  reason: z.string(),
  repo: z.string(),
  waits: z.coerce.number(),
  total: z.coerce.number(),
})
const P90 = z.object({ reason: z.string(), p90: z.coerce.number() })
const Placed = z.object({ host: z.string(), reason: z.string(), n: z.coerce.number() })
const Seats = z.object({ account: z.string(), n: z.coerce.number() })
const Host = z.object({ load: z.coerce.number().nullable(), load_ceiling: z.coerce.number().nullable() })

export async function readCapacityGauges(sql: SQL, options: { now: Date; windowMs: number }): Promise<CapacityGauges> {
  const { now } = options
  const from = new Date(now.getTime() - options.windowMs)
  const hostFrom = new Date(now.getTime() - HOST_FRESH_MS)
  return boundedRead(sql, 5_000, async (tx) => {
    const queue: unknown[] = await tx`
      SELECT kind, count(*) AS n FROM factory.queue_intervals WHERE to_at IS NULL GROUP BY kind`
    const waits: unknown[] = await tx`
      WITH x AS (
        SELECT coalesce(${tx.unsafe(REPO_OF_STEP)}, '(unknown)') AS repo, w.key AS reason, w.value::float8 AS ms
        FROM factory.slot_waits s, jsonb_each_text(s.split) w WHERE s.at >= ${from} AND s.at < ${now})
      SELECT reason, repo, count(*) AS waits, sum(ms) AS total FROM x GROUP BY reason, repo`
    const p90: unknown[] = await tx`
      WITH x AS (
        SELECT w.key AS reason, w.value::float8 AS ms
        FROM factory.slot_waits s, jsonb_each_text(s.split) w WHERE s.at >= ${from} AND s.at < ${now})
      SELECT reason, percentile_cont(0.9) WITHIN GROUP (ORDER BY ms) AS p90 FROM x GROUP BY reason`
    const placed: unknown[] = await tx`
      SELECT host, reason, count(*) AS n FROM factory.step_placements WHERE at >= ${from} AND at < ${now} GROUP BY host, reason`
    const seats: unknown[] = await tx`
      SELECT account, count(*) AS n FROM factory.capacity_claims WHERE account IS NOT NULL GROUP BY account`
    const [host] = await tx`
      SELECT load, load_ceiling FROM factory.host_samples WHERE at >= ${hostFrom} AND at < ${now} ORDER BY at DESC LIMIT 1`
    const sample = host ? Host.parse(host) : null
    return {
      queue: queue.map((raw) => Queue.parse(raw)).map((r) => ({ reason: r.kind, issues: r.n })),
      slotWaits: waits
        .map((raw) => Waits.parse(raw))
        .map((r) => ({ reason: r.reason, repo: r.repo, waits: r.waits, totalMs: r.total })),
      slotWaitP90: p90.map((raw) => P90.parse(raw)).map((r) => ({ reason: r.reason, p90Ms: r.p90 })),
      placements: placed.map((raw) => Placed.parse(raw)).map((r) => ({ host: r.host, reason: r.reason, steps: r.n })),
      seats: seats.map((raw) => Seats.parse(raw)).map((r) => ({ account: r.account, used: r.n })),
      host: sample && sample.load !== null ? { load: sample.load, loadCeiling: sample.load_ceiling } : null,
    }
  })
}
