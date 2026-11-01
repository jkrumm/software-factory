import type { SQL } from 'bun'
import { enqueue } from './inbox.ts'
import type { IssueRow } from './read.ts'
import type { Context, InboxRow } from './shared.ts'

const isIssueId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2_147_483_647

/**
 * Only an open Issue can be waited on: a closed one would never wake this one. The blocker's row is locked, so a close in flight
 * finishes first and is seen here, and one that comes later sees the new row. A dep that closes a cycle would wake nobody.
 */
export async function addDependency({ tx, issue, row }: Context): Promise<string | undefined> {
  const on = row.payload?.on
  if (!isIssueId(on) || on === issue.id) return 'a dep needs another Issue in `on`'
  const [blocker]: Pick<IssueRow, 'state'>[] = await tx`SELECT state FROM factory.issues WHERE id = ${on} FOR SHARE`
  if (!blocker) return `no Issue ${on}`
  if (blocker.state === 'closed') return `Issue ${on} is closed already`
  const [cycle] = await tx`
    WITH RECURSIVE reached (id) AS (
      SELECT on_issue FROM factory.issue_deps WHERE issue_id = ${on}
      UNION
      SELECT d.on_issue FROM factory.issue_deps d JOIN reached r ON d.issue_id = r.id
    )
    SELECT 1 FROM reached WHERE id = ${issue.id}`
  if (cycle) return `Issue ${on} depends on this one`
  await tx`INSERT INTO factory.issue_deps (issue_id, on_issue) VALUES (${issue.id}, ${on}) ON CONFLICT DO NOTHING`
  return undefined
}

/**
 * A close satisfies every dep on the Issue and ends its own: the rows go, so a blocker that reopens later holds nobody back. An
 * Issue left with no dep is woken.
 */
export async function releaseDependents(tx: SQL, issueId: number, cause: InboxRow, now: Date): Promise<void> {
  const released: { issue_id: number }[] = await tx`
    DELETE FROM factory.issue_deps WHERE on_issue = ${issueId} RETURNING issue_id`
  await tx`DELETE FROM factory.issue_deps WHERE issue_id = ${issueId}`
  for (const { issue_id: id } of released) {
    const [free] = await tx`
      SELECT 1 FROM factory.issues i
      WHERE i.id = ${id} AND i.state = 'waiting' AND i.reason = 'dependency'
        AND NOT EXISTS (SELECT 1 FROM factory.issue_deps d WHERE d.issue_id = i.id)`
    if (!free) continue
    await enqueue(tx, {
      issueId: id,
      key: `wake:${id}:dep:${cause.key}`,
      kind: 'wake',
      at: now,
      payload: { for: 'dependency' },
    })
  }
}
