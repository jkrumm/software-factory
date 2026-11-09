import type { HostSample } from '@software-factory/contract'
import type { SQL } from 'bun'
import * as z from 'zod'
import { boundedRead } from './bounded.ts'

const DAY_MS = 24 * 3_600_000

const Row = z.object({
  at: z.date(),
  load: z.number().nullable(),
  memory_used_pct: z.number().nullable(),
  swap_used_pct: z.number().nullable(),
  swapout_mb_per_300s: z.number().nullable(),
})

/** The samples of the last 24 hours, oldest first (at most 1440 at one a minute). */
export async function readHostSamples(sql: SQL, now: Date): Promise<HostSample[]> {
  const since = new Date(now.getTime() - DAY_MS)
  const rows = await boundedRead(sql, 5_000, async (tx) => {
    const found: unknown[] = await tx`
      SELECT at, load, memory_used_pct, swap_used_pct, swapout_mb_per_300s
      FROM factory.host_samples WHERE at >= ${since} AND at <= ${now} ORDER BY at LIMIT 1500`
    return found
  })
  return rows.map((raw) => {
    const row = Row.parse(raw)
    return {
      at: row.at.toISOString(),
      load: row.load,
      memoryUsedPct: row.memory_used_pct,
      swapUsedPct: row.swap_used_pct,
      swapoutMbPer300s: row.swapout_mb_per_300s,
    }
  })
}
