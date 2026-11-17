import type { SQL } from 'bun'
import * as z from 'zod'
import { EFFORTS, type AttemptSeatRow, type InferredEdgeKpis, TIERS } from '@software-factory/contract'
import { boundedRead } from './bounded.ts'
import { per } from './stats.ts'
import { USAGE_TIMEOUT_MS } from './usage.ts'

interface Window {
  from: Date
  to: Date
}

const Attempt = z.object({
  issue_id: z.string(),
  attempt: z.coerce.number().int(),
  tier: z.enum(TIERS),
  effort: z.enum(EFFORTS),
  first_watch: z.enum(['passed', 'regressed']).nullable(),
})
type Attempt = z.infer<typeof Attempt>

const Claude = z.object({ issue_id: z.string(), attempt: z.coerce.number().int(), claude: z.string() })
const Session = z.object({ id: z.union([z.string(), z.number(), z.bigint()]), claude: z.string() })
const Spend = z.object({ id: z.coerce.string(), cost: z.coerce.number() })

const keyOf = (issue: string, attempt: number): string => `${issue}#${attempt}`

/** The attempts that started in the window with a stored seat, each with what its ship's first watch answered. */
async function attemptsOf(sql: SQL, w: Window): Promise<Attempt[]> {
  const rows: unknown[] = await sql`
    SELECT a.issue_id, a.attempt, a.tier, a.effort,
      (SELECT q.answer FROM factory.quality_watches q
        WHERE q.issue_id = a.issue_id AND q.attempt = a.attempt AND q.watch = 1
          AND q.answer IN ('passed', 'regressed')) AS first_watch
    FROM factory.lead_attempts a
    WHERE a.started_at >= ${w.from} AND a.started_at < ${w.to} AND a.tier IS NOT NULL AND a.effort IS NOT NULL`
  return rows.map((row) => Attempt.parse(row))
}

/**
 * Dollars per attempt, by the Claude sessions its hooks reported (with their subagents, `<session>:<agent>`), priced from
 * the `usage` schema another component owns in this database. A session usage tagged with an Issue's number but no hook
 * ever reported belongs to no attempt and is not counted here. Null (never zero) when the schema cannot be read, the role
 * may not read it or a statement ran past the timeout.
 */
async function costOfAttempts(
  sql: SQL,
  attempts: readonly Attempt[],
  timeoutMs: number,
): Promise<Map<string, number> | null> {
  if (attempts.length === 0) return new Map()
  const wanted = new Set(attempts.map((a) => keyOf(a.issue_id, a.attempt)))
  try {
    return await boundedRead(sql, timeoutMs, async (tx) => {
      const [row] =
        await tx`SELECT to_regclass('usage.sessions') IS NOT NULL AND to_regclass('usage.records_unique') IS NOT NULL AS present`
      if (!z.object({ present: z.boolean() }).parse(row).present) return null
      const issues = [...new Set(attempts.map((a) => a.issue_id))]
      const reported = z.array(Claude).parse(
        await tx`
          SELECT DISTINCT issue_id, attempt, payload->>'claudeSessionId' AS claude FROM factory.lead_hook_events
          WHERE issue_id = ANY(${tx.array(issues, 'TEXT')}) AND payload->>'claudeSessionId' IS NOT NULL`,
      )
      const attemptOf = new Map<string, string>()
      for (const r of reported) {
        const key = keyOf(r.issue_id, r.attempt)
        if (wanted.has(key) && !attemptOf.has(r.claude)) attemptOf.set(r.claude, key)
      }
      const cost = new Map<string, number>([...wanted].map((key) => [key, 0]))
      if (attemptOf.size === 0) return cost
      const sessions = z.array(Session).parse(
        await tx`
          SELECT s.id, split_part(s.source_session_id, ':', 1) AS claude FROM usage.sessions s
          WHERE split_part(s.source_session_id, ':', 1) = ANY(${tx.array([...attemptOf.keys()], 'TEXT')})`,
      )
      if (sessions.length === 0) return cost
      const owner = new Map(sessions.map((s) => [String(s.id), attemptOf.get(s.claude)]))
      const spend = z.array(Spend).parse(
        await tx`
          SELECT r.session_id AS id, sum(r.cost_usd)::float8 AS cost FROM usage.records_unique r
          WHERE r.session_id = ANY(${tx.array(
            sessions.map((s) => s.id),
            'BIGINT',
          )})
          GROUP BY r.session_id`,
      )
      for (const s of spend) {
        const key = owner.get(s.id)
        if (key !== undefined) cost.set(key, (cost.get(key) ?? 0) + s.cost)
      }
      return cost
    })
  } catch {
    return null
  }
}

/**
 * The window's attempts by the seat each started on: how many, for how many Issues, how often the ship of each passed its
 * first verification, and what the sessions of those attempts cost per Issue.
 */
export async function readAttemptSeats(
  sql: SQL,
  w: Window,
  options: { timeoutMs?: number } = {},
): Promise<AttemptSeatRow[]> {
  const attempts = await attemptsOf(sql, w)
  const cost = await costOfAttempts(sql, attempts, options.timeoutMs ?? USAGE_TIMEOUT_MS)
  const bySeat = new Map<string, Attempt[]>()
  for (const a of attempts) {
    const key = `${a.tier}/${a.effort}`
    bySeat.set(key, [...(bySeat.get(key) ?? []), a])
  }
  const rows = [...bySeat.values()].map((group): AttemptSeatRow => {
    const first = group[0] as Attempt
    const issues = new Set(group.map((a) => a.issue_id)).size
    const outcomes = group.flatMap((a) => (a.first_watch === null ? [] : [a.first_watch]))
    const spent =
      cost === null ? null : group.reduce((sum, a) => sum + (cost.get(keyOf(a.issue_id, a.attempt)) ?? 0), 0)
    return {
      tier: first.tier,
      effort: first.effort,
      attempts: group.length,
      issues,
      firstWatches: outcomes.length,
      firstPassRate: per(outcomes.filter((o) => o === 'passed').length, outcomes.length),
      cost: spent,
      costPerIssue: spent === null ? null : per(spent, issues),
    }
  })
  return rows.sort((a, b) => b.attempts - a.attempts || `${a.tier}${a.effort}`.localeCompare(`${b.tier}${b.effort}`))
}

const Edges = z.object({
  total: z.coerce.number().int(),
  open: z.coerce.number().int(),
  needed: z.coerce.number().int(),
  not_needed: z.coerce.number().int(),
  idle_hours: z.coerce.number(),
})

/** The inferred `after` edges created in the window, by whether holding the Issue back was needed (`ready_since`). */
export async function readInferredEdges(sql: SQL, w: Window): Promise<InferredEdgeKpis> {
  const [row] = await sql`
    SELECT count(*) AS total,
      count(*) FILTER (WHERE satisfied_at IS NULL) AS open,
      count(*) FILTER (WHERE satisfied_at IS NOT NULL AND ready_since IS NULL) AS needed,
      count(*) FILTER (WHERE satisfied_at IS NOT NULL AND ready_since IS NOT NULL) AS not_needed,
      coalesce(sum(extract(epoch FROM satisfied_at - ready_since)) FILTER (
        WHERE satisfied_at IS NOT NULL AND ready_since IS NOT NULL), 0) / 3600 AS idle_hours
    FROM factory.planning_edges
    WHERE inferred_by IS NOT NULL AND created_at >= ${w.from} AND created_at < ${w.to}`
  const e = Edges.parse(row)
  return {
    total: e.total,
    open: e.open,
    needed: e.needed,
    notNeeded: e.not_needed,
    neededShare: per(e.needed, e.needed + e.not_needed),
    idleHours: e.idle_hours,
  }
}
