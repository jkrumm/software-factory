import type { SQL } from 'bun'
import { createIssue } from '../issues/create.ts'
import { record } from '../notify/outbox.ts'
import { planFinishedMessage } from '../notify/text.ts'
import { planStatus } from './plan-status.ts'

/**
 * The plan's share of a tick, after the sync (design §4 "The plan files its next Issue"): every `filable` row becomes an Issue of
 * source `plan`, key `<project>:<row key>`, in the row's project, with the row's facts and `{plan: {project, key}}`. The dependencies are
 * closed already, so `after` is not passed. `createIssue` keeps the key unique, so a replayed tick files nothing twice and a closed
 * row is never filed again; a refused row is an error of the pass and the others still go. A plan with every row done, in a project with no open
 * Issue, tells the owner once per plan content. Returns the errors for the tick's log.
 */
export async function planPass(sql: SQL, context: { repoRoots: readonly string[]; now: Date }): Promise<string[]> {
  const errors: string[] = []
  for (const plan of await planStatus(sql, context.now)) {
    for (const row of plan.rows) {
      if (row.state !== 'filable' || !row.target || row.row.title === undefined) continue
      try {
        await createIssue(
          sql,
          {
            source: 'plan',
            sourceKey: `${plan.project}:${row.key}`,
            repo: row.target.repo,
            title: row.row.title,
            facts: { ...row.row.facts, plan: { project: plan.project, key: row.key } },
          },
          context,
        )
      } catch (error) {
        errors.push(`plan ${plan.project}:${row.key}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!plan.sha || plan.rows.some((row) => row.state !== 'done')) continue
    try {
      const [open]: { id: number }[] = await sql`
        SELECT id FROM factory.issues WHERE repo = ${plan.repo} AND state <> 'closed' LIMIT 1`
      if (!open) await record(sql, planFinishedMessage({ project: plan.project, sha: plan.sha }), context.now)
    } catch (error) {
      errors.push(`plan ${plan.project}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return errors
}
