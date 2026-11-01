import type { SQL } from 'bun'

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
  /** it waits behind the holders, and behind older queued Issues */
  | 'queued'
  /** nothing to claim: no such open Issue, or its repo has no project row yet (the tick syncs one before it claims) */
  | 'none'

/**
 * Takes the Issue's claim on its project if there is room, else queues the Issue for it. A project admits `leads` leads (the
 * manifest's, one by default) plus one urgent Issue (`class = 'urgent'`) beyond them. When a place frees, the oldest queued
 * Issue goes first, urgent ones before the rest; only an Issue with a spawn still waiting counts as queued, so one whose spawn
 * failed holds nobody up. Runs in the caller's transaction and writes only `claims`; the callers hold the capacity lock, which
 * makes the count of holders and the insert one step.
 */
export async function tryClaim(tx: SQL, issueId: number, now: Date): Promise<ClaimResult> {
  const [issue]: { id: number; repo: string; state: string; class: string | null }[] = await tx`
    SELECT id, repo, state, class FROM factory.issues WHERE id = ${issueId}`
  if (!issue || issue.state === 'closed') return 'none'
  const project = await projectOfPath(tx, issue.repo)
  if (!project) return 'none'

  const key = claimKey(project.name)
  const urgent = issue.class === 'urgent'
  const rows: { issue_id: number; urgent: boolean; held: boolean; pending: boolean }[] = await tx`
    SELECT c.issue_id, c.urgent, c.held_at IS NOT NULL AS held,
      EXISTS (SELECT 1 FROM factory.spawns s WHERE s.issue_id = c.issue_id AND s.status IN ('queued', 'waiting', 'starting')) AS pending
    FROM factory.claims c WHERE c.key = ${key}`
  const mine = rows.find((r) => r.issue_id === issueId)
  if (mine?.held) return 'held'

  const holders = rows.filter((r) => r.held)
  const urgentHolders = holders.filter((r) => r.urgent).length
  const queued = rows.filter((r) => !r.held && r.pending && r.issue_id !== issueId)
  const places = (urgent && urgentHolders === 0 ? project.leads + 1 : project.leads) - holders.length
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

/**
 * Gives the Issue's claims back (held or queued). Finalize calls this from every exit path (Wave 4); until it does, `releaseClosed`
 * in the tick is what releases the claim of an Issue that closed.
 */
export async function releaseClaim(tx: SQL, issueId: number): Promise<void> {
  await tx`DELETE FROM factory.claims WHERE issue_id = ${issueId}`
}

/** The claims of Issues that closed. Wave 4's finalize releases them itself and this goes. */
export async function releaseClosed(sql: SQL): Promise<number> {
  const released = await sql`
    DELETE FROM factory.claims c USING factory.issues i
    WHERE i.id = c.issue_id AND i.state = 'closed'
    RETURNING c.issue_id`
  return released.length
}
