import type { SQL } from 'bun'
import * as z from 'zod'
import { HISTORY_WINDOWS, type Kpi, type KpiModel } from '@software-factory/contract'
import { boundedRead } from './bounded.ts'
import { percentile, per, windowOf } from './stats.ts'
import { flowKpis } from './kpis-flow.ts'

/** The owner's actions on an Issue that the factory should have settled; the events that count are these kinds. */
export const TOUCH_EVENTS = ['noted', 'woken', 'cancelled', 'reopened'] as const

/**
 * The owner events that count as touches, of the given kinds. The orchestrator has its own actor, so it is excluded by
 * construction. A `noted` event counts only when it is a note the owner sent with `issue note`
 * (`noted:issue_<n>:owner:<call>`). The `via` guard keeps an old orchestrator client that still sends the owner's token
 * (and `--via orchestrator`) out of the count; it can go once the orchestrator's token is in use everywhere.
 * The first note of a filing, an Errand done and a verdict note are the owner's request or answer, not a touch.
 * `avoidableTouches` and the touch evidence of `readFrictionEvidence` both use this, so they agree.
 */
export const ownerTouch = (sql: SQL, kinds: readonly string[]) => sql`
  actor = 'owner' AND result = 'applied' AND kind IN ${sql([...kinds])}
  AND (kind <> 'noted' OR (key ~ '^noted:issue_[0-9]+:owner:' AND payload->>'via' IS DISTINCT FROM 'orchestrator'))`

/**
 * The orchestrator's steering events, of the given kinds: its own actor, and the legacy rows from before it had a token
 * (the owner's actor with `via: orchestrator`, as `issue note` sent them), so history reads continuously. Reported beside
 * the owner's touches, never in them. A `noted` event counts only when sent by `issue note`
 * (`noted:issue_<n>:orchestrator:<call>`), not the first note of a filing.
 */
export const orchestratorSteer = (sql: SQL, kinds: readonly string[]) => sql`
  result = 'applied' AND kind IN ${sql([...kinds])} AND (
    (actor = 'orchestrator' AND (kind <> 'noted' OR key ~ '^noted:issue_[0-9]+:orchestrator:'))
    OR (actor = 'owner' AND payload->>'via' = 'orchestrator'
        AND (kind <> 'noted' OR key ~ '^noted:issue_[0-9]+:owner:'))
  )`

const Count = z.object({ n: z.coerce.number().int() })
const Duration = z.object({ ms: z.coerce.number() })

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

/** Owner touches of one kind this close together are one action: a person sending the same steer to a dozen Issues, or an owner script cancelling a re-planned batch. */
export const TOUCH_BURST_MS = 60_000

/**
 * Avoidable touches by kind: an owner action on an Issue the factory should have settled. A Decision the owner answered and
 * did not mark worth asking, an owner note sent to a lead, an owner wake, a cancel, a reopen. Not the first note of a
 * filing, not the orchestrator steering a lead, not a verdict on a Concept or Spec and not an Errand done: the owner
 * wanted those. Touches of one kind within `TOUCH_BURST_MS` of the one before count once (one action fanned across Issues).
 */
export async function avoidableTouches(sql: SQL, w: Window): Promise<Record<string, number>> {
  const counts: Record<string, number> = {
    decision_answered: await one(sql`
      SELECT count(*) AS n FROM factory.decisions
      WHERE settled_by = 'owner' AND worth_asking IS NOT TRUE AND answered_at >= ${w.from} AND answered_at < ${w.to}`),
  }
  for (const kind of TOUCH_EVENTS) counts[kind] = 0
  const events: unknown[] = await sql`
    WITH t AS (
      SELECT kind, at, lag(at) OVER (PARTITION BY kind ORDER BY at) AS prev FROM factory.issue_events
      WHERE ${ownerTouch(sql, TOUCH_EVENTS)} AND at >= ${w.from} AND at < ${w.to})
    SELECT kind, count(*) FILTER (WHERE prev IS NULL OR at - prev > ${TOUCH_BURST_MS / 1000}::int * interval '1 second') AS n
    FROM t GROUP BY kind`
  for (const raw of events) {
    const row = z.object({ kind: z.string() }).and(Count).parse(raw)
    counts[row.kind] = row.n
  }
  return counts
}

/**
 * The orchestrator's steering by kind (the touch kinds plus `decision_answered` for a Decision it answered and the owner
 * did not mark worth asking). Not part of `avoidableTouches`: the owner-touch figures read the owner alone.
 */
export async function orchestratorSteering(sql: SQL, w: Window): Promise<Record<string, number>> {
  const counts: Record<string, number> = {
    decision_answered: await one(sql`
      SELECT count(*) AS n FROM factory.decisions
      WHERE settled_by = 'orchestrator' AND worth_asking IS NOT TRUE AND answered_at >= ${w.from} AND answered_at < ${w.to}`),
  }
  for (const kind of TOUCH_EVENTS) counts[kind] = 0
  const events: unknown[] = await sql`
    SELECT kind, count(*) AS n FROM factory.issue_events
    WHERE ${orchestratorSteer(sql, TOUCH_EVENTS)} AND at >= ${w.from} AND at < ${w.to}
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

/** What one usage statement may take before the KPI degrades to unmeasured instead of holding a connection. */
const USAGE_TIMEOUT_MS = 20_000
/** `session_window_share` aggregates every quota interval whatever the filter, so a computed figure is reused this long. */
const POINTS_TTL_MS = 15 * 60_000

export interface PointsCache {
  get(key: string, now: Date): number | undefined
  set(key: string, points: number, now: Date): void
}

/** An in-memory cache of window points by session set; entries expire `POINTS_TTL_MS` after they were computed. */
export function pointsCache(): PointsCache {
  const entries = new Map<string, { points: number; at: number }>()
  return {
    get: (key, now) => {
      const hit = entries.get(key)
      if (hit && now.getTime() - hit.at < POINTS_TTL_MS && now.getTime() >= hit.at) return hit.points
      entries.delete(key)
      return undefined
    },
    set: (key, points, now) => void entries.set(key, { points, at: now.getTime() }),
  }
}

const sharedPoints = pointsCache()

const Ids = z.array(z.object({ id: z.union([z.string(), z.number(), z.bigint()]) }))
const Texts = z.array(z.object({ v: z.string() }))

/**
 * The usage sessions of the Issues filed in the window. A session is an Issue's when usage tagged it with the Issue's
 * number, or when it is (or is a subagent of) a Claude session a lead of the Issue reported in its hook events
 * (`claudeSessionId`). Both sides are looked up from lists, never joined row by row: an OR join with a correlated subselect
 * could use no index and ran past 100 s on the shared database.
 */
async function sessionsOf(tx: SQL, w: Window): Promise<Array<string | number | bigint>> {
  const filed = Texts.parse(
    await tx`
      SELECT DISTINCT issue_id AS v FROM factory.issue_events
      WHERE kind = 'filed' AND result = 'applied' AND at >= ${w.from} AND at < ${w.to}`,
  ).map((r) => r.v)
  if (filed.length === 0) return []
  const numbers = filed.map((id) => id.slice('issue_'.length))
  const claude = Texts.parse(
    await tx`
      SELECT DISTINCT payload->>'claudeSessionId' AS v FROM factory.lead_hook_events
      WHERE issue_id = ANY(${tx.array(filed, 'TEXT')}) AND payload->>'claudeSessionId' IS NOT NULL`,
  ).map((r) => r.v)
  const byNumber = Ids.parse(
    await tx`SELECT s.id FROM usage.sessions s WHERE s.issue_id = ANY(${tx.array(numbers, 'TEXT')})`,
  )
  const byClaude =
    claude.length === 0
      ? []
      : Ids.parse(
          await tx`
            SELECT s.id FROM usage.sessions s
            WHERE split_part(s.source_session_id, ':', 1) = ANY(${tx.array(claude, 'TEXT')})`,
        )
  const unique = new Map<string, string | number | bigint>()
  for (const row of [...byNumber, ...byClaude]) unique.set(String(row.id), row.id)
  return [...unique.values()]
}

/**
 * Cost and window points of the Issues filed in the window, joined from the `usage` schema, which another component owns
 * in this database. The five-hour window's points come from `usage.session_window_share`. Each figure is its own bounded
 * transaction: a statement past the timeout, a missing schema, table or column, or a role that may not read the schema
 * leaves that figure null (unmeasured) and holds no connection. The points are reused for a few minutes, because the view
 * costs seconds for any filter.
 */
async function usageOf(
  sql: SQL,
  w: Window,
  options: { now: Date; timeoutMs: number; cache: PointsCache },
): Promise<{ cost: number | null; points: number | null }> {
  let sessions: Array<string | number | bigint>
  let cost: number
  let shares: boolean
  try {
    const found = await boundedRead(sql, options.timeoutMs, async (tx) => {
      // inside the try: `to_regclass` raises "permission denied for schema usage" when the factory's role has no USAGE on it
      const [row] = await tx`
        SELECT to_regclass('usage.sessions') IS NOT NULL AND to_regclass('usage.records_unique') IS NOT NULL AS records,
          to_regclass('usage.session_window_share') IS NOT NULL AS shares`
      const present = z.object({ records: z.boolean(), shares: z.boolean() }).parse(row)
      if (!present.records) return null
      const ids = await sessionsOf(tx, w)
      if (ids.length === 0) return { ids, cost: 0, shares: present.shares }
      const [sum] = await tx`
        SELECT coalesce(sum(r.cost_usd), 0)::float8 AS cost FROM usage.records_unique r
        WHERE r.session_id = ANY(${tx.array(ids, 'BIGINT')})`
      return { ids, cost: z.object({ cost: z.coerce.number() }).parse(sum).cost, shares: present.shares }
    })
    if (!found) return { cost: null, points: null }
    ;({ ids: sessions, cost, shares } = found)
  } catch {
    return { cost: null, points: null }
  }
  if (!shares) return { cost, points: null }
  if (sessions.length === 0) return { cost, points: 0 }

  const key = String(Bun.hash(sessions.map(String).sort().join(',')))
  const cached = options.cache.get(key, options.now)
  if (cached !== undefined) return { cost, points: cached }
  try {
    const points = await boundedRead(sql, options.timeoutMs, async (tx) => {
      const [sum] = await tx`
        SELECT coalesce(sum(m.five_hour_pct), 0)::float8 AS points FROM usage.session_window_share m
        WHERE m.session_id = ANY(${tx.array(sessions, 'BIGINT')})`
      return z.object({ points: z.coerce.number() }).parse(sum).points
    })
    options.cache.set(key, points, options.now)
    return { cost, points }
  } catch {
    return { cost, points: null }
  }
}

const NONE = { kind: 'unset', min: null, max: null } as const

const kpi = (
  k: Omit<Kpi, 'target' | 'history' | 'parts'> & { target?: Kpi['target']; parts?: Kpi['parts'] },
): Omit<Kpi, 'history'> => ({
  ...k,
  target: k.target ?? NONE,
  parts: k.parts ?? [],
})

type KpiOptions = { now: Date; usageTimeoutMs?: number; pointsCache?: PointsCache }

/** The KPIs of one window. Without `usage`, cost and window points are left unmeasured and the usage schema is not read. */
async function kpisOf(
  sql: SQL,
  w: Window,
  options: KpiOptions,
  { usage: withUsage }: { usage: boolean },
): Promise<Array<Omit<Kpi, 'history'>>> {
  const issues = await issuesFiled(sql, w)

  const touches = await avoidableTouches(sql, w)
  const touchCount = Object.values(touches).reduce((a, b) => a + b, 0)

  const asked = await one(sql`
    SELECT count(*) AS n FROM factory.decisions
    WHERE asked_at >= ${w.from} AND asked_at < ${w.to}
      AND (settled_by IN ('owner', 'orchestrator') OR (answered_at IS NULL AND withdrawn_at IS NULL))`)
  const byOwner = await one(sql`
    SELECT count(*) AS n FROM factory.decisions WHERE settled_by = 'owner' AND answered_at >= ${w.from} AND answered_at < ${w.to}`)
  const worth = await one(sql`
    SELECT count(*) AS n FROM factory.decisions
    WHERE settled_by = 'owner' AND worth_asking IS TRUE AND answered_at >= ${w.from} AND answered_at < ${w.to}`)
  const specs = await one(sql`
    SELECT count(*) AS n FROM factory.artifacts WHERE kind = 'spec' AND created_at >= ${w.from} AND created_at < ${w.to}`)
  const firstWatches = await one(sql`
    SELECT count(*) AS n FROM factory.quality_watches WHERE watch = 1 AND answer IN ('passed', 'regressed') AND answered_at >= ${w.from} AND answered_at < ${w.to}`)
  const firstPassed = await one(sql`
    SELECT count(*) AS n FROM factory.quality_watches WHERE watch = 1 AND answer = 'passed' AND answered_at >= ${w.from} AND answered_at < ${w.to}`)
  const refusals = await refusalCount(sql, w)
  const cycles = await cycleTimes(sql, w)
  const waits = await queueWaits(sql, w)
  const usage = withUsage
    ? await usageOf(sql, w, {
        now: options.now,
        timeoutMs: options.usageTimeoutMs ?? USAGE_TIMEOUT_MS,
        cache: options.pointsCache ?? sharedPoints,
      })
    : { cost: null, points: null }

  return [
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
        'Owner actions in the window on an Issue the factory should have settled, divided by the Issues filed in the window: a Decision the owner answered and did not mark worth asking, an owner note, an owner wake, a cancel, a reopen. The first note of a filing, anything the orchestrator did (it is reported separately, as its own friction line), a verdict on a Concept or Spec and a done Errand are not counted: those are the request or the owner wanted them. Touches of one kind within a minute of the one before count once: one steer sent to a dozen Issues, or one re-planned batch cancelled, is one action. The orchestrator is excluded only while it writes with its own token (`FACTORY_ORCHESTRATOR_TOKEN`); a session still on the owner token is counted as the owner.',
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
      key: 'specs_per_100',
      label: 'Specs per 100 Issues',
      value: issues === 0 ? null : (specs / issues) * 100,
      unit: 'per_100_issues',
      n: issues,
      count: specs,
      target: { kind: 'trend', min: null, max: null },
      measured: true,
      definition:
        'Specs the leads submitted in the window (a lead hands one over when the Issue carries the checkpoint spec, or the change is a new public surface, a data model, a dependency of weight or a screen the owner has not seen), per 100 Issues filed in the window. Near zero for weeks means the Spec path is silent.',
    }),
    kpi({
      key: 'owner_decisions_per_100',
      label: 'Owner-settled Decisions per 100 Issues',
      value: issues === 0 ? null : (byOwner / issues) * 100,
      unit: 'per_100_issues',
      n: issues,
      count: byOwner,
      target: { kind: 'trend', min: null, max: null },
      measured: true,
      definition:
        'Decisions the owner answered himself in the window (not the Judge, a policy or a default), per 100 Issues filed in the window. Read beside Specs per 100 Issues: both near zero means nothing reaches him.',
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
        "Of the first watches (the window after an Issue's first ship) that ended in the window as passed or regressed, the share that passed. A watch that ended because its Issue moved on is not counted. A pass is as strong as its watch: read it beside the first watch's dwell and the regressions by cause.",
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
      definition:
        'Not counted here: fix commits are sorted by class by the fix-classes loop and shown by class and week on the Improve screen (GET /v1/fix-commits).',
    }),
    kpi({
      key: 'window_points',
      label: 'Window points per Issue',
      value: usage.points === null ? null : per(usage.points, issues),
      unit: 'points',
      n: withUsage ? issues : 0,
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
      n: withUsage ? issues : 0,
      count: null,
      measured: usage.cost !== null,
      definition:
        "Dollars the usage schema priced for the sessions of the Issues filed in the window (a session tagged with the Issue's number, or a Claude session its lead reported, with its subagents), divided by those Issues. Joined at read, never copied. Null while the usage schema is not there.",
    }),
    ...(await flowKpis(sql, w)),
  ]
}

/**
 * Windows read at once. A window holds one pool connection at a time (a usage read takes its own transaction, after the
 * plain reads), and the shared pool has 8, so 3 leaves the rest for other requests.
 */
const WINDOW_CONCURRENCY = 3

/** `fn` over `items` with at most `limit` running at once; results in item order. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i] as T, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** Windows older than this many back (0 is the current one) skip the usage schema: its figures are expensive. */
const USAGE_WINDOWS = 2

/**
 * The table in `docs/product.md`, computed over the last `days` days from the event log and the checkpoint tables, with the
 * same figures over the `HISTORY_WINDOWS - 1` windows of `days` days before it (usage only for the one before).
 */
export async function readKpis(
  sql: SQL,
  options: { now: Date; days: number; usageTimeoutMs?: number; pointsCache?: PointsCache },
): Promise<KpiModel> {
  const step = options.days * 24 * 3_600_000
  // oldest first; window k ends where window k + 1 starts, the last is exactly `windowOf(now, days)`
  const windows = Array.from({ length: HISTORY_WINDOWS }, (_, i) =>
    windowOf(new Date(options.now.getTime() - (HISTORY_WINDOWS - 1 - i) * step), options.days),
  )
  const lists = await mapBounded(windows, WINDOW_CONCURRENCY, (w, i) =>
    kpisOf(sql, w, options, { usage: i >= HISTORY_WINDOWS - USAGE_WINDOWS }),
  )
  const current = lists[HISTORY_WINDOWS - 1] ?? []
  const kpis: Kpi[] = current.map((k) => ({
    ...k,
    history: lists.map((list) => {
      const point = list.find((x) => x.key === k.key)
      return { value: point?.value ?? null, n: point?.n ?? 0 }
    }),
  }))
  const last = windows[HISTORY_WINDOWS - 1] ?? windowOf(options.now, options.days)
  return {
    at: options.now.toISOString(),
    days: options.days,
    window: { from: last.from.toISOString(), to: last.to.toISOString() },
    windows: windows.map((w) => ({ from: w.from.toISOString(), to: w.to.toISOString() })),
    kpis,
  }
}
