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
  processes: z.number().int().nullable(),
  cpu_user_pct: z.number().nullable(),
  cpu_sys_pct: z.number().nullable(),
  cpu_idle_pct: z.number().nullable(),
})

/** The samples of the last 24 hours, oldest first (at most 1440 at one a minute). */
export async function readHostSamples(sql: SQL, now: Date): Promise<HostSample[]> {
  const since = new Date(now.getTime() - DAY_MS)
  const rows = await boundedRead(sql, 5_000, async (tx) => {
    const found: unknown[] = await tx`
      SELECT at, load, memory_used_pct, swap_used_pct, swapout_mb_per_300s, processes, cpu_user_pct, cpu_sys_pct, cpu_idle_pct
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
      processes: row.processes,
      cpuUserPct: row.cpu_user_pct,
      cpuSysPct: row.cpu_sys_pct,
      cpuIdlePct: row.cpu_idle_pct,
    }
  })
}
