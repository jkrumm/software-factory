import type { SQL } from 'bun'
import * as z from 'zod'
import { boundedRead } from './bounded.ts'

/**
 * What the usage schema (another component's, in this database) says an Issue's sessions used. A lead attempt's sessions
 * are the Claude sessions its hooks reported, with their subagents (`<session>:<agent>`); an Issue also has the sessions
 * the usage side tagged with its number. Everything is read from `usage.sessions` and `usage.records_unique`, the two
 * relations the `factory` role may read. Nothing is copied: a figure is joined at read, and one that cannot be read is
 * absent, never zero.
 */

export const USAGE_TIMEOUT_MS = 20_000

export interface UsageFigures {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  cost: number
  /** null when the window-share view could not be read, or was not asked for */
  windowPoints: number | null
  /** sessions that ran as a subagent of a lead session */
  subagents: number
  models: string[]
  /** usage sessions behind the figures */
  sessions: number
}

export interface UsageAttempt {
  /** the lead key `lead-<n>-<attempt>` */
  key: string
  /** every Claude session the attempt's hooks reported */
  claudeSessions: readonly string[]
}

export interface UsageIssue {
  number: number
  attempts: readonly UsageAttempt[]
}

export interface IssueUsage {
  /** by lead key; absent for an attempt none of whose sessions has a usage row yet */
  attempts: Map<string, UsageFigures>
  /** the attempts' sessions and the ones tagged with the Issue's number, each counted once; null when none has a row */
  total: UsageFigures | null
}

const Session = z.object({ id: z.coerce.string(), claude: z.string(), issue: z.string().nullable(), sub: z.boolean() })
const Sums = z.object({
  session: z.coerce.string(),
  input: z.coerce.number(),
  output: z.coerce.number(),
  cache_read: z.coerce.number(),
  cache_write: z.coerce.number(),
  cost: z.coerce.number(),
  models: z.array(z.string()),
})
const Points = z.object({ session: z.coerce.string(), points: z.coerce.number() })
const Present = z.object({ records: z.boolean(), shares: z.boolean() })

type SessionRow = z.infer<typeof Session>
type SessionSums = z.infer<typeof Sums>

function figuresOf(
  sessions: readonly SessionRow[],
  sums: ReadonlyMap<string, SessionSums>,
  points: ReadonlyMap<string, number> | null,
): UsageFigures | null {
  if (sessions.length === 0) return null
  const models = new Set<string>()
  const figures: UsageFigures = {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    windowPoints: points ? 0 : null,
    subagents: 0,
    models: [],
    sessions: sessions.length,
  }
  for (const session of sessions) {
    if (session.sub) figures.subagents += 1
    figures.windowPoints = points ? (figures.windowPoints ?? 0) + (points.get(session.id) ?? 0) : null
    const sum = sums.get(session.id)
    if (!sum) continue
    figures.tokens.input += sum.input
    figures.tokens.output += sum.output
    figures.tokens.cacheRead += sum.cache_read
    figures.tokens.cacheWrite += sum.cache_write
    figures.cost += sum.cost
    for (const model of sum.models) models.add(model)
  }
  figures.models = [...models].sort()
  return figures
}

/**
 * The figures of these Issues' sessions, or null when the usage schema cannot be read (not there, not granted, a statement
 * past `timeoutMs`): the caller then marks every figure partial. `points` also reads the window share, which is its own
 * bounded read, so a view that is slow or missing leaves only the points null.
 */
export async function loadUsage(
  sql: SQL,
  input: { issues: readonly UsageIssue[]; timeoutMs?: number; points?: boolean },
): Promise<Map<number, IssueUsage> | null> {
  const timeoutMs = input.timeoutMs ?? USAGE_TIMEOUT_MS
  const numbers = input.issues.map((issue) => String(issue.number))
  const claude = [...new Set(input.issues.flatMap((issue) => issue.attempts.flatMap((a) => a.claudeSessions)))]
  if (numbers.length === 0) return new Map()
  let found: { sessions: SessionRow[]; sums: Map<string, SessionSums>; shares: boolean } | null
  try {
    found = await boundedRead(sql, timeoutMs, async (tx) => {
      // inside the try: `to_regclass` raises "permission denied for schema usage" when the role has no USAGE on it
      const [row] = await tx`
        SELECT to_regclass('usage.sessions') IS NOT NULL AND to_regclass('usage.records_unique') IS NOT NULL AS records,
          to_regclass('usage.session_window_share') IS NOT NULL AS shares`
      const present = Present.parse(row)
      if (!present.records) return null
      // two lists, never an OR join: the Issue's tag has an index, the Claude session id is a prefix scan of a small table
      const tagged = Session.array().parse(
        await tx`SELECT s.id, split_part(s.source_session_id, ':', 1) AS claude, s.issue_id AS issue, position(':' in s.source_session_id) > 0 AS sub FROM usage.sessions s WHERE s.issue_id = ANY(${tx.array(numbers, 'TEXT')})`,
      )
      const reported =
        claude.length === 0
          ? []
          : Session.array().parse(
              await tx`
                SELECT s.id, split_part(s.source_session_id, ':', 1) AS claude, s.issue_id AS issue, position(':' in s.source_session_id) > 0 AS sub FROM usage.sessions s
                WHERE split_part(s.source_session_id, ':', 1) = ANY(${tx.array(claude, 'TEXT')})`,
            )
      const sessions = [...new Map([...tagged, ...reported].map((s) => [s.id, s])).values()]
      const sums = new Map<string, SessionSums>()
      if (sessions.length > 0) {
        const rows = Sums.array().parse(
          await tx`
            SELECT r.session_id AS session, sum(r.input_tokens)::float8 AS input, sum(r.output_tokens)::float8 AS output,
              sum(r.cache_read_tokens)::float8 AS cache_read,
              sum(r.cache_write_5m_tokens + r.cache_write_1h_tokens)::float8 AS cache_write,
              coalesce(sum(r.cost_usd), 0)::float8 AS cost,
              coalesce(array_agg(DISTINCT r.model) FILTER (WHERE r.model IS NOT NULL), '{}') AS models
            FROM usage.records_unique r
            WHERE r.session_id = ANY(${tx.array(
              sessions.map((s) => s.id),
              'BIGINT',
            )})
            GROUP BY r.session_id`,
        )
        for (const sum of rows) sums.set(sum.session, sum)
      }
      return { sessions, sums, shares: present.shares }
    })
  } catch {
    return null
  }
  if (!found) return null
  const { sessions, sums } = found

  let points: Map<string, number> | null = null
  if (input.points && found.shares && sessions.length > 0) {
    try {
      points = await boundedRead(sql, timeoutMs, async (tx) => {
        const rows = Points.array().parse(
          await tx`
            SELECT m.session_id AS session, sum(m.five_hour_pct)::float8 AS points FROM usage.session_window_share m
            WHERE m.session_id = ANY(${tx.array(
              sessions.map((s) => s.id),
              'BIGINT',
            )})
            GROUP BY m.session_id`,
        )
        return new Map(rows.map((r) => [r.session, r.points]))
      })
    } catch {
      points = null
    }
  }

  const byClaude = new Map<string, SessionRow[]>()
  for (const session of sessions) byClaude.set(session.claude, [...(byClaude.get(session.claude) ?? []), session])
  const result = new Map<number, IssueUsage>()
  for (const issue of input.issues) {
    const attempts = new Map<string, UsageFigures>()
    const own = new Map<string, SessionRow>()
    for (const attempt of issue.attempts) {
      const mine = [...new Set(attempt.claudeSessions)].flatMap((id) => byClaude.get(id) ?? [])
      const figures = figuresOf(mine, sums, points)
      if (figures) attempts.set(attempt.key, figures)
      for (const session of mine) own.set(session.id, session)
    }
    for (const session of sessions) if (session.issue === String(issue.number)) own.set(session.id, session)
    result.set(issue.number, { attempts, total: figuresOf([...own.values()], sums, points) })
  }
  return result
}

/** One slice of cost: what a kind of seat spent. */
export interface SeatCost {
  tool: string
  model: string
  effort: string
  cost: number
}

/**
 * Cost of these sessions' records by seat: the tool (lead, worker, reviewer, a subagent type), the model and the effort,
 * biggest first. Its own bounded read, so a column the usage side lacks leaves the seats empty and the cost standing.
 */
export async function costBySeat(
  sql: SQL,
  input: { sessions: ReadonlyArray<string | number | bigint>; timeoutMs: number },
): Promise<SeatCost[]> {
  if (input.sessions.length === 0) return []
  try {
    return await boundedRead(sql, input.timeoutMs, async (tx) =>
      z
        .object({ tool: z.string(), model: z.string(), effort: z.string(), cost: z.coerce.number() })
        .array()
        .parse(
          await tx`
            SELECT coalesce(r.tool, 'other') AS tool, coalesce(r.model, 'unknown') AS model, coalesce(r.effort, 'none') AS effort,
              sum(r.cost_usd)::float8 AS cost
            FROM usage.records_unique r
            WHERE r.session_id = ANY(${tx.array([...input.sessions], 'BIGINT')}) AND r.cost_usd IS NOT NULL
            GROUP BY 1, 2, 3 ORDER BY cost DESC`,
        ),
    )
  } catch {
    return []
  }
}
