import type { SQL } from 'bun'
import * as z from 'zod'
import type { FrictionCount, FrictionModel } from '@software-factory/contract'
import { avoidableTouches, issuesFiled, type Window } from './kpis.ts'
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

const SETTLERS: Record<string, string> = {
  owner: 'Decisions settled by the owner',
  policy: 'Decisions settled by standing policy',
  judge: 'Decisions settled by the Judge',
  default: 'Decisions settled by their default',
}

const Count = z.object({ n: z.coerce.number().int() })
const Grouped = Count.extend({ key: z.string().nullable(), detail: z.string().nullable() })

const one = async (rows: Promise<unknown[]>): Promise<number> => Count.parse((await rows)[0]).n
const grouped = async (rows: Promise<unknown[]>) => (await rows).map((raw) => Grouped.parse(raw))

/** The counts of waste in the last `days` days: counts only, no model. Read-only SQL. */
export async function readFriction(sql: SQL, options: { now: Date; days: number }): Promise<FrictionModel> {
  const { now } = options
  const w: Window = windowOf(now, options.days)
  const issues = await issuesFiled(sql, w)
  const counts: FrictionCount[] = []
  const add = (group: FrictionCount['group'], key: string, label: string, count: number) =>
    counts.push({ key, group, label, count, perIssue: per(count, issues) })

  const touches = await avoidableTouches(sql, w)
  for (const [kind, label] of Object.entries(TOUCHES))
    add('avoidable_touch', `touch:${kind}`, label, touches[kind] ?? 0)

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
    issues,
    counts,
  }
}
