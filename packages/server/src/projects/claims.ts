import type { SQL } from 'bun'
import { lockCapacity } from '../capacity.ts'
import { dropEmptySession } from '../sessions.ts'

export const claimKey = (project: string): string => `repo:${project}`

/** The project a path is in: the row whose repo is the path or contains it (a worktree of a repo is in the repo's project). */
export async function projectOfPath(tx: SQL, path: string): Promise<{ name: string; leads: number } | undefined> {
  const [row]: { name: string; leads: number }[] = await tx`
    SELECT name, COALESCE((manifest->>'leads')::int, 1) AS leads
    FROM factory.projects
    WHERE repo = ${path} OR starts_with(${path}, repo || '/')
    ORDER BY length(repo) DESC LIMIT 1`
  return row
}

export type ClaimResult =
  /** the Issue holds the claim, now or already */
  | 'held'
  /** it waits behind the holders and the older queued Issues; an Issue that closed or has no project row yet waits too, and is dealt with by the tick */
  | 'queued'

/** Whether the Issue is closed, or gone: a spawn for it has nothing left to do. */
export async function issueIsClosed(tx: SQL, issueId: number): Promise<boolean> {
  const [issue]: { state: string }[] = await tx`SELECT state FROM factory.issues WHERE id = ${issueId}`
  return !issue || issue.state === 'closed'
}

/**
 * Takes the Issue's claim on its project if there is room, else queues the Issue for it. A project admits `leads` leads (the
 * manifest's, one by default) and one more for an urgent Issue (`class = 'urgent'` or `kind = 'incident'`): ordinary holders are at most `leads`, all holders
 * at most `leads + 1`, so an urgent holder never uses up an ordinary place. When a place frees, the oldest queued Issue goes
 * first (by Issue id: its age), urgent ones before the rest; only an Issue with a spawn still waiting counts as queued, so one
 * whose spawn failed holds nobody up. A repo whose project is not synced yet is queued without a row: the tick syncs a named
 * repo before it claims, and the spawn is looked at again in 30 s. Runs in the caller's transaction and writes only `claims`; the
 * callers hold the capacity lock, which makes the count of holders and the insert one step.
 */
export async function tryClaim(tx: SQL, issueId: number, now: Date): Promise<ClaimResult> {
  const [issue]: { id: number; repo: string; state: string; class: string | null; kind: string | null }[] = await tx`
    SELECT id, repo, state, class, kind FROM factory.issues WHERE id = ${issueId}`
  if (!issue || issue.state === 'closed') return 'queued'
  const project = await projectOfPath(tx, issue.repo)
  if (!project) return 'queued'

  const key = claimKey(project.name)
  // Classify never answers `urgent`, so an incident is what takes the extra place; the owner's `urgent` class does too.
  const urgent = issue.class === 'urgent' || issue.kind === 'incident'
  const rows: { issue_id: number; urgent: boolean; held: boolean; pending: boolean }[] = await tx`
    SELECT c.issue_id, c.urgent, c.held_at IS NOT NULL AS held,
      EXISTS (SELECT 1 FROM factory.spawns s WHERE s.issue_id = c.issue_id AND s.status IN ('queued', 'waiting', 'starting')) AS pending
    FROM factory.claims c WHERE c.key = ${key}`
  const mine = rows.find((r) => r.issue_id === issueId)
  if (mine?.held) return 'held'

  const holders = rows.filter((r) => r.held)
  const ordinary = holders.filter((r) => !r.urgent).length
  const queued = rows.filter((r) => !r.held && r.pending && r.issue_id !== issueId)
  const room = project.leads + 1 - holders.length
  const places = urgent ? room : Math.min(project.leads - ordinary, room)
  const ahead = queued.filter((r) =>
    urgent ? r.urgent && r.issue_id < issueId : r.urgent || r.issue_id < issueId,
  ).length

  const admitted = places > ahead
  await tx`
    INSERT INTO factory.claims (key, issue_id, urgent, queued_at, held_at)
    VALUES (${key}, ${issueId}, ${urgent}, ${now}, ${admitted ? now : null})
    ON CONFLICT (key, issue_id) DO UPDATE SET urgent = EXCLUDED.urgent, held_at = EXCLUDED.held_at`
  return admitted ? 'held' : 'queued'
}

/** Gives the Issue's claims back (held or queued) and says which: finalize calls this from every exit path. */
export async function releaseClaim(tx: SQL, issueId: number): Promise<string[]> {
  const rows: { key: string }[] = await tx`DELETE FROM factory.claims WHERE issue_id = ${issueId} RETURNING key`
  return rows.map((row) => row.key)
}

const IDLE = `c.held_at IS NOT NULL
  AND EXISTS (SELECT 1 FROM factory.spawns s WHERE s.issue_id = c.issue_id AND s.status = 'failed')
  AND NOT EXISTS (SELECT 1 FROM factory.spawns s WHERE s.issue_id = c.issue_id AND s.status <> 'failed')`

/**
 * A held claim of an Issue whose every spawn failed: no lead ran, and the spawn goes back to the end of the line if it is requeued.
 * Called under the capacity lock, before a requeue and by the sweep.
 */
export async function releaseIdleClaim(tx: SQL, issueId: number): Promise<void> {
  await tx.unsafe(`DELETE FROM factory.claims c WHERE c.issue_id = $1 AND ${IDLE}`, [issueId])
}

/**
 * The tick's sweep, under the capacity lock like every admission: the held claims of Issues whose every spawn failed (`IDLE`), and the
 * spawns still queued or waiting for an Issue that closed, which fail: a lead for it would work on nothing. A closed Issue's claim is
 * finalize's. Returns what it released or failed.
 */
export async function releaseClosed(sql: SQL): Promise<{ released: number; failed: string[] }> {
  return sql.begin(async (tx) => {
    await lockCapacity(tx)
    const failed: { key: string }[] = await tx`
      UPDATE factory.spawns s
      SET status = 'failed', claimed_at = NULL, error = 'Issue ' || s.issue_id || ' closed before the spawn started'
      FROM factory.issues i
      WHERE i.id = s.issue_id AND i.state = 'closed' AND s.status IN ('queued', 'waiting')
      RETURNING s.key`
    // A retry that had opened its session row leaves none behind: a row with no pane would hold the repo's `pace` or `wave`.
    for (const { key } of failed) await dropEmptySession(tx, key)
    const released = await tx.unsafe(
      `DELETE FROM factory.claims c USING factory.issues i
       WHERE i.id = c.issue_id AND i.state <> 'closed' AND ${IDLE}
       RETURNING c.issue_id`,
    )
    return { released: released.length, failed: failed.map((f) => f.key) }
  })
}
