import type { SQL } from 'bun'
import * as z from 'zod'
import type { FrictionCount, FrictionModel } from '@software-factory/contract'
import { readEdgeIncidents } from './api-errors.ts'
import { avoidableTouches, issuesFiled, orchestratorSteering, type Window } from './kpis.ts'
import { per, windowOf } from './stats.ts'
import { plain } from './words.ts'

/** A note typed into a lead later than this after it was claimed is undelivered. */
export const NOTE_GRACE_MS = 10 * 60_000

/** The wait reasons that are stalls (`WAITS` in the work domain), in words. */
const STALLS: Record<string, string> = {
  wall: "Stalled because the account's window was full",
  unreported: 'Stalled because the lead stopped reporting',
  blocked: 'Stalled because something blocked the lead',
  lead_gone: 'Stalled because the lead was gone',
  regressed: 'Stalled because a shipped change regressed',
}

const TOUCHES: Record<string, string> = {
  decision_answered: 'Decisions the owner answered that were not worth asking',
  noted: 'Notes the owner sent to a lead',
  woken: 'Waits the owner woke by hand',
  cancelled: 'Issues the owner cancelled',
  reopened: 'Issues the owner reopened',
}

const STEERS: Record<string, string> = {
  decision_answered: 'Decisions the orchestrator answered that were not worth asking',
  noted: 'Notes the orchestrator sent to a lead',
  woken: 'Waits the orchestrator woke by hand',
  cancelled: 'Issues the orchestrator cancelled',
  reopened: 'Issues the orchestrator reopened',
}

const SETTLERS: Record<string, string> = {
  owner: 'Decisions settled by the owner',
  orchestrator: 'Decisions settled by the orchestrator',
  policy: 'Decisions settled by standing policy',
  judge: 'Decisions settled by the Judge',
  default: 'Decisions settled by their default',
}

const Count = z.object({ n: z.coerce.number().int() })
const Grouped = Count.extend({ key: z.string().nullable(), detail: z.string().nullable() })

const one = async (rows: Promise<unknown[]>): Promise<number> => Count.parse((await rows)[0]).n
const grouped = async (rows: Promise<unknown[]>) => (await rows).map((raw) => Grouped.parse(raw))

const Marker = z.object({ at: z.coerce.date().nullable() })

/**
 * The window friction counts in: the last `days` days, cut at the import marker. The cutover imported the old core's
 * history with its original timestamps, so before the newest import ran, nothing was recorded by this core. A database
 * with no import has no marker and no cut.
 */
export async function frictionWindow(
  sql: SQL,
  options: { now: Date; days: number },
): Promise<{ w: Window; since: Date | null }> {
  const { at: since } = Marker.parse((await sql`SELECT max(imported_at) AS at FROM factory.import_issues`)[0])
  const w = windowOf(options.now, options.days)
  return { w: since && since > w.from ? { from: since, to: w.to } : w, since }
}

/** Issues closed in the window: what the per-Issue rates divide by. */
const issuesClosed = async (sql: SQL, w: Window): Promise<number> =>
  one(sql`
    SELECT count(*) AS n FROM factory.issue_events
    WHERE to_state = 'closed' AND result = 'applied' AND at >= ${w.from} AND at < ${w.to}`)

/** The counts of waste in the last `days` days since the import: counts only, no model. Read-only SQL. */
export async function readFriction(sql: SQL, options: { now: Date; days: number }): Promise<FrictionModel> {
  const { now } = options
  const { w, since } = await frictionWindow(sql, options)
  const issues = await issuesFiled(sql, w)
  const closed = await issuesClosed(sql, w)
  const counts: FrictionCount[] = []
  const add = (group: FrictionCount['group'], key: string, label: string, count: number) =>
    counts.push({ key, group, label, count, perIssue: per(count, closed) })

  const touches = await avoidableTouches(sql, w)
  for (const [kind, label] of Object.entries(TOUCHES))
    add('avoidable_touch', `touch:${kind}`, label, touches[kind] ?? 0)

  const steers = await orchestratorSteering(sql, w)
  for (const [kind, label] of Object.entries(STEERS))
    add('orchestrator_steer', `steer:${kind}`, label, steers[kind] ?? 0)

  const refused = await grouped(sql`
    SELECT kind AS key, detail, count(*) AS n FROM factory.issue_events
    WHERE result = 'refused' AND at >= ${w.from} AND at < ${w.to} GROUP BY kind, detail ORDER BY n DESC, kind`)
  add(
    'refusal',
    'refusal:total',
    'Events the state machine refused',
    refused.reduce((sum, row) => sum + row.n, 0),
  )
  for (const row of refused) {
    const reason = plain(row.detail ?? 'no reason given', 80)
    add('refusal', `refusal:${row.key}:${reason}`, `A ${row.key} event was refused: ${reason}`, row.n)
  }
  const ships = await grouped(sql`
    SELECT NULL::text AS key, detail, count(*) AS n FROM factory.quality_ships
    WHERE result = 'refused' AND at >= ${w.from} AND at < ${w.to} GROUP BY detail ORDER BY n DESC`)
  add(
    'refusal',
    'ship_refused:total',
    'Ships the gate refused',
    ships.reduce((sum, row) => sum + row.n, 0),
  )
  for (const row of ships) {
    const reason = plain(row.detail ?? 'no reason given', 80)
    add('refusal', `ship_refused:${reason}`, `A ship was refused: ${reason}`, row.n)
  }

  const stalls = await grouped(sql`
    SELECT wait->>'reason' AS key, NULL::text AS detail, count(*) AS n FROM factory.issue_events
    WHERE result = 'applied' AND to_state = 'waiting' AND wait->>'reason' IN ${sql(Object.keys(STALLS))}
      AND at >= ${w.from} AND at < ${w.to} GROUP BY wait->>'reason'`)
  for (const [reason, label] of Object.entries(STALLS)) {
    add('stall', `stall:${reason}`, label, stalls.find((row) => row.key === reason)?.n ?? 0)
  }

  add(
    'lead_gone',
    'lead_gone',
    'Leads that were lost',
    await one(sql`
      SELECT count(*) AS n FROM factory.issue_events
      WHERE kind = 'lead_gone' AND result = 'applied' AND at >= ${w.from} AND at < ${w.to}`),
  )

  // An edge incident (leads that hit transient API errors together) is recorded once with its leads and window; the factory
  // answered it by itself, so it is a row to see, never a finding.
  const edges = await readEdgeIncidents(sql, w)
  add('api_transient', 'api_transient:total', 'Edge incidents: leads hit transient API errors together', edges.length)
  for (const edge of edges) {
    const minutes = Math.max(1, Math.round((edge.lastAt.getTime() - edge.firstAt.getTime()) / 60_000))
    add(
      'api_transient',
      `api_transient:${edge.firstAt.toISOString()}`,
      `${edge.leads} leads${edge.plans > 0 ? ` and ${edge.plans} plan sessions (not resumed)` : ''} hit transient API errors within ${minutes} min of ${edge.firstAt.toISOString()}`,
      edge.leads,
    )
  }

  add(
    'undelivered_note',
    'undelivered_note',
    'Notes that never reached the lead',
    await one(sql`
      SELECT count(*) AS n FROM factory.lead_deliveries
      WHERE kind = 'note' AND typed_at IS NULL AND claimed_at >= ${w.from} AND claimed_at < ${w.to}
        AND claimed_at <= ${new Date(now.getTime() - NOTE_GRACE_MS)}`),
  )

  add(
    'unreviewed_ship',
    'unreviewed_ship',
    'Ships with no review of the change',
    await one(sql`
      SELECT count(*) AS n FROM factory.quality_evidence
      WHERE kind = 'review' AND payload->>'status' NOT IN ('covered', 'not_required')
        AND at >= ${w.from} AND at < ${w.to}`),
  )

  // Ships before the acceptance existed have no acceptance row, so only a row with no statements counts: no backfill.
  add(
    'unstated_acceptance',
    'unstated_acceptance',
    'Ships that state nothing against the acceptance',
    await one(sql`
      SELECT count(*) AS n FROM factory.quality_evidence
      WHERE kind = 'acceptance' AND jsonb_array_length(payload->'statements') = 0
        AND at >= ${w.from} AND at < ${w.to}`),
  )

  // Ships before the CI was recorded have no ci row, and `running` or `unknown` is not a verdict: only red and missing count.
  add(
    'unproven_ci',
    'unproven_ci',
    'Ships whose CI was red or missing',
    await one(sql`
      SELECT count(*) AS n FROM factory.quality_evidence
      WHERE kind = 'ci' AND payload->>'status' IN ('red', 'missing')
        AND at >= ${w.from} AND at < ${w.to}`),
  )

  add(
    'regression',
    'regression',
    'Watches that ended in a regression',
    await one(sql`
      SELECT count(*) AS n FROM factory.quality_watches
      WHERE answer = 'regressed' AND answered_at >= ${w.from} AND answered_at < ${w.to}`),
  )

  const settled = await grouped(sql`
    SELECT settled_by AS key, NULL::text AS detail, count(*) AS n FROM factory.decisions
    WHERE answered_at >= ${w.from} AND answered_at < ${w.to} GROUP BY settled_by`)
  for (const [settler, label] of Object.entries(SETTLERS)) {
    add('decision_settled', `decision_settled:${settler}`, label, settled.find((row) => row.key === settler)?.n ?? 0)
  }

  const held = await grouped(sql`
    SELECT source AS key, NULL::text AS detail, count(*) AS n FROM factory.intake_signals
    WHERE state = 'held' AND received_at >= ${w.from} AND received_at < ${w.to} GROUP BY source ORDER BY n DESC, source`)
  add(
    'signal',
    'signal_held:total',
    'Signals held in quarantine',
    held.reduce((sum, row) => sum + row.n, 0),
  )
  for (const row of held) add('signal', `signal_held:${row.key}`, `Signals held from ${row.key}`, row.n)

  return {
    at: now.toISOString(),
    days: options.days,
    window: { from: w.from.toISOString(), to: w.to.toISOString() },
    since: since?.toISOString() ?? null,
    issues,
    closed,
    counts,
  }
}
