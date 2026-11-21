import type { SQL } from 'bun'
import * as z from 'zod'
import { ISSUE_STATES } from '@software-factory/contract'
import type { FindingIssue } from '../domains/hygiene/hygiene-lifecycle.ts'
import type { HygieneReads } from '../domains/hygiene/ports.ts'

const FindingIssueRow = z.object({
  key: z.string(),
  issue: z.string(),
  state: z.enum(ISSUE_STATES),
  outcome: z.enum(['done', 'healed', 'dropped', 'cancelled']).nullable(),
  filed_at: z.date(),
  closed_at: z.date().nullable(),
  reopens: z.number().int(),
})

/** What the hygiene pass reads across the work tables: the Issues its finding keys filed. Read-only SQL on the caller's transaction. */
export function hygieneReads(tx: SQL): HygieneReads {
  return {
    async findingIssues(repo) {
      // the newest Issue of each key (by when it was filed), its state, how it closed and how often it was reopened
      const rows: unknown[] = await tx`
        SELECT DISTINCT ON (lf.key) lf.key, i.id AS issue, i.state, i.outcome, f.at AS filed_at,
          (SELECT c.at FROM factory.issue_events c WHERE c.issue_id = i.id AND c.result = 'applied' AND c.to_state = 'closed' ORDER BY c.version DESC LIMIT 1) AS closed_at,
          (SELECT count(*) FROM factory.issue_events r WHERE r.issue_id = i.id AND r.result = 'applied' AND r.kind = 'reopened')::int AS reopens
        FROM factory.loop_findings lf
        JOIN factory.issues i ON i.id = lf.issue_id
        JOIN factory.issue_events f ON f.issue_id = i.id AND f.kind = 'filed' AND f.version = 1
        WHERE lf.loop = 'hygiene' AND lf.repo = ${repo}
        ORDER BY lf.key, f.at DESC, i.id DESC`
      return rows.map((raw): FindingIssue => {
        const row = FindingIssueRow.parse(raw)
        return {
          key: row.key,
          issue: row.issue,
          state: row.state,
          outcome: row.outcome,
          filedAt: row.filed_at,
          closedAt: row.state === 'closed' ? row.closed_at : null,
          reopens: row.reopens,
        }
      })
    },
  }
}
