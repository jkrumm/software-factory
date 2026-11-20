import type { SQL } from 'bun'
import * as z from 'zod'
import { boundedRead } from './bounded.ts'

/** An attempt's peak counts its samples of the six hours before its last one (`domains/capacity/leadcost.ts` `LEARN_WINDOW_MS`, which `read/` may not import). */
const LEARN_WINDOW_MS = 6 * 60 * 60_000

/** What a repo's leads cost outside test slots, from the minute samples of their process trees (what runs under a slot run is left out). */
export interface RepoLeadCost {
  repo: string
  /** the attempts sampled */
  attempts: number
  /** 80th percentile (nearest rank) of the newest 10 attempts' peak MiB; the burst a lead reaches, not the figure admission reserves: that is the median of the same ten, or the largest of the newest three settled attempts when all are below it (`learnLeadCost`) */
  peakMibP80: number
}

const Row = z.object({
  repo: z.string(),
  attempts: z.coerce.number().int(),
  peak_p80: z.coerce.number().int(),
})

/**
 * Per repo: the peak of every attempt (its worktree's largest sample of its last six hours, from the repo's relearn point on, the
 * population admission learns from), then the 80th percentile of the newest ten
 * attempts' peaks (nearest rank, but at the 0.8 share where `learnedLeadMib` takes the median, and with no minimum of attempts: the caller decides
 * whether `attempts` is enough).
 */
export async function readLeadCosts(sql: SQL, epoch: Date | null = null): Promise<RepoLeadCost[]> {
  const found: unknown[] = await boundedRead(sql, 5_000, async (tx) => {
    return await tx`
      WITH counted AS (
        SELECT s.repo, s.worktree, s.at, s.rss_mib FROM factory.lead_samples s
        LEFT JOIN factory.lead_relearn r ON r.repo = s.repo
        WHERE s.outside_slots AND (r.at IS NULL OR s.at >= r.at) AND s.at >= coalesce(${epoch}::timestamptz, '-infinity')
      ), lasts AS (
        SELECT repo, worktree, max(at) AS last_at FROM counted GROUP BY repo, worktree
      ), peaks AS (
        SELECT c.repo, c.worktree, max(c.rss_mib) AS peak, l.last_at
        FROM counted c JOIN lasts l ON l.repo = c.repo AND l.worktree = c.worktree
        WHERE c.at >= l.last_at - ${LEARN_WINDOW_MS / 1000} * interval '1 second'
        GROUP BY c.repo, c.worktree, l.last_at
      ), ranked AS (
        SELECT repo, peak, row_number() OVER (PARTITION BY repo ORDER BY last_at DESC, worktree) AS newest
        FROM peaks
      ), kept AS (
        SELECT repo, peak, newest, count(*) OVER (PARTITION BY repo) AS n,
          row_number() OVER (PARTITION BY repo ORDER BY peak, newest) AS place
        FROM ranked WHERE newest <= 10
      )
      SELECT repo, (SELECT count(*) FROM peaks p WHERE p.repo = k.repo) AS attempts,
        max(peak) FILTER (WHERE place = ceil(0.8 * n)) AS peak_p80
      FROM kept k GROUP BY repo, n ORDER BY repo`
  })
  return found.map((raw) => {
    const row = Row.parse(raw)
    return { repo: row.repo, attempts: row.attempts, peakMibP80: row.peak_p80 }
  })
}
