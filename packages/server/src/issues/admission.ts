import type { SQL } from 'bun'
import { lockCapacity } from '../capacity.ts'
import { tryClaim } from '../projects/claims.ts'
import { effectiveState, loadQueueStates } from '../queue.ts'
import { enqueue } from './inbox.ts'

/** Most Issues one pass admits; the rest wait for the next. Ineligible ones are skipped, not counted, so they starve nobody. */
const BATCH = 20

export interface AdmitOptions {
  now: Date
  /**
   * `FACTORY_ALERT_LEADS`: whether an `alert` Issue gets a lead. On by default since Wave 4's evidence (decision 3); off, such an
   * Issue stays `queued`. A request is not asked.
   */
  alertLeads: boolean
}

interface Waiting {
  id: number
  repo: string
  attempt: number
}

/**
 * Admission for Issues: of the classified, `queued` Issues with no open dependency (a close deletes its dep rows, so a row means
 * open), each project's first and any urgent one (an incident, or the owner's `urgent` class) are looked at. First is the highest
 * `prio` (the value of the Issue's latest applied `prio` event, none = 0), then the oldest; a blocked Issue is not a candidate, so
 * it never holds back an unblocked one of its project. Urgent ones go first, then by the same order, and the claim hands out its
 * places in that order: the project's claim has room, the Issue holds it and gets `admitted` (key `admit:<issue>:<attempt>`, so a
 * second admission is the same row). The lead's spawn is made by the `start_lead` effect that event plans, and finds its claim held. The others of a project cannot be admitted before the first, so
 * they are not read. Held back, and still `queued`: `drain` (for the repo or globally), a paused project, a project not synced yet,
 * a full claim, an `alert` while its switch is off (left out of the reading, so it does not stand in front of a request behind
 * it), and a reopened Issue whose last attempt is not finalized: its lead closes before a new one is admitted. Under the capacity lock
 * like every admission.
 */
export async function admitIssues(sql: SQL, options: AdmitOptions): Promise<number> {
  return sql.begin(async (tx) => {
    await lockCapacity(tx)
    const queued: Waiting[] = await tx`
      WITH q AS (
        SELECT i.id, i.repo, i.attempt, p.name AS project, COALESCE(i.class = 'urgent' OR i.kind = 'incident', false) AS urgent,
          COALESCE((
            SELECT (e.payload->>'value')::int FROM factory.issue_events e
            WHERE e.issue_id = i.id AND e.kind = 'prio' ORDER BY e.at DESC, e.id DESC LIMIT 1), 0) AS prio
        FROM factory.issues i
        CROSS JOIN LATERAL (
          SELECT name, paused FROM factory.projects
          WHERE i.repo = repo OR starts_with(i.repo, repo || '/')
          ORDER BY length(repo) DESC LIMIT 1
        ) p
        WHERE i.state = 'queued' AND i.classified_at IS NOT NULL AND NOT p.paused
          AND (i.source <> 'alert' OR ${options.alertLeads})
          AND NOT EXISTS (SELECT 1 FROM factory.issue_deps d WHERE d.issue_id = i.id)
          AND NOT EXISTS (
            SELECT 1 FROM factory.issue_effects e
            WHERE e.issue_id = i.id AND e.kind = 'finalize' AND e.done_at IS NULL AND e.cancelled_at IS NULL)
      )
      SELECT id, repo, attempt FROM q
      WHERE urgent OR id = (SELECT o.id FROM q o WHERE o.project = q.project AND NOT o.urgent ORDER BY o.prio DESC, o.id LIMIT 1)
      ORDER BY urgent DESC, prio DESC, id`
    if (queued.length === 0) return 0
    const states = await loadQueueStates(tx)
    let admitted = 0
    for (const issue of queued) {
      if (admitted >= BATCH) break
      if (effectiveState(states, issue.repo) === 'drain') continue
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
