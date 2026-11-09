import type { SQL } from 'bun'
import * as z from 'zod'
import {
  FLOW_KINDS,
  FLOW_STATES,
  type FlowIssue,
  type FlowModel,
  type QueueReason as QueueReasonSchema,
  SIGNAL_ORIGINS,
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
  origin: z.enum(SIGNAL_ORIGINS),
  kind: z.string().nullable(),
  since: z.date(),
})

const Closed = z.object({
  id: z.string(),
  repo: z.string(),
  outcome: z.enum(['done', 'dropped', 'healed', 'cancelled']),
  title: z.string(),
  origin: z.enum(SIGNAL_ORIGINS),
  kind: z.string().nullable(),
  closed_at: z.date(),
})

const TrendState = z.object({ n: z.number().int(), state: z.enum(FLOW_STATES), count: z.number().int() })
const TrendShipped = z.object({ bucket: z.number().int(), count: z.number().int() })

const DAY_MS = 24 * 3_600_000

/** the settled kind, else the filed one, as `open-issues.ts` reads it; an absent or unknown kind reads as a chore */
const kindOf = (kind: string | null): FlowIssue['kind'] => FLOW_KINDS.find((known) => known === kind) ?? 'chore'

const QueueRow = z.object({ project: z.string(), state: z.enum(['run', 'pace', 'drain']) })

export const RECENT_MS = 24 * 3_600_000

/** The Issues by state, what closed in the last day, the 7-day trend, the counts per project and the queue state per scope. Read-only SQL. */
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
    SELECT i.id, i.repo, i.state, i.wait_reason, f.payload->>'title' AS title,
      f.payload->>'origin' AS origin,
      COALESCE((SELECT k.payload->>'kind' FROM factory.issue_events k WHERE k.issue_id = i.id AND k.kind = 'settled' AND k.result = 'applied' ORDER BY k.version DESC LIMIT 1), f.payload->>'kind') AS kind, COALESCE(s.at, f.at) AS since
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
    SELECT i.id, i.repo, i.outcome, f.payload->>'title' AS title, f.payload->>'origin' AS origin,
      COALESCE((SELECT k.payload->>'kind' FROM factory.issue_events k WHERE k.issue_id = i.id AND k.kind = 'settled' AND k.result = 'applied' ORDER BY k.version DESC LIMIT 1), f.payload->>'kind') AS kind, c.at AS closed_at
    FROM factory.issues i
    JOIN factory.issue_events f ON f.issue_id = i.id AND f.kind = 'filed' AND f.version = 1
    JOIN LATERAL (
      SELECT x.at FROM factory.issue_events x
      WHERE x.issue_id = i.id AND x.result = 'applied' AND x.to_state = 'closed'
      ORDER BY x.version DESC LIMIT 1
    ) c ON true
    WHERE i.state = 'closed' AND c.at >= ${new Date(now.getTime() - RECENT_MS)}
    ORDER BY c.at DESC, i.id DESC`
  const samples = Array.from({ length: 8 }, (_, i) => new Date(now.getTime() - (7 - i) * DAY_MS))
  const first = samples[0] ?? now
  const before = new Date(first.getTime() - 7 * DAY_MS)
  // the state of an Issue at T is the to_state of its latest applied event at or before T; sample n is now - (7 - n) days
  const trendStates: unknown[] = await sql`
    SELECT g.n, s.to_state AS state, count(*)::int AS count
    FROM generate_series(0, 7) g(n)
    CROSS JOIN factory.issues i
    CROSS JOIN LATERAL (
      SELECT x.to_state FROM factory.issue_events x
      WHERE x.issue_id = i.id AND x.result = 'applied' AND x.at <= ${now}::timestamptz - (7 - g.n) * interval '1 day'
      ORDER BY x.version DESC LIMIT 1
    ) s
    WHERE s.to_state IN ('settling', 'queued', 'working', 'waiting', 'watching')
    GROUP BY g.n, s.to_state`
  // daily windows (before, before + 1 d], ...: 0-6 the week before the samples, 7-13 the week they cover
  const trendShipped: unknown[] = await sql`
    SELECT (ceil(extract(epoch FROM c.at - ${before}::timestamptz) / 86400) - 1)::int AS bucket, count(*)::int AS count
    FROM factory.issues i
    JOIN LATERAL (
      SELECT x.at FROM factory.issue_events x
      WHERE x.issue_id = i.id AND x.result = 'applied' AND x.to_state = 'closed'
      ORDER BY x.version DESC LIMIT 1
    ) c ON true
    WHERE i.state = 'closed' AND i.outcome IN ('done', 'healed') AND c.at > ${before} AND c.at <= ${now}
    GROUP BY bucket`
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
      origin: row.origin,
      kind: kindOf(row.kind),
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

  const trend: FlowModel['trend'] = {
    at: samples.map((sample) => sample.toISOString()),
    states: {
      settling: Array<number>(8).fill(0),
      queued: Array<number>(8).fill(0),
      working: Array<number>(8).fill(0),
      waiting: Array<number>(8).fill(0),
      watching: Array<number>(8).fill(0),
    },
    shipped: Array<number>(7).fill(0),
    shippedBefore: 0,
  }
  for (const raw of trendStates) {
    const row = TrendState.parse(raw)
    trend.states[row.state][row.n] = row.count
  }
  for (const raw of trendShipped) {
    const row = TrendShipped.parse(raw)
    if (row.bucket < 7) trend.shippedBefore += row.count
    else trend.shipped[row.bucket - 7] = row.count
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
        origin: row.origin,
        kind: kindOf(row.kind),
        outcome: row.outcome,
        closedAt: row.closed_at.toISOString(),
      }
    }),
    perProject: [...perProject]
      .map(([repo, counts]) => ({ repo, ...counts }))
      .sort((a, b) => a.repo.localeCompare(b.repo)),
    trend,
    queueStates: {
      global: states.find((row) => row.project === '')?.state ?? 'run',
      // a work project's name is its words: under the read token its scope is not listed
      projects: Object.fromEntries(
        states.filter((row) => row.project !== '' && !hidden(row.project)).map((row) => [row.project, row.state]),
      ),
    },
  }
}
