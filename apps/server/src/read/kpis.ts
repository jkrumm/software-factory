import type { SQL } from 'bun'
import * as z from 'zod'
import type { Kpi, KpiModel } from '@software-factory/contract'
import { percentile, per, windowOf } from './stats.ts'

/** The owner's actions on an Issue that the factory should have settled; the events that count are these kinds. */
export const TOUCH_EVENTS = ['noted', 'woken', 'cancelled', 'reopened'] as const

const Count = z.object({ n: z.coerce.number().int() })
const Duration = z.object({ ms: z.coerce.number() })
const Cost = z.object({ cost: z.coerce.number(), points: z.coerce.number().nullable() })

export interface Window {
  from: Date
  to: Date
}

const one = async (rows: Promise<unknown[]>): Promise<number> => Count.parse((await rows)[0]).n

/** Issues filed in the window: what every per-Issue figure divides by. */
export const issuesFiled = (sql: SQL, w: Window): Promise<number> =>
  one(
    sql`SELECT count(*) AS n FROM factory.issue_events WHERE kind = 'filed' AND result = 'applied' AND at >= ${w.from} AND at < ${w.to}`,
  )

/**
 * Avoidable touches by kind: an owner action on an Issue the factory should have settled. A Decision the owner answered and
 * did not mark worth asking, an owner note, an owner wake, a cancel, a reopen. Not a verdict on a Concept or Spec and not
 * an Errand done: the owner wanted those.
 */
export async function avoidableTouches(sql: SQL, w: Window): Promise<Record<string, number>> {
  const counts: Record<string, number> = {
    decision_answered: await one(sql`
      SELECT count(*) AS n FROM factory.decisions
      WHERE settled_by = 'owner' AND worth_asking IS NOT TRUE AND answered_at >= ${w.from} AND answered_at < ${w.to}`),
  }
  for (const kind of TOUCH_EVENTS) counts[kind] = 0
  const events: unknown[] = await sql`
    SELECT kind, count(*) AS n FROM factory.issue_events
    WHERE actor = 'owner' AND result = 'applied' AND kind IN ${sql([...TOUCH_EVENTS])} AND at >= ${w.from} AND at < ${w.to}
    GROUP BY kind`
  for (const raw of events) {
    const row = z.object({ kind: z.string() }).and(Count).parse(raw)
    counts[row.kind] = row.n
  }
  return counts
}

/** Refusals in the window: Issue events the machine refused, and ships the gate refused. */
export async function refusalCount(sql: SQL, w: Window): Promise<number> {
  const events = await one(sql`
    SELECT count(*) AS n FROM factory.issue_events WHERE result = 'refused' AND at >= ${w.from} AND at < ${w.to}`)
  const ships = await one(sql`
    SELECT count(*) AS n FROM factory.quality_ships WHERE result = 'refused' AND at >= ${w.from} AND at < ${w.to}`)
  return events + ships
}

const durations = async (rows: Promise<unknown[]>): Promise<number[]> =>
  (await rows).map((raw) => Duration.parse(raw).ms)

/** Filed to closed, for each Issue that closed in the window. */
const cycleTimes = (sql: SQL, w: Window) =>
  durations(sql`
    SELECT extract(epoch FROM (c.at - f.at)) * 1000 AS ms
    FROM factory.issue_events c
    JOIN factory.issue_events f ON f.issue_id = c.issue_id AND f.kind = 'filed' AND f.version = 1
    WHERE c.result = 'applied' AND c.to_state = 'closed' AND c.at >= ${w.from} AND c.at < ${w.to}`)

/** Filed or reopened to admitted, for each admission in the window. */
const queueWaits = (sql: SQL, w: Window) =>
  durations(sql`
    SELECT extract(epoch FROM (a.at - s.at)) * 1000 AS ms
    FROM factory.issue_events a
    JOIN LATERAL (
      SELECT x.at FROM factory.issue_events x
      WHERE x.issue_id = a.issue_id AND x.result = 'applied' AND x.kind IN ('filed', 'reopened') AND x.version < a.version
      ORDER BY x.version DESC LIMIT 1
    ) s ON true
    WHERE a.kind = 'admitted' AND a.result = 'applied' AND a.at >= ${w.from} AND a.at < ${w.to}`)

/**
 * Cost and window points of the Issues filed in the window, joined from the `usage` schema, which another component owns
 * in this database. A session is an Issue's when usage tagged it with the Issue's number, or when it is (or is a subagent
 * of) a Claude session a lead of the Issue reported in its hook events (`claudeSessionId`). The five-hour window's
 * points come from `usage.session_window_share`. Null when the schema, a table or a column is not there.
 */
async function usageOf(sql: SQL, w: Window): Promise<{ cost: number | null; points: number | null }> {
  const [found] = await sql`
    SELECT to_regclass('usage.sessions') IS NOT NULL AND to_regclass('usage.records_unique') IS NOT NULL AS records,
      to_regclass('usage.session_window_share') IS NOT NULL AS shares`
  const present = z.object({ records: z.boolean(), shares: z.boolean() }).parse(found)
  if (!present.records) return { cost: null, points: null }
  try {
    const sessions = sql`
      SELECT DISTINCT s.id AS session_id
      FROM factory.issues i
      JOIN usage.sessions s ON s.issue_id = substr(i.id, 7)
        OR split_part(s.source_session_id, ':', 1) IN (
          SELECT e.payload->>'claudeSessionId' FROM factory.lead_hook_events e
          WHERE e.issue_id = i.id AND e.payload->>'claudeSessionId' IS NOT NULL)
      WHERE i.id IN (
        SELECT issue_id FROM factory.issue_events WHERE kind = 'filed' AND result = 'applied' AND at >= ${w.from} AND at < ${w.to})`
    const cost = Cost.parse(
      (
        await sql`
          WITH mine AS (${sessions})
          SELECT (SELECT coalesce(sum(r.cost_usd), 0)::float8 FROM usage.records_unique r WHERE r.session_id IN (SELECT session_id FROM mine)) AS cost,
            ${
              present.shares
                ? sql`(SELECT coalesce(sum(m.five_hour_pct), 0)::float8 FROM usage.session_window_share m WHERE m.session_id IN (SELECT session_id FROM mine))`
                : sql`NULL::float8`
            } AS points`
      )[0],
    )
    return { cost: cost.cost, points: present.shares ? cost.points : null }
  } catch {
    return { cost: null, points: null }
  }
}

const NONE = { kind: 'unset', min: null, max: null } as const

const kpi = (k: Omit<Kpi, 'target'> & { target?: Kpi['target'] }): Kpi => ({ ...k, target: k.target ?? NONE })

/** The table in `docs/product.md`, computed over the last `days` days from the event log and the checkpoint tables. */
export async function readKpis(sql: SQL, options: { now: Date; days: number }): Promise<KpiModel> {
  const w = windowOf(options.now, options.days)
  const issues = await issuesFiled(sql, w)

  const touches = await avoidableTouches(sql, w)
  const touchCount = Object.values(touches).reduce((a, b) => a + b, 0)

  const asked = await one(sql`
    SELECT count(*) AS n FROM factory.decisions
    WHERE asked_at >= ${w.from} AND asked_at < ${w.to}
      AND (settled_by = 'owner' OR (answered_at IS NULL AND withdrawn_at IS NULL))`)
  const byOwner = await one(sql`
    SELECT count(*) AS n FROM factory.decisions WHERE settled_by = 'owner' AND answered_at >= ${w.from} AND answered_at < ${w.to}`)
  const worth = await one(sql`
    SELECT count(*) AS n FROM factory.decisions
    WHERE settled_by = 'owner' AND worth_asking IS TRUE AND answered_at >= ${w.from} AND answered_at < ${w.to}`)
  const firstWatches = await one(sql`
    SELECT count(*) AS n FROM factory.quality_watches WHERE watch = 1 AND answer IN ('passed', 'regressed') AND answered_at >= ${w.from} AND answered_at < ${w.to}`)
  const firstPassed = await one(sql`
    SELECT count(*) AS n FROM factory.quality_watches WHERE watch = 1 AND answer = 'passed' AND answered_at >= ${w.from} AND answered_at < ${w.to}`)
  const refusals = await refusalCount(sql, w)
  const cycles = await cycleTimes(sql, w)
  const waits = await queueWaits(sql, w)
  const usage = await usageOf(sql, w)

  const kpis: Kpi[] = [
    kpi({
      key: 'avoidable_touches',
      label: 'Avoidable touches per Issue',
      value: per(touchCount, issues),
      unit: 'per_issue',
      n: issues,
      count: touchCount,
      target: { kind: 'between', min: 0.05, max: 0.07 },
      measured: true,
      definition:
        'Owner actions in the window on an Issue the factory should have settled, divided by the Issues filed in the window: a Decision the owner answered and did not mark worth asking, an owner note, an owner wake, a cancel, a reopen. A verdict on a Concept or Spec and a done Errand are not counted, the owner wanted those.',
    }),
    kpi({
      key: 'asks',
      label: 'Asks per Issue',
      value: per(asked, issues),
      unit: 'per_issue',
      n: issues,
      count: asked,
      target: { kind: 'between', min: 0.05, max: 0.07 },
      measured: true,
      definition:
        'Decisions raised in the window that the factory did not settle itself (the owner answered them, or they still wait), divided by the Issues filed in the window.',
    }),
    kpi({
      key: 'worth_asking',
      label: 'Decisions the owner marks worth asking',
      value: per(worth, byOwner),
      unit: 'share',
      n: byOwner,
      count: worth,
      target: { kind: 'at_least', min: 0.8, max: null },
      measured: true,
      definition:
        'Of the Decisions the owner answered in the window, the share he flagged worth asking. The flag is his, so an unflagged answer counts against the share.',
    }),
    kpi({
      key: 'first_verification_passes',
      label: 'First verification passes',
      value: per(firstPassed, firstWatches),
      unit: 'share',
      n: firstWatches,
      count: firstPassed,
      target: { kind: 'at_least', min: 0.9, max: null },
      measured: true,
      definition:
        "Of the first watches (the window after an Issue's first ship) that ended in the window as passed or regressed, the share that passed. A watch that ended because its Issue moved on is not counted.",
    }),
    kpi({
      key: 'refusals',
      label: 'Refusals per Issue',
      value: per(refusals, issues),
      unit: 'per_issue',
      n: issues,
      count: refusals,
      target: { kind: 'at_most', min: null, max: 0.25 },
      measured: true,
      definition:
        'Issue events the state machine refused (result refused) plus ships the gate refused, in the window, divided by the Issues filed in the window.',
    }),
    kpi({
      key: 'cycle_p50',
      label: 'Cycle, median',
      value: percentile(cycles, 0.5),
      unit: 'ms',
      n: cycles.length,
      count: null,
      measured: true,
      definition: 'The median time from filed to closed of the Issues that closed in the window.',
    }),
    kpi({
      key: 'queue_wait_p50',
      label: 'Queue wait, median',
      value: percentile(waits, 0.5),
      unit: 'ms',
      n: waits.length,
      count: null,
      measured: true,
      definition:
        'The median time from filed or reopened to admitted (a lead started) of the admissions in the window; settling and the chain are part of the wait.',
    }),
    kpi({
      key: 'queue_wait_p90',
      label: 'Queue wait, 90th percentile',
      value: percentile(waits, 0.9),
      unit: 'ms',
      n: waits.length,
      count: null,
      measured: true,
      definition: 'The 90th percentile of the same queue waits.',
    }),
    kpi({
      key: 'fix_commits',
      label: 'Fix commits per week, by class',
      value: null,
      unit: 'per_issue',
      n: 0,
      count: null,
      target: { kind: 'trend', min: null, max: null },
      measured: false,
      definition: 'Not measured: the factory does not sort the commits that fix an earlier change yet.',
    }),
    kpi({
      key: 'window_points',
      label: 'Window points per Issue',
      value: usage.points === null ? null : per(usage.points, issues),
      unit: 'points',
      n: issues,
      count: null,
      target: { kind: 'trend', min: null, max: null },
      measured: usage.points !== null,
      definition:
        "Points of the five-hour Max window that the sessions of the Issues filed in the window used, from the usage schema's session_window_share, divided by those Issues. Null while the usage schema or that view is not there.",
    }),
    kpi({
      key: 'cost',
      label: 'Cost per Issue',
      value: usage.cost === null ? null : per(usage.cost, issues),
      unit: 'usd',
      n: issues,
      count: null,
      measured: usage.cost !== null,
      definition:
        "Dollars the usage schema priced for the sessions of the Issues filed in the window (a session tagged with the Issue's number, or a Claude session its lead reported, with its subagents), divided by those Issues. Joined at read, never copied. Null while the usage schema is not there.",
    }),
  ]
  return {
    at: options.now.toISOString(),
    days: options.days,
    window: { from: w.from.toISOString(), to: w.to.toISOString() },
    kpis,
  }
}
