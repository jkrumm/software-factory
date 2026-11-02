import type { SQL } from 'bun'
import { lockCapacity } from '../capacity.ts'
import { projectOfPath, tryClaim } from '../projects/claims.ts'
import { effectiveState, loadQueueStates } from '../queue.ts'
import { enqueue } from './inbox.ts'

/** Most Issues one pass admits; the rest wait for the next. */
const BATCH = 20

export interface AdmitOptions {
  now: Date
  /**
   * `FACTORY_ALERT_LEADS`: whether an `alert` Issue gets a lead. Off until Wave 4's evidence is live (decision 3); such an Issue
   * stays `queued`. A request is not asked.
   */
  alertLeads: boolean
}

interface Waiting {
  id: number
  repo: string
  source: string
  attempt: number
}

/**
 * Admission for Issues: each classified, `queued` Issue the project's claim has room for gets the `admitted` event (key
 * `admit:<issue>:<attempt>`, so a second admission is the same row) and holds the claim from then on. The lead's spawn is made by the
 * `start_lead` effect that event plans, and finds its claim held. The oldest Issue goes first and an urgent one before the rest, which
 * is the order the claim hands out its places in. Held back, and still `queued`: `drain` (for the repo or globally), a paused project, a
 * project not synced yet, an alert while its switch is off, and a full claim. Under the capacity lock like every admission.
 */
export async function admitIssues(sql: SQL, options: AdmitOptions): Promise<number> {
  return sql.begin(async (tx) => {
    await lockCapacity(tx)
    const queued: Waiting[] = await tx`
      SELECT id, repo, source, attempt FROM factory.issues
      WHERE state = 'queued' AND classified_at IS NOT NULL
      ORDER BY (class = 'urgent') DESC NULLS LAST, id LIMIT ${BATCH}`
    if (queued.length === 0) return 0
    const states = await loadQueueStates(tx)
    let admitted = 0
    for (const issue of queued) {
      if (issue.source === 'alert' && !options.alertLeads) continue
      if (effectiveState(states, issue.repo) === 'drain') continue
      const owner = await projectOfPath(tx, issue.repo)
      if (!owner) continue
      const [project]: { paused: boolean }[] = await tx`SELECT paused FROM factory.projects WHERE name = ${owner.name}`
      if (project?.paused) continue
      if ((await tryClaim(tx, issue.id, options.now)) !== 'held') continue
      await enqueue(tx, {
        issueId: issue.id,
        key: `admit:${issue.id}:${issue.attempt + 1}`,
        kind: 'admitted',
        at: options.now,
      })
      admitted++
    }
    return admitted
  })
}
