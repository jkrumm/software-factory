import type { SQL } from 'bun'
import * as z from 'zod'

/** A timed wait with other open Issues held behind it, for as long as it lasts. */
export interface LongWait {
  issue: string
  repo: string
  title: string
  origin: string | null
  /** when the wait began */
  since: Date
  /** when the clock wakes the Issue */
  until: string
  /** the open Issues that wait on it, directly or through other Issues */
  held: number
  /** each of them with the open Issues it waits on directly: the chain from the head, edge by edge */
  heldIssues: { issue: string; after: string[] }[]
}

const TimerRow = z.object({
  id: z.string(),
  repo: z.string(),
  title: z.string().nullable(),
  origin: z.string().nullable(),
  until: z.string(),
  began: z.date(),
})
const numberOf = (id: string): number => Number(id.replace(/\D/g, ''))
const byIssueNumber = (a: string, b: string): number => numberOf(a) - numberOf(b)

const EdgeRow = z.object({ issue_id: z.string(), after_issue: z.string() })
const WaitRow = z.object({ id: z.string(), after: z.array(z.string()) })

/**
 * The Issues in a timed wait of at least `thresholdMs` (from the moment it began to the time it ends) that other open Issues
 * wait on. A wait is harmless on a leaf and costs a day on a chain head, so a leaf is not listed. The entry is the wait
 * itself: it goes when the Issue resumes or closes. Dependents are read the way the chain reads them (unmet stored edges of
 * open Issues and the `after` of dependency waits) and counted through the whole chain. Read-only SQL.
 */
export async function readLongWaits(sql: SQL, thresholdMs: number): Promise<LongWait[]> {
  const timers: unknown[] = await sql`
    SELECT i.id, i.repo, f.payload->>'title' AS title, f.payload->>'origin' AS origin, e.wait->>'until' AS until, s.at AS began
    FROM factory.issues i
    JOIN factory.issue_events f ON f.issue_id = i.id AND f.kind = 'filed' AND f.version = 1
    JOIN LATERAL (
      SELECT x.wait FROM factory.issue_events x
      WHERE x.issue_id = i.id AND x.result = 'applied' ORDER BY x.version DESC LIMIT 1
    ) e ON true
    JOIN factory.issue_events s ON s.issue_id = i.id AND s.result = 'applied' AND s.version = (e.wait->>'since')::int
    WHERE i.state = 'waiting' AND i.wait_reason = 'timer'
    ORDER BY s.at, i.id`
  const long = timers
    .map((raw) => TimerRow.parse(raw))
    .filter((row) => Date.parse(row.until) - row.began.getTime() >= thresholdMs)
  if (long.length === 0) return []

  const stored: unknown[] = await sql`
    SELECT e.issue_id, e.after_issue
    FROM factory.planning_edges e JOIN factory.issues i ON i.id = e.issue_id AND i.state <> 'closed'
    WHERE e.satisfied_at IS NULL`
  const waits: unknown[] = await sql`
    SELECT i.id, e.wait->'after' AS after
    FROM factory.issues i
    JOIN LATERAL (
      SELECT x.wait FROM factory.issue_events x
      WHERE x.issue_id = i.id AND x.result = 'applied' ORDER BY x.version DESC LIMIT 1
    ) e ON true
    WHERE i.state = 'waiting' AND i.wait_reason = 'dependency'`

  // blocker -> the open Issues that wait directly on it; Issue -> what it waits on directly
  const dependents = new Map<string, Set<string>>()
  const blockers = new Map<string, Set<string>>()
  const link = (issue: string, after: string) => {
    dependents.set(after, (dependents.get(after) ?? new Set()).add(issue))
    blockers.set(issue, (blockers.get(issue) ?? new Set()).add(after))
  }
  for (const raw of stored) {
    const edge = EdgeRow.parse(raw)
    link(edge.issue_id, edge.after_issue)
  }
  for (const raw of waits) {
    const wait = WaitRow.parse(raw)
    for (const after of wait.after) link(wait.id, after)
  }

  const heldBehind = (head: string): Set<string> => {
    const seen = new Set<string>()
    const queue = [head]
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      for (const dependent of dependents.get(next) ?? []) {
        if (dependent === head || seen.has(dependent)) continue
        seen.add(dependent)
        queue.push(dependent)
      }
    }
    return seen
  }

  return long.flatMap((row) => {
    const held = heldBehind(row.id)
    return held.size === 0
      ? []
      : [
          {
            issue: row.id,
            repo: row.repo,
            title: row.title ?? row.id,
            origin: row.origin,
            since: row.began,
            until: new Date(row.until).toISOString(),
            held: held.size,
            heldIssues: [...held].sort(byIssueNumber).map((issue) => ({
              issue,
              after: [...(blockers.get(issue) ?? [])].sort(byIssueNumber),
            })),
          },
        ]
  })
}
