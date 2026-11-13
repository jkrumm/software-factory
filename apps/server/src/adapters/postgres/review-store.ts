import type { SQL } from 'bun'
import * as z from 'zod'
import type { ReviewStore } from '../../app/loops/reviews.ts'

const WaitRow = z.object({ id: z.string(), repo: z.string(), since: z.coerce.number().int(), ref: z.string() })

/** The review poll's reads and its one write: what the first look saw of each pull request. */
export function postgresReviewStore(tx: SQL): ReviewStore {
  return {
    async waits() {
      const rows: unknown[] = await tx`
        SELECT i.id, i.repo, e.wait->>'since' AS since, e.wait->'holds'->>'id' AS ref
        FROM factory.issues i
        JOIN LATERAL (
          SELECT wait FROM factory.issue_events x
          WHERE x.issue_id = i.id AND x.result = 'applied' ORDER BY x.version DESC LIMIT 1
        ) e ON true
        WHERE i.state = 'waiting' AND i.wait_reason = 'external'
        ORDER BY i.id`
      return rows.map((raw) => {
        const row = WaitRow.parse(raw)
        return { issue: row.id, repo: row.repo, since: row.since, ref: row.ref }
      })
    },

    async baseline(issue, since) {
      const [row] = await tx`
        SELECT baseline FROM factory.review_looks WHERE issue_id = ${issue} AND since = ${since}`
      return row ? z.object({ baseline: z.number().int() }).parse(row).baseline : null
    },

    async saveBaseline(issue, since, baseline, at) {
      await tx`
        INSERT INTO factory.review_looks (issue_id, since, baseline, looked_at)
        VALUES (${issue}, ${since}, ${baseline}, ${at})
        ON CONFLICT (issue_id, since) DO NOTHING`
    },
  }
}
