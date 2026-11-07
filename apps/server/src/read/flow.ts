import type { SQL } from 'bun'
import * as z from 'zod'
import {
  FLOW_STATES,
  type FlowIssue,
  type FlowModel,
  type QueueReason as QueueReasonSchema,
} from '@software-factory/contract'
import { plain } from './words.ts'
import { isWorkRepo, loadOpenProjects, REDACTED_REPO, REDACTED_TITLE } from './work.ts'

/** Why each queued Issue stays queued, by Issue id; the capacity use case knows (it reads the host), so the caller passes it. */
export type QueueReasons = ReadonlyMap<string, z.infer<typeof QueueReasonSchema>>

const Open = z.object({
  id: z.string(),
  repo: z.string(),
  state: z.enum(FLOW_STATES),
  wait_reason: z.string().nullable(),
  title: z.string(),
  since: z.date(),
})

const Closed = z.object({
  id: z.string(),
  repo: z.string(),
  outcome: z.enum(['done', 'dropped', 'healed', 'cancelled']),
  title: z.string(),
  closed_at: z.date(),
})

const QueueRow = z.object({ project: z.string(), state: z.enum(['run', 'pace', 'drain']) })

export const RECENT_MS = 24 * 3_600_000

/** The Issues by state, what closed in the last day, the counts per project and the queue state per scope. Read-only SQL. */
export async function readFlow(
  sql: SQL,
  options: { now: Date; queue?: QueueReasons; /** the read token: a work repo's words go */ redact?: boolean },
): Promise<FlowModel> {
  const { now } = options
  const openProjects = options.redact ? await loadOpenProjects(sql) : []
  const hidden = (repo: string): boolean => options.redact === true && isWorkRepo(repo, openProjects)
  const repoOf = (repo: string): string => (hidden(repo) ? REDACTED_REPO : repo)
  const titleOf = (repo: string, title: string): string => (hidden(repo) ? REDACTED_TITLE : plain(title, 120))
  const open: unknown[] = await sql`
    SELECT i.id, i.repo, i.state, i.wait_reason, f.payload->>'title' AS title, COALESCE(s.at, f.at) AS since
    FROM factory.issues i
    JOIN factory.issue_events f ON f.issue_id = i.id AND f.kind = 'filed' AND f.version = 1
    LEFT JOIN LATERAL (
      SELECT x.at FROM factory.issue_events x
      WHERE x.issue_id = i.id AND x.result = 'applied' AND x.to_state IS DISTINCT FROM x.from_state
      ORDER BY x.version DESC LIMIT 1
    ) s ON true
    WHERE i.state <> 'closed'
    ORDER BY since, i.id`
  const closed: unknown[] = await sql`
    SELECT i.id, i.repo, i.outcome, f.payload->>'title' AS title, c.at AS closed_at
    FROM factory.issues i
    JOIN factory.issue_events f ON f.issue_id = i.id AND f.kind = 'filed' AND f.version = 1
    JOIN LATERAL (
      SELECT x.at FROM factory.issue_events x
      WHERE x.issue_id = i.id AND x.result = 'applied' AND x.to_state = 'closed'
      ORDER BY x.version DESC LIMIT 1
    ) c ON true
    WHERE i.state = 'closed' AND c.at >= ${new Date(now.getTime() - RECENT_MS)}
    ORDER BY c.at DESC, i.id DESC`
  const scopes: unknown[] = await sql`SELECT project, state FROM factory.capacity_queue_states`

  const columns: FlowModel['states'] = {
    settling: { count: 0, issues: [] },
    queued: { count: 0, issues: [] },
    working: { count: 0, issues: [] },
    waiting: { count: 0, issues: [] },
    watching: { count: 0, issues: [] },
  }
  const perProject = new Map<string, { open: number; working: number; queued: number }>()
  for (const raw of open) {
    const row = Open.parse(raw)
    const issue: FlowIssue = {
      id: row.id,
      repo: repoOf(row.repo),
      title: titleOf(row.repo, row.title),
      since: row.since.toISOString(),
      waitReason: row.wait_reason,
      queue: row.state === 'queued' && !hidden(row.repo) ? (options.queue?.get(row.id) ?? null) : null,
    }
    const column = columns[row.state]
    column.count++
    column.issues.push(issue)
    const counts = perProject.get(repoOf(row.repo)) ?? { open: 0, working: 0, queued: 0 }
    counts.open++
    if (row.state === 'working') counts.working++
    if (row.state === 'queued') counts.queued++
    perProject.set(repoOf(row.repo), counts)
  }

  const states = scopes.map((raw) => QueueRow.parse(raw))
  return {
    at: now.toISOString(),
    states: columns,
    closedRecently: closed.map((raw) => {
      const row = Closed.parse(raw)
      return {
        id: row.id,
        repo: repoOf(row.repo),
        title: titleOf(row.repo, row.title),
        outcome: row.outcome,
        closedAt: row.closed_at.toISOString(),
      }
    }),
    perProject: [...perProject]
      .map(([repo, counts]) => ({ repo, ...counts }))
      .sort((a, b) => a.repo.localeCompare(b.repo)),
    queueStates: {
      global: states.find((row) => row.project === '')?.state ?? 'run',
      // a work project's name is its words: under the read token its scope is not listed
      projects: Object.fromEntries(
        states.filter((row) => row.project !== '' && !hidden(row.project)).map((row) => [row.project, row.state]),
      ),
    },
  }
}
