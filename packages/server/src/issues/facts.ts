import type { IssueFactRow, IssueKpi, Ratio } from '@software-factory/contract'
import type { SQL } from 'bun'

interface FactRow {
  issue_id: number
  attempt: number
  repo: string
  kind: string | null
  size: string | null
  lead_tier: string | null
  lead_effort: string | null
  filed_at: Date
  admitted_at: Date | null
  landed_at: Date | null
  shipped_at: Date | null
  verified_at: Date | null
  closed_at: Date | null
  outcome: string | null
  asks: number
  parks: IssueFactRow['parks']
  owner_touches: number
  review_tier: string | null
  holds: number
  verify_first_pass: boolean
  first_hold_decided: boolean
  reopened: boolean
  lead_session_ids: string[]
}

const iso = (at: Date | null): string | null => at?.toISOString() ?? null

const fact = (row: FactRow): IssueFactRow => ({
  issueId: row.issue_id,
  attempt: row.attempt,
  repo: row.repo,
  kind: row.kind,
  size: row.size,
  leadTier: row.lead_tier,
  leadEffort: row.lead_effort,
  filedAt: row.filed_at.toISOString(),
  admittedAt: iso(row.admitted_at),
  landedAt: iso(row.landed_at),
  shippedAt: iso(row.shipped_at),
  verifiedAt: iso(row.verified_at),
  closedAt: iso(row.closed_at),
  outcome: row.outcome,
  asks: row.asks,
  parks: row.parks,
  ownerTouches: row.owner_touches,
  reviewTier: row.review_tier,
  holds: row.holds,
  verifyFirstPass: row.verify_first_pass,
  firstHoldDecided: row.first_hold_decided,
  reopened: row.reopened,
  leadSessionIds: row.lead_session_ids,
})

const since = (sql: SQL, from?: Date) => (from ? sql`WHERE filed_at >= ${from}` : sql``)

/** One row per attempt of the Issues filed at or after `since`, by Issue and attempt: `factory.issue_facts`, read as it is. */
export async function listFacts(sql: SQL, input: { since?: Date } = {}): Promise<IssueFactRow[]> {
  const rows: FactRow[] = await sql`
    SELECT * FROM factory.issue_facts ${since(sql, input.since)} ORDER BY issue_id, attempt`
  return rows.map(fact)
}

const ratio = (numerator: number, denominator: number): Ratio => ({
  value: denominator === 0 ? null : numerator / denominator,
  numerator,
  denominator,
})

/** The four KPIs of design v3 §11 from one query over the view; the window points are the usage tracker's, joined by a consumer. */
export async function kpis(sql: SQL, input: { since?: Date } = {}): Promise<IssueKpi> {
  const [row]: {
    issues: number
    asks: number
    verified_issues: number
    zero_touch: number
    decided: number
    open: number
    first_pass: number
  }[] = await sql`
    WITH facts AS (SELECT * FROM factory.issue_facts ${since(sql, input.since)}),
    per_issue AS (
      SELECT issue_id, sum(asks + owner_touches) AS touches, bool_or(verified_at IS NOT NULL) AS verified
      FROM facts GROUP BY issue_id
    )
    SELECT
      (SELECT count(*) FROM per_issue)::int AS issues,
      (SELECT coalesce(sum(asks), 0) FROM facts)::int AS asks,
      (SELECT count(*) FROM per_issue WHERE verified)::int AS verified_issues,
      (SELECT count(*) FROM per_issue WHERE verified AND touches = 0)::int AS zero_touch,
      (SELECT count(*) FROM facts WHERE first_hold_decided)::int AS decided,
      (SELECT count(*) FROM facts WHERE holds > 0 AND NOT first_hold_decided)::int AS open,
      (SELECT count(*) FROM facts WHERE first_hold_decided AND verify_first_pass)::int AS first_pass`
  if (!row) throw new Error('the KPI query returned no row')
  return {
    ownerAsksPerIssue: ratio(row.asks, row.issues),
    zeroTouch: ratio(row.zero_touch, row.verified_issues),
    verifyFirstHold: { ...ratio(row.first_pass, row.decided), open: row.open },
    windowPointsPerIssue: { value: null, source: 'usage-tracker' },
  }
}
