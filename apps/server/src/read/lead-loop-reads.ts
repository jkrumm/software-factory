import type { SQL } from 'bun'
import * as z from 'zod'
import { LEAD_ACTIVE_ISSUE_STATES } from '@software-factory/contract'
import type { IssueId } from '../kernel/ids.ts'
import type { LeadLoopReads } from '../domains/leads/ports.ts'

const Blocked = z.object({
  issue_id: z.string(),
  watch: z.number().int(),
  attempt: z.number().int(),
  checks: z.number().int(),
  since: z.date(),
  detail: z.string().nullable(),
})

/** What the steward reads of the live leads: their repos, and whose watch has a checkout that stays blocked. Read-only SQL on the caller's transaction. */
export function leadLoopReads(tx: SQL): LeadLoopReads {
  return {
    async liveRepos(limit) {
      const rows: { repo: string; issues: string[] }[] = await tx`
        SELECT repo, array_agg(id ORDER BY id) AS issues
        FROM factory.issues
        WHERE state = ANY(${tx.array([...LEAD_ACTIVE_ISSUE_STATES], 'TEXT')})
        GROUP BY repo
        ORDER BY repo LIMIT ${limit}`
      return rows.map((row) => ({ repo: row.repo, issues: row.issues as IssueId[] }))
    },

    async blockedCheckouts(streak, limit) {
      // The open watch of a watching Issue, with its newest `streak` checks all blocked, and a failing `checkout` check on the newest run (proof writes it only when the checkout is blocked): a CI wait has none.
      const rows: unknown[] = await tx`
        SELECT w.issue_id, w.watch, w.attempt, last.checks, last.since,
          (SELECT c.checks::text FROM factory.quality_checks c WHERE c.watch_key = w.key ORDER BY c.n DESC LIMIT 1) AS detail
        FROM factory.quality_watches w
        JOIN factory.issues i ON i.id = w.issue_id AND i.state = 'watching'
        JOIN LATERAL (
          SELECT count(*)::int AS checks, min(at) AS since
          FROM (SELECT outcome, at FROM factory.quality_checks WHERE watch_key = w.key ORDER BY n DESC LIMIT ${streak}) recent
          WHERE outcome = 'blocked'
        ) last ON last.checks >= ${streak}
        WHERE w.answer IS NULL
          AND EXISTS (
            SELECT 1 FROM factory.quality_checks c
            CROSS JOIN LATERAL jsonb_array_elements(c.checks) AS e
            WHERE c.watch_key = w.key
              AND c.n = (SELECT max(m.n) FROM factory.quality_checks m WHERE m.watch_key = w.key)
              AND e->>'name' = 'checkout' AND e->>'ok' = 'false'
          )
        ORDER BY w.issue_id LIMIT ${limit}`
      return rows.map((raw) => {
        const row = Blocked.parse(raw)
        return {
          issue: row.issue_id as IssueId,
          watch: row.watch,
          attempt: row.attempt,
          checks: row.checks,
          since: row.since,
          detail: row.detail ?? '',
        }
      })
    },
  }
}
