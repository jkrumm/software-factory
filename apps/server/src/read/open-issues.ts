import type { SQL } from 'bun'
import type { ClosedIssue, OpenIssue } from '../domains/intake/model.ts'
import type { OpenIssues } from '../domains/intake/ports.ts'
import type { IssueId } from '../kernel/ids.ts'
import { err, ok, portError } from '../kernel/result.ts'

/**
 * The Issues of a repo that are not closed, with the title of their `filed` event: what intake matches a person's signal
 * against. A read across the work domain's tables, so it lives here and writes nothing.
 */
export function postgresOpenIssues(sql: SQL): OpenIssues {
  return {
    async inRepo(repo) {
      try {
        const rows: { id: string; state: string; title: string; kind: string }[] = await sql`
          SELECT i.id, i.state, e.payload->>'title' AS title, COALESCE((SELECT s.payload->>'kind' FROM factory.issue_events s WHERE s.issue_id = i.id AND s.kind = 'settled' AND s.result = 'applied' ORDER BY s.version DESC LIMIT 1), e.payload->>'kind') AS kind
          FROM factory.issues i
          JOIN factory.issue_events e ON e.issue_id = i.id AND e.kind = 'filed' AND e.version = 1
          WHERE i.repo = ${repo} AND i.state <> 'closed'
          ORDER BY i.id`
        return ok(
          rows.map((row): OpenIssue => ({ id: row.id as IssueId, title: row.title, kind: row.kind, state: row.state })),
        )
      } catch (error) {
        return err(portError('gone', error instanceof Error ? error.message : String(error)))
      }
    },

    async closedSince(repo, since, limit) {
      try {
        const rows: { id: string; title: string; outcome: string; reason: string | null; closed_at: Date }[] =
          await sql`
          SELECT i.id, e.payload->>'title' AS title, i.outcome, c.payload->>'reason' AS reason, c.at AS closed_at
          FROM factory.issues i
          JOIN factory.issue_events e ON e.issue_id = i.id AND e.kind = 'filed' AND e.version = 1
          JOIN LATERAL (
            SELECT x.at, x.payload FROM factory.issue_events x
            WHERE x.issue_id = i.id AND x.result = 'applied' AND x.to_state = 'closed'
            ORDER BY x.version DESC LIMIT 1
          ) c ON true
          WHERE i.repo = ${repo} AND i.state = 'closed' AND c.at >= ${since}
          ORDER BY c.at DESC, i.id DESC
          LIMIT ${limit}`
        return ok(
          rows.map((row): ClosedIssue => ({
            id: row.id as IssueId,
            title: row.title,
            outcome: row.outcome ?? 'closed',
            reason: row.reason,
            closedAt: row.closed_at,
          })),
        )
      } catch (error) {
        return err(portError('gone', error instanceof Error ? error.message : String(error)))
      }
    },
  }
}
