import type { SQL } from 'bun'
import * as z from 'zod'
import { boundedRead } from './bounded.ts'

/** What a repo's leads cost, from the minute samples of their process trees. */
export interface RepoLeadCost {
  repo: string
  /** the attempts sampled */
  attempts: number
  /** 80th percentile (nearest rank) of the newest 10 attempts' peak MiB */
  peakMibP80: number
  /** the peak MiB of the newest attempt */
  lastPeakMib: number
}

const Row = z.object({
  repo: z.string(),
  attempts: z.coerce.number().int(),
  peak_p80: z.coerce.number().int(),
  last_peak: z.coerce.number().int(),
})

/**
 * Per repo: the peak of every attempt (its worktree's largest sample), then the 80th percentile of the newest ten
 * attempts' peaks (nearest rank, as `learnedLeadMib` takes it, but with no minimum of attempts: the caller decides
 * whether `attempts` is enough) and the newest attempt's peak.
 */
export async function readLeadCosts(sql: SQL): Promise<RepoLeadCost[]> {
  const rows = await boundedRead(sql, 5_000, async (tx) => {
    const found: unknown[] = await tx`
      WITH peaks AS (
        SELECT repo, worktree, max(rss_mib) AS peak, max(at) AS last_at
        FROM factory.lead_samples GROUP BY repo, worktree
      ), ranked AS (
        SELECT repo, peak, row_number() OVER (PARTITION BY repo ORDER BY last_at DESC, worktree) AS newest
        FROM peaks
      ), kept AS (
        SELECT repo, peak, newest, count(*) OVER (PARTITION BY repo) AS n,
          row_number() OVER (PARTITION BY repo ORDER BY peak, newest) AS place
        FROM ranked WHERE newest <= 10
      )
      SELECT repo, (SELECT count(*) FROM peaks p WHERE p.repo = k.repo) AS attempts,
        max(peak) FILTER (WHERE place = ceil(0.8 * n)) AS peak_p80,
        max(peak) FILTER (WHERE newest = 1) AS last_peak
      FROM kept k GROUP BY repo, n ORDER BY repo`
    return found
  })
  return rows.map((raw) => {
    const row = Row.parse(raw)
    return { repo: row.repo, attempts: row.attempts, peakMibP80: row.peak_p80, lastPeakMib: row.last_peak }
  })
}
