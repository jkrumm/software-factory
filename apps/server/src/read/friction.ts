import type { SQL } from 'bun'
import * as z from 'zod'
import type { FrictionCount, FrictionModel, SpecSource } from '@software-factory/contract'
import { readEdgeIncidents } from './api-errors.ts'
import { avoidableTouches, issuesFiled, orchestratorSteering, ownerVerdict, TOUCH_LABELS, type Window } from './kpis.ts'
import { specSourceSql } from './spec-screen.ts'
import { per, windowOf } from './stats.ts'
import { refusalClass } from './refusal-class.ts'
import { isCut } from '../kernel/epoch.ts'

/** A note of a lead that is still there and not typed this long after it was claimed is undelivered. */
const NOTE_GRACE_MS = 10 * 60_000

/** The wait reasons that are stalls (`WAITS` in the work domain), in words. */
const STALLS: Record<string, string> = {
  wall: "Stalled because the account's window was full",
  unreported: 'Stalled because the lead stopped reporting',
  blocked: 'Stalled because something blocked the lead',
  lead_gone: 'Stalled because the lead was gone',
  regressed: 'Stalled because a shipped change regressed',
}

const STEERS: Record<string, string> = {
  decision_answered: 'Decisions the orchestrator answered that were not worth asking',
  noted: 'Notes the orchestrator sent to a lead',
  woken: 'Waits the orchestrator woke by hand',
  cancelled: 'Issues the orchestrator cancelled',
  reopened: 'Issues the orchestrator reopened',
}

/** Who made a Spec owed that the owner marked not needed: the friction line names its source, so the rule behind it is found. */
const SPEC_SOURCES_SAID: Record<SpecSource, string> = {
  triage: 'Specs triage made owed that did not need the owner',
  filer: 'Specs the filer made owed that did not need the owner',
  replan: 'Replan Specs that did not need the owner',
  lead: 'Specs a lead judged due that did not need the owner',
}

const ANSWERERS: Record<string, string> = {
  owner: 'Decisions answered by the owner',
  orchestrator: 'Decisions answered by the orchestrator',
  judge: 'Decisions answered by the Judge',
  default: 'Decisions answered by their default',
}

const Count = z.object({ n: z.coerce.number().int() })
const Grouped = Count.extend({ key: z.string().nullable(), detail: z.string().nullable() })

/** Rows of one refusal class summed, most frequent first (ties by class). */
function byClass(rows: readonly { detail: string | null; n: number }[]): { id: string; words: string; n: number }[] {
  const classes = new Map<string, { id: string; words: string; n: number }>()
  for (const row of rows) {
    const { id, words } = refusalClass(row.detail)
    const seen = classes.get(id)
    if (seen) seen.n += row.n
    else classes.set(id, { id, words, n: row.n })
  }
  return [...classes.values()].sort((a, b) => b.n - a.n || (a.id < b.id ? -1 : 1))
}

const one = async (rows: Promise<unknown[]>): Promise<number> => Count.parse((await rows)[0]).n
const grouped = async (rows: Promise<unknown[]>) => (await rows).map((raw) => Grouped.parse(raw))

/**
 * The window friction counts in: the last `days` days, cut at the counting epoch (`config/throughput.json`): nothing
 * earlier is counted. `since` is the epoch when it cuts this window, else null.
 */
export function frictionWindow(options: { now: Date; days: number; epoch?: Date | null }): {
  w: Window
  since: Date | null
} {
  const w = windowOf(options.now, options.days)
  const since = isCut(w.from, options.epoch ?? null) ? (options.epoch ?? null) : null
  return { w: since ? { from: since, to: w.to } : w, since }
}

/** Issues closed in the window: what the per-Issue rates divide by. */
const issuesClosed = async (sql: SQL, w: Window): Promise<number> =>
  one(sql`
    SELECT count(*) AS n FROM factory.issue_events
    WHERE to_state = 'closed' AND result = 'applied' AND at >= ${w.from} AND at < ${w.to}`)

/** An edge incident is keyed by when it began, so no earlier window can hold the same row: it has no comparison. */
const RECORDED_BY_TIME = /^api_transient:\d{4}-/

type Counted = Omit<FrictionCount, 'previous'>

/** Every friction count of one window, with the Issues filed and closed in it. */
async function countsOf(
  sql: SQL,
  w: Window,
  now: Date,
): Promise<{ issues: number; closed: number; counts: Counted[] }> {
  const issues = await issuesFiled(sql, w)
  const closed = await issuesClosed(sql, w)
  const counts: Counted[] = []
  const add = (group: FrictionCount['group'], key: string, label: string, count: number) =>
    counts.push({ key, group, label, count, perIssue: per(count, closed) })

  const touches = await avoidableTouches(sql, w)
  for (const [kind, label] of Object.entries(TOUCH_LABELS))
    add('avoidable_touch', `touch:${kind}`, label, touches[kind] ?? 0)

  const steers = await orchestratorSteering(sql, w)
  for (const [kind, label] of Object.entries(STEERS))
    add('orchestrator_steer', `steer:${kind}`, label, steers[kind] ?? 0)

  const refused = await grouped(sql`
    SELECT NULL::text AS key, detail, count(*) AS n FROM factory.issue_events
    WHERE result = 'refused' AND at >= ${w.from} AND at < ${w.to} GROUP BY detail`)
  add(
    'refusal',
    'refusal:total',
    'Events the state machine refused',
    refused.reduce((sum, row) => sum + row.n, 0),
  )
  for (const row of byClass(refused)) add('refusal', `refusal:${row.id}`, `An event was refused: ${row.words}`, row.n)
  const ships = await grouped(sql`
    SELECT NULL::text AS key, detail, count(*) AS n FROM factory.quality_ships
    WHERE result = 'refused' AND at >= ${w.from} AND at < ${w.to} GROUP BY detail`)
  add(
    'refusal',
    'ship_refused:total',
    'Ships the gate refused',
    ships.reduce((sum, row) => sum + row.n, 0),
  )
  for (const row of byClass(ships)) add('refusal', `ship_refused:${row.id}`, `A ship was refused: ${row.words}`, row.n)

  // A stall the next event of the Issue moved up (the light seat's own rule, `moveUpIfDue`: the attempt ends and the Issue
  // queues on the lead row) is the seat's cost, which `read finders` and the seat KPIs already count: no loop.
  const stalls = await grouped(sql`
    SELECT wait->>'reason' AS key, NULL::text AS detail, count(*) AS n FROM factory.issue_events e
    WHERE result = 'applied' AND to_state = 'waiting' AND from_state IS DISTINCT FROM 'waiting'
      AND wait->>'reason' IN ${sql(Object.keys(STALLS))} AND at >=${w.from} AND at < ${w.to}
      AND NOT EXISTS (SELECT 1 FROM factory.issue_events m
        WHERE m.issue_id = e.issue_id AND m.kind = 'moved_up' AND m.result = 'applied' AND m.version = e.version + 1)
    GROUP BY wait->>'reason'`)
  for (const [reason, label] of Object.entries(STALLS)) {
    add('stall', `stall:${reason}`, label, stalls.find((row) => row.key === reason)?.n ?? 0)
  }

  add(
    'lead_gone',
    'lead_gone',
    'Leads that were lost',
    await one(sql`
      SELECT (SELECT count(*) FROM factory.issue_events
        WHERE kind = 'lead_gone' AND result = 'applied' AND at >= ${w.from} AND at < ${w.to})
        -- a lead that lost its agent to a host restart is lost too, whether or not its session started again; one that
        -- then went the lost path is the event above
        + (SELECT count(*) FROM factory.lead_losses l WHERE l.at >= ${w.from} AND l.at < ${w.to}
          AND NOT EXISTS (SELECT 1 FROM factory.issue_events e WHERE e.issue_id = l.issue_id AND e.kind = 'lead_gone'
            AND e.result = 'applied' AND e.payload->>'attempt' = l.attempt::text)) AS n`),
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
    // A note nobody can hear is no broken promise: a closed Issue has no lead to tell, and a lead that was lost (or whose
    // attempt a later one replaced) is its own count, its notes carried by the next attempt's brief.
    await one(sql`
      SELECT count(*) AS n FROM factory.lead_deliveries d
      JOIN factory.issues i ON i.id = d.issue_id
      WHERE d.kind = 'note' AND d.typed_at IS NULL AND d.claimed_at >= ${w.from} AND d.claimed_at < ${w.to}
        AND d.claimed_at <= ${new Date(now.getTime() - NOTE_GRACE_MS)}
        AND i.state <> 'closed'
        AND NOT EXISTS (
          SELECT 1 FROM factory.lead_attempts a
          WHERE a.issue_id = d.issue_id AND (a.attempt > d.attempt OR (a.attempt = d.attempt AND a.gone_at IS NOT NULL)))`),
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

  const unneeded = await grouped(sql`
    SELECT ${specSourceSql(sql)} AS key, NULL::text AS detail, count(*) AS n
    FROM factory.verdicts v
    JOIN factory.artifacts a ON a.id = v.artifact_id AND a.kind = 'spec'
    LEFT JOIN factory.spec_screens s ON s.artifact_id = v.artifact_id AND s.revision = v.revision
    WHERE ${ownerVerdict(sql, w)} AND v.needed_me IS FALSE
    GROUP BY 1`)
  for (const [source, label] of Object.entries(SPEC_SOURCES_SAID)) {
    add('spec_unneeded', `spec_unneeded:${source}`, label, unneeded.find((row) => row.key === source)?.n ?? 0)
  }

  const settled = await grouped(sql`
    SELECT settled_by AS key, NULL::text AS detail, count(*) AS n FROM factory.decisions
    WHERE answered_at >= ${w.from} AND answered_at < ${w.to} GROUP BY settled_by`)
  for (const [answerer, label] of Object.entries(ANSWERERS)) {
    add('decision_answered', `decision_answered:${answerer}`, label, settled.find((row) => row.key === answerer)?.n ?? 0)
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

  return { issues, closed, counts }
}

/**
 * The counts of waste in the last `days` days since the counting epoch: counts only, no model. Read-only SQL. Each count also
 * carries the same count over the window of the same length just before it, so a reader sees which way it moved; that
 * window is not read (`previous` null) when it reaches back before the epoch, because it would be shorter than
 * the one it is compared with. The comparison is read only when asked for (`compare`): the Console wants it, the loops do not.
 */
export async function readFriction(
  sql: SQL,
  options: { now: Date; days: number; compare?: boolean; epoch?: Date | null },
): Promise<FrictionModel> {
  const { now } = options
  const { w, since } = frictionWindow(options)
  const current = await countsOf(sql, w, now)
  const span = w.to.getTime() - w.from.getTime()
  const before = { from: new Date(w.from.getTime() - span), to: w.from }
  const comparable = options.compare === true && !isCut(before.from, options.epoch ?? null)
  const earlier = comparable ? await countsOf(sql, before, before.to) : null
  const previous = new Map((earlier?.counts ?? []).map((c) => [c.key, c.count]))
  return {
    at: now.toISOString(),
    days: options.days,
    window: { from: w.from.toISOString(), to: w.to.toISOString() },
    since: since?.toISOString() ?? null,
    issues: current.issues,
    closed: current.closed,
    counts: current.counts.map((c) => ({
      ...c,
      previous: earlier === null || RECORDED_BY_TIME.test(c.key) ? null : (previous.get(c.key) ?? 0),
    })),
  }
}
