import type { SQL } from 'bun'
import * as z from 'zod'

const Row = z.object({ session: z.string(), kind: z.string(), at: z.coerce.date() })

/** Edge incidents recorded in the window: the leads that hit a transient API error together, and over how long. */
export interface EdgeIncidentRow {
  firstAt: Date
  lastAt: Date
  leads: number
  plans: number
}

const Edge = z.object({
  first_at: z.coerce.date(),
  last_at: z.coerce.date(),
  leads: z.coerce.number().int(),
  plans: z.coerce.number().int(),
})

export async function readEdgeIncidents(sql: SQL, window: { from: Date; to: Date }): Promise<EdgeIncidentRow[]> {
  const rows: unknown[] = await sql`
    SELECT first_at, last_at, leads, plans FROM factory.api_edge_incidents
    WHERE first_at >= ${window.from} AND first_at < ${window.to} ORDER BY first_at`
  return rows.map((raw) => {
    const row = Edge.parse(raw)
    return { firstAt: row.first_at, lastAt: row.last_at, leads: row.leads, plans: row.plans }
  })
}

/** A day of look-back, so an incident that began before the window and ran into it is counted for the part inside. */
const LOOKBACK_MS = 24 * 3_600_000

/**
 * The minutes lead sessions spent with their turn ended on an API error in the window: from an `api_error` to the next turn that
 * started (the resume held), clipped to the window, an incident still open counted to `now`. A clean turn end closes one
 * with no minutes after it; further errors in an incident add nothing (one clock per session). Read from the hook facts.
 */
export async function apiBlockedMinutes(sql: SQL, window: { from: Date; to: Date }): Promise<number> {
  const rows: unknown[] = await sql`
    SELECT session, kind, at FROM factory.lead_hook_events
    WHERE kind IN ('api_error', 'turn_started', 'turn_ended')
      AND session IN (
        SELECT DISTINCT session FROM factory.lead_hook_events WHERE kind = 'api_error' AND at >= ${new Date(window.from.getTime() - LOOKBACK_MS)} AND at < ${window.to})
      AND at >= ${new Date(window.from.getTime() - LOOKBACK_MS)} AND at < ${window.to}
    ORDER BY session, at, seq`
  let ms = 0
  let session = ''
  let from: Date | null = null
  const close = (to: Date) => {
    if (!from) return
    const start = Math.max(from.getTime(), window.from.getTime())
    const end = Math.min(to.getTime(), window.to.getTime())
    if (end > start) ms += end - start
    from = null
  }
  for (const raw of rows) {
    const row = Row.parse(raw)
    if (row.session !== session) {
      close(window.to)
      session = row.session
    }
    if (row.kind === 'api_error') from ??= row.at
    else if (row.kind === 'turn_started') close(row.at)
    else from = null
  }
  close(window.to)
  return ms / 60_000
}
