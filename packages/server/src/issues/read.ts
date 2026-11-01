import type { Issue, IssueOutcome, IssueState, IssueSummary, WaitReason } from '@software-factory/contract'
import type { SQL } from 'bun'

export interface IssueRow {
  id: number
  state: IssueState
  reason: WaitReason | null
  outcome: IssueOutcome | null
  source: string
  source_key: string
  repo: string
  title: string
  facts: unknown
  kind: string | null
  class: string | null
  parent: number | null
  attempt: number
  hold: number
  waits: number
  wake_at: Date | null
  created_at: Date
  updated_at: Date
  closed_at: Date | null
}

const summary = (row: Omit<IssueRow, 'facts'>): IssueSummary => ({
  id: row.id,
  state: row.state,
  reason: row.reason,
  outcome: row.outcome,
  source: row.source,
  sourceKey: row.source_key,
  repo: row.repo,
  title: row.title,
  kind: row.kind,
  class: row.class,
  parent: row.parent,
  attempt: row.attempt,
  wakeAt: row.wake_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  closedAt: row.closed_at?.toISOString() ?? null,
})

export const toIssue = (row: IssueRow): Issue => ({ ...summary(row), facts: row.facts })

export async function getIssue(sql: SQL, id: number): Promise<Issue | undefined> {
  const [row]: IssueRow[] = await sql`SELECT * FROM factory.issues WHERE id = ${id}`
  return row && toIssue(row)
}

export async function findIssue(sql: SQL, source: string, sourceKey: string): Promise<Issue | undefined> {
  const [row]: IssueRow[] = await sql`
    SELECT * FROM factory.issues WHERE source = ${source} AND source_key = ${sourceKey}`
  return row && toIssue(row)
}

/** Newest first; a list carries no facts, `GET /issues/:id` does. */
export async function listIssues(sql: SQL, limit = 200): Promise<IssueSummary[]> {
  const rows: Omit<IssueRow, 'facts'>[] = await sql`
    SELECT id, state, reason, outcome, source, source_key, repo, title, kind, class, parent, attempt, wake_at, created_at,
           updated_at, closed_at
    FROM factory.issues ORDER BY created_at DESC, id DESC LIMIT ${limit}`
  return rows.map(summary)
}
