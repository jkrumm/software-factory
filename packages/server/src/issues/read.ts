import type {
  Effort,
  Issue,
  IssueOutcome,
  IssueState,
  IssueSummary,
  Tier,
  WaitReason,
} from '@software-factory/contract'
import type { SQL } from 'bun'

export interface IssueRow {
  id: number
  state: IssueState
  reason: WaitReason | null
  wall_session: string | null
  outcome: IssueOutcome | null
  source: string
  source_key: string
  repo: string
  title: string
  facts: unknown
  kind: string | null
  class: string | null
  size: string | null
  lead_tier: Tier | null
  lead_effort: Effort | null
  classify: unknown
  classified_at: Date | null
  parent: number | null
  attempt: number
  hold: number
  waits: number
  revision: number
  wake_at: Date | null
  created_at: Date
  updated_at: Date
  closed_at: Date | null
}

/** What a list selects: the row without what only the lifecycle and `GET /issues/:id` read. */
type SummaryRow = Omit<IssueRow, 'facts' | 'wall_session' | 'hold' | 'waits' | 'revision' | 'classify'>

const summary = (row: SummaryRow): IssueSummary => ({
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
  size: row.size,
  tier: row.lead_tier,
  effort: row.lead_effort,
  classifiedAt: row.classified_at?.toISOString() ?? null,
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

/**
 * Newest first; a list carries no facts, `GET /issues/:id` does. `scope` keeps the open or the closed ones; `byActivity` puts the open
 * ones first, the most recently moved on top (the read API's order).
 */
export async function listIssues(
  sql: SQL,
  limit = 200,
  options: { scope?: 'open' | 'closed' | 'all'; byActivity?: boolean } = {},
): Promise<IssueSummary[]> {
  const where =
    options.scope === 'open'
      ? sql`WHERE state <> 'closed'`
      : options.scope === 'closed'
        ? sql`WHERE state = 'closed'`
        : sql``
  const order = options.byActivity
    ? sql`ORDER BY (state = 'closed'), updated_at DESC, id DESC`
    : sql`ORDER BY created_at DESC, id DESC`
  const rows: SummaryRow[] = await sql`
    SELECT id, state, reason, outcome, source, source_key, repo, title, kind, class, size, lead_tier, lead_effort, classified_at, parent,
           attempt, wake_at, created_at, updated_at, closed_at
    FROM factory.issues ${where} ${order} LIMIT ${limit}`
  return rows.map(summary)
}
