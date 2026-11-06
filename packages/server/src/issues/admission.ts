import type { SQL } from 'bun'
import { lockCapacity } from '../capacity.ts'
import { projectOfPath, releaseDecisionClaims, tryClaim, wakeClaimWaiters } from '../projects/claims.ts'
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
 * like every admission. **Stop the line:** while a project has an episode Issue (a `down` of the intake) `queued` or `working`, its
 * only candidates besides urgent ones are such fixes, and a fix goes first; a `waiting`, `watching` or `blocked` episode Issue stops nothing.
 */
export async function admitIssues(sql: SQL, options: AdmitOptions): Promise<number> {
  return sql.begin(async (tx) => {
    await lockCapacity(tx)
    const queued: Waiting[] = await tx`
      WITH q AS (
        SELECT i.id, i.repo, i.attempt, p.name AS project, COALESCE(i.class = 'urgent' OR i.kind = 'incident', false) AS urgent,
          EXISTS (
            SELECT 1 FROM factory.door_issues d JOIN factory.issues x ON x.id = d.issue_id
            WHERE x.state IN ('queued', 'working') AND x.facts->>'status' = 'down'
              -- only a fix this very reading can admit stops the line: an alert with its switch off, a blocked one or one still finalizing cannot
              AND (x.source <> 'alert' OR ${options.alertLeads})
              AND NOT EXISTS (SELECT 1 FROM factory.issue_deps xd WHERE xd.issue_id = x.id)
              AND NOT EXISTS (
                SELECT 1 FROM factory.issue_effects xe
                WHERE xe.issue_id = x.id AND xe.kind = 'finalize' AND xe.done_at IS NULL AND xe.cancelled_at IS NULL)
              AND (SELECT xp.name FROM factory.projects xp WHERE x.repo = xp.repo OR starts_with(x.repo, xp.repo || '/')
                   ORDER BY length(xp.repo) DESC LIMIT 1) = p.name) AS stopped,
          (i.facts->>'status' = 'down' AND EXISTS (SELECT 1 FROM factory.door_issues d WHERE d.issue_id = i.id)) AS fix,
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
      WHERE urgent OR id = (
        SELECT o.id FROM q o WHERE o.project = q.project AND NOT o.urgent AND (o.fix OR NOT o.stopped)
        ORDER BY o.prio DESC, o.id LIMIT 1)
      ORDER BY (stopped AND fix) DESC, urgent DESC, prio DESC, id`
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

/**
 * Claims for Issues that wait on the owner, once per tick before admission (under the capacity lock like every admission): an Issue in a
 * decision wait gives its repo's claim back, so the next Issue of the project can run while the owner may take hours; an Issue
 * whose question was answered (`waiting`, reason `claim`) takes a place again through `tryClaim`, in the same order as admission (urgent
 * first, then by id) and behind a holder that works, so a project never has more working leads than its `leads`. Having the place, it gets
 * a `wake` (key `wake:<issue>:claim:<question key>`) that moves it to `working` and types the answer to its lead, with the order to rebase.
 * The lead's worktree is never touched here. Idempotent: it is also what releases a claim an Issue held when it asked.
 */
export async function settleClaims(sql: SQL, now: Date): Promise<{ released: number; resumed: number }> {
  return sql.begin(async (tx) => {
    await lockCapacity(tx)
    const keys = await releaseDecisionClaims(tx)
    await wakeClaimWaiters(tx, keys, now)
    const waiting: { id: number; repo: string }[] = await tx`
      SELECT id, repo FROM factory.issues WHERE state = 'waiting' AND reason = 'claim'
      ORDER BY (class = 'urgent' OR kind = 'incident') DESC, id LIMIT ${BATCH}`
    let resumed = 0
    for (const { id, repo } of waiting) {
      // A repo that has no project row any more has no claim to wait for: an Issue that was admitted once is not held back by that.
      if ((await projectOfPath(tx, repo)) && (await tryClaim(tx, id, now)) !== 'held') continue
      const [answer]: { payload: Record<string, unknown> | null }[] = await tx`
        SELECT payload FROM factory.issue_inbox
        WHERE issue_id = ${id} AND kind = 'answer' AND result = 'applied' ORDER BY id DESC LIMIT 1`
      // The wake is keyed by the question it ends (its key is the ask's own), so a replay of the run files the same one.
      const [question]: { key: string }[] = await tx`
        SELECT key FROM factory.decisions WHERE issue_id = ${id} AND answered_at IS NOT NULL ORDER BY id DESC LIMIT 1`
      const carried = Object.fromEntries(
        ['answer', 'who', 'text'].flatMap((name) => {
          const value = answer?.payload?.[name]
          return typeof value === 'string' ? [[name, value]] : []
        }),
      )
      await enqueue(tx, {
        issueId: id,
        key: `wake:${id}:claim:${question?.key ?? 'none'}`,
        kind: 'wake',
        at: now,
        payload: { for: 'claim', ...carried },
      })
      resumed++
    }
    return { released: keys.length, resumed }
  })
}
