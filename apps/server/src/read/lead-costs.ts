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
  /** the attempts with a physical footprint recorded */
  footprintAttempts: number
  /** the same two figures from the summed physical footprint, over the newest ten attempts that have one; null with none */
  footprintMibP80: number | null
  lastFootprintMib: number | null
  /** median of (footprint peak / RSS peak) over those attempts, two decimals; null with none */
  footprintToRss: number | null
}

const Row = z.object({
  repo: z.string(),
  attempts: z.coerce.number().int(),
  peak_p80: z.coerce.number().int(),
  last_peak: z.coerce.number().int(),
  footprint_attempts: z.coerce.number().int(),
  footprint_p80: z.coerce.number().int().nullable(),
  last_footprint: z.coerce.number().int().nullable(),
  footprint_ratio: z.coerce.number().nullable(),
})

/**
 * Per repo: the peak of every attempt (its worktree's largest sample), then the 80th percentile of the newest ten
 * attempts' peaks (nearest rank, as `learnedLeadMib` takes it, but with no minimum of attempts: the caller decides
 * whether `attempts` is enough) and the newest attempt's peak. The same two figures again from the physical footprint,
 * over the newest ten attempts that have one (rows from before the footprint was recorded, or minutes `top` failed, have
 * none), with the median of footprint peak over RSS peak: the calibration of one against the other.
 */
export async function readLeadCosts(sql: SQL): Promise<RepoLeadCost[]> {
  const rows = await boundedRead(sql, 5_000, async (tx) => {
    const found: unknown[] = await tx`
      WITH peaks AS (
        SELECT repo, worktree, max(rss_mib) AS peak, max(footprint_mib) AS fp_peak, max(at) AS last_at
        FROM factory.lead_samples GROUP BY repo, worktree
      ), ranked AS (
        SELECT repo, peak, row_number() OVER (PARTITION BY repo ORDER BY last_at DESC, worktree) AS newest
        FROM peaks
      ), kept AS (
        SELECT repo, peak, newest, count(*) OVER (PARTITION BY repo) AS n,
          row_number() OVER (PARTITION BY repo ORDER BY peak, newest) AS place
        FROM ranked WHERE newest <= 10
      ), rss AS (
        SELECT repo, (SELECT count(*) FROM peaks p WHERE p.repo = k.repo) AS attempts,
          max(peak) FILTER (WHERE place = ceil(0.8 * n)) AS peak_p80,
          max(peak) FILTER (WHERE newest = 1) AS last_peak
        FROM kept k GROUP BY repo, n
      ), fp_ranked AS (
        SELECT repo, peak, fp_peak, row_number() OVER (PARTITION BY repo ORDER BY last_at DESC, worktree) AS newest
        FROM peaks WHERE fp_peak IS NOT NULL
      ), fp_kept AS (
        SELECT repo, peak, fp_peak, newest, count(*) OVER (PARTITION BY repo) AS n,
          row_number() OVER (PARTITION BY repo ORDER BY fp_peak, newest) AS place
        FROM fp_ranked WHERE newest <= 10
      ), fp AS (
        SELECT repo, (SELECT count(*) FROM peaks p WHERE p.repo = f.repo AND p.fp_peak IS NOT NULL) AS footprint_attempts,
          max(fp_peak) FILTER (WHERE place = ceil(0.8 * n)) AS footprint_p80,
          max(fp_peak) FILTER (WHERE newest = 1) AS last_footprint,
          round((percentile_cont(0.5) WITHIN GROUP (ORDER BY fp_peak::numeric / greatest(peak, 1)))::numeric, 2) AS footprint_ratio
        FROM fp_kept f GROUP BY repo, n
      )
      SELECT rss.repo, rss.attempts, rss.peak_p80, rss.last_peak, coalesce(fp.footprint_attempts, 0) AS footprint_attempts,
        fp.footprint_p80, fp.last_footprint, fp.footprint_ratio
      FROM rss LEFT JOIN fp ON fp.repo = rss.repo ORDER BY rss.repo`
    return found
  })
  return rows.map((raw) => {
    const row = Row.parse(raw)
    return {
      repo: row.repo,
      attempts: row.attempts,
      peakMibP80: row.peak_p80,
      lastPeakMib: row.last_peak,
      footprintAttempts: row.footprint_attempts,
      footprintMibP80: row.footprint_p80,
      lastFootprintMib: row.last_footprint,
      footprintToRss: row.footprint_ratio,
    }
  })
}
