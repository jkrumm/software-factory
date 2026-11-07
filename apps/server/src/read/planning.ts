import type { SQL } from 'bun'
import * as z from 'zod'
import type { DependencyWait, IssueReads, OpenIssueRow } from '../domains/planning/ports.ts'
import { type IssueId, issueId } from '../kernel/ids.ts'

const idOf = (text: string): IssueId => issueId(Number(text.slice('issue_'.length)))

const OpenRow = z.object({
  id: z.string(),
  repo: z.string(),
  state: z.enum(['settling', 'queued', 'working', 'waiting', 'watching']),
  wait_reason: z.string().nullable(),
  kind: z.string(),
  finalizing: z.boolean(),
})

const WaitRow = z.object({
  id: z.string(),
  wait: z.object({ since: z.number().int(), after: z.array(z.string()) }),
})

/**
 * What planning reads of the Issues, which the work domain owns. Read-only SQL on the work tables, on the caller's
 * transaction: the Issue row, its `filed` event (the kind), its open `finalize` effect and the wait its last applied
 * event made.
 */
export function readIssues(tx: SQL): IssueReads {
  return {
    async open() {
      const rows: unknown[] = await tx`
        SELECT i.id, i.repo, i.state, i.wait_reason,
          (SELECT e.payload->>'kind' FROM factory.issue_events e WHERE e.issue_id = i.id AND e.kind = 'filed' LIMIT 1) AS kind,
          EXISTS (
            SELECT 1 FROM factory.issue_effects f
            WHERE f.issue_id = i.id AND f.kind = 'finalize' AND f.done_at IS NULL AND f.cancelled_at IS NULL) AS finalizing
        FROM factory.issues i WHERE i.state <> 'closed' ORDER BY i.id`
      return rows.map((raw): OpenIssueRow => {
        const row = OpenRow.parse(raw)
        return {
          id: idOf(row.id),
          repo: row.repo,
          state: row.state,
          waitReason: row.wait_reason,
          kind: row.kind,
          finalizing: row.finalizing,
        }
      })
    },

    async statesOf(ids) {
      if (ids.length === 0) return new Map()
      const rows: unknown[] = await tx`SELECT id, state FROM factory.issues WHERE id IN ${tx([...ids])}`
      return new Map(
        rows.map((raw) => {
          const row = z.object({ id: z.string(), state: z.string() }).parse(raw)
          return [idOf(row.id), row.state === 'closed' ? ('closed' as const) : ('open' as const)] as const
        }),
      )
    },

    async dependencyWaits() {
      const rows: unknown[] = await tx`
        SELECT i.id, e.wait
        FROM factory.issues i
        JOIN LATERAL (
          SELECT wait FROM factory.issue_events x
          WHERE x.issue_id = i.id AND x.result = 'applied' ORDER BY x.version DESC LIMIT 1
        ) e ON true
        WHERE i.state = 'waiting' AND i.wait_reason = 'dependency'`
      return rows.map((raw): DependencyWait => {
        const row = WaitRow.parse(raw)
        return { issue: idOf(row.id), since: row.wait.since, after: row.wait.after.map(idOf) }
      })
    },
  }
}
