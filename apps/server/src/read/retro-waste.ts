import type { SQL } from 'bun'
import * as z from 'zod'
import type { RetroWasteSource } from '@software-factory/contract'
import { WAITS } from '../domains/work/issue.ts'
import type { Window } from './kpis.ts'

const HOUR_MS = 3_600_000

const Part = z.object({ part: z.string().nullable(), hours: z.coerce.number(), events: z.coerce.number().int() })
type Part = z.infer<typeof Part>

const round = (hours: number): number => Math.round(hours * 10) / 10

/** The sum of the parts in hours, how many events made it, and the part with most hours (`name (N h)`), null when parts have no names. Pure. */
export function wasteOf(source: RetroWasteSource['source'], parts: readonly Part[]): RetroWasteSource {
  const hours = parts.reduce((sum, p) => sum + p.hours, 0)
  const events = parts.reduce((sum, p) => sum + p.events, 0)
  const top = parts
    .filter((p) => p.part !== null)
    .reduce<Part | null>((best, p) => (best === null || p.hours > best.hours ? p : best), null)
  return { source, hours: round(hours), events, largest: top ? `${top.part} (${round(top.hours)} h)` : null }
}

const STALL_REASONS = Object.entries(WAITS)
  .filter(([, wait]) => wait.stall)
  .map(([reason]) => reason)
const OWNER_REASONS = Object.entries(WAITS)
  .filter(([, wait]) => wait.exit === 'person')
  .map(([reason]) => reason)

/** Waits of the window by reason: from the applied event that put the Issue in `waiting` to the next applied event, clipped to the window; still waiting runs to the window's end. */
async function waitsBy(sql: SQL, w: Window, reasons: readonly string[]): Promise<Part[]> {
  const rows: unknown[] = await sql`
    SELECT reason AS part, sum(extract(epoch FROM (least(coalesce(ended, ${w.to}::timestamptz), ${w.to}::timestamptz) - greatest(at, ${w.from}::timestamptz)))) / 3600 AS hours, count(*) AS events
    FROM (
      SELECT at, to_state, wait->>'reason' AS reason, lead(at) OVER (PARTITION BY issue_id ORDER BY version) AS ended
      FROM factory.issue_events
      WHERE result = 'applied' AND to_state IS DISTINCT FROM from_state AND at < ${w.to}
    ) e
    WHERE to_state = 'waiting' AND reason IN ${sql([...reasons])} AND coalesce(ended, ${w.to}::timestamptz) > ${w.from}
    GROUP BY reason`
  return rows.map((raw) => Part.parse(raw))
}

/**
 * The five sources of waste over the window in hours, largest first, so the retro's Report can lead with the three that
 * cost most and say how many hours each was. Queue: time Issues sat queued, by reason. Slot wait:
 * time check steps waited for a test slot, by reason. Stalls: time Issues spent in a stall wait. Refused ships: time from a
 * refused ship to the lead's next ship call. Owner waits: time Issues waited on a person. Hours are summed over Issues, so
 * they are Issue-hours, and parallel waits add up. Read-only SQL, no model.
 */
export async function readWaste(sql: SQL, w: Window): Promise<RetroWasteSource[]> {
  const queue: unknown[] = await sql`
    SELECT kind AS part, sum(extract(epoch FROM (least(coalesce(to_at, ${w.to}::timestamptz), ${w.to}::timestamptz) - greatest(from_at, ${w.from}::timestamptz)))) / 3600 AS hours, count(*) AS events
    FROM factory.queue_intervals
    WHERE from_at < ${w.to} AND coalesce(to_at, ${w.to}::timestamptz) > ${w.from}
    GROUP BY kind`
  const slot: unknown[] = await sql`
    SELECT r.key AS part, sum(r.value::float8) / ${HOUR_MS} AS hours, count(DISTINCT s.id) AS events
    FROM factory.slot_waits s, jsonb_each_text(s.split) r
    WHERE s.at >= ${w.from} AND s.at < ${w.to}
    GROUP BY r.key`
  const refused: unknown[] = await sql`
    SELECT NULL::text AS part,
      coalesce(sum(extract(epoch FROM (next_at - at))), 0) / 3600 AS hours, count(*) AS events
    FROM (
      SELECT at, result, lead(at) OVER (PARTITION BY issue_id ORDER BY at) AS next_at FROM factory.quality_ships
    ) q
    WHERE result = 'refused' AND at >= ${w.from} AND at < ${w.to}`
  const sources = [
    wasteOf('queue', queue.map((raw) => Part.parse(raw))),
    wasteOf('slot_wait', slot.map((raw) => Part.parse(raw))),
    wasteOf('stalls', await waitsBy(sql, w, STALL_REASONS)),
    wasteOf('refused_ships', refused.map((raw) => Part.parse(raw))),
    wasteOf('owner_waits', await waitsBy(sql, w, OWNER_REASONS)),
  ]
  return sources.sort((a, b) => b.hours - a.hours || (a.source < b.source ? -1 : 1))
}
