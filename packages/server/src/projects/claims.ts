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
  /** nothing to claim: no such Issue, or it closed (callers refuse a spawn of a closed Issue before they ask) */
  | 'none'

/** Whether the Issue is closed, or gone: a spawn for it has nothing left to do. */
export async function issueIsClosed(tx: SQL, issueId: number): Promise<boolean> {
  const [issue]: { state: string }[] = await tx`SELECT state FROM factory.issues WHERE id = ${issueId}`
  return !issue || issue.state === 'closed'
}

/**
 * Takes the Issue's claim on its project if there is room, else queues the Issue for it. A project admits `leads` leads (the
 * manifest's, one by default) and one more for an urgent Issue (`class = 'urgent'`): ordinary holders are at most `leads`, all holders
 * at most `leads + 1`, so an urgent holder never uses up an ordinary place. When a place frees, the oldest queued Issue goes
 * first (by Issue id: its age), urgent ones before the rest; only an Issue with a spawn still waiting counts as queued, so one
 * whose spawn failed holds nobody up. A repo whose project is not synced yet is queued without a row: the tick syncs a named
 * repo before it claims, and the spawn is looked at again in 30 s. Runs in the caller's transaction and writes only `claims`; the
 * callers hold the capacity lock, which makes the count of holders and the insert one step.
 */
export async function tryClaim(tx: SQL, issueId: number, now: Date): Promise<ClaimResult> {
  const [issue]: { id: number; repo: string; state: string; class: string | null }[] = await tx`
    SELECT id, repo, state, class FROM factory.issues WHERE id = ${issueId}`
  if (!issue || issue.state === 'closed') return 'none'
  const project = await projectOfPath(tx, issue.repo)
  if (!project) return 'queued'

  const key = claimKey(project.name)
  const urgent = issue.class === 'urgent'
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

/**
 * Gives the Issue's claims back (held or queued). Finalize calls this from every exit path (Wave 4); until it does, `releaseClosed`
 * in the tick is what releases the claim of an Issue that closed.
 */
export async function releaseClaim(tx: SQL, issueId: number): Promise<void> {
  await tx`DELETE FROM factory.claims WHERE issue_id = ${issueId}`
}

/**
 * The claims of Issues that closed, and the held claims of Issues whose every spawn failed (no lead ever ran: `factory spawn
 * requeue` asks again and the claim is decided again). Wave 4's finalize releases the first itself and this part goes.
 */
export async function releaseClosed(sql: SQL): Promise<number> {
  const released = await sql`
    DELETE FROM factory.claims c USING factory.issues i
    WHERE i.id = c.issue_id AND (
      i.state = 'closed'
      OR (c.held_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM factory.spawns s WHERE s.issue_id = c.issue_id AND s.status = 'failed')
        AND NOT EXISTS (SELECT 1 FROM factory.spawns s WHERE s.issue_id = c.issue_id AND s.status <> 'failed')))
    RETURNING c.issue_id`
  return released.length
}
