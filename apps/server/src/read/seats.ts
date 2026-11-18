import type { SQL } from 'bun'
import { Effort, type LeadSeat, Tier } from '@software-factory/contract'

/** The role table's `lead` row as it stands; null when the table cannot be read. */
export type LeadRow = () => Promise<{ tier: Tier; effort: Effort } | null>

interface EventRow {
  issue_id: string
  kind: 'filed' | 'seated' | 'admitted' | 'lead_started'
  version: number
  payload: unknown
  state: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A seat payload (`{ tier, effort, role? }`) read as the badge wants it, or null when it names no known tier and effort. */
function seatOf(value: unknown, planned: boolean): LeadSeat | null {
  if (!isRecord(value)) return null
  const tier = Tier.safeParse(value.tier)
  const effort = Effort.safeParse(value.effort)
  if (!tier.success || !effort.success) return null
  const role = typeof value.role === 'string' && value.role.trim() ? value.role.trim() : null
  return { tier: tier.data, effort: effort.data, role, planned }
}

/**
 * The seat of each Issue's lead for the badge. An Issue whose latest `lead_started` is newer than its latest `admitted`
 * shows what that attempt started on; one waiting for its next attempt (or never started) shows the seat it will start on:
 * the last `seated`, else the filed seat, else the table's `lead` row, marked `planned`. A closed Issue with no lead shows
 * none. An Issue with nothing known is absent from the map.
 */
export async function readLeadSeats(
  sql: SQL,
  ids: readonly string[],
  leadRow?: LeadRow,
): Promise<Map<string, LeadSeat>> {
  const seats = new Map<string, LeadSeat>()
  if (ids.length === 0) return seats
  const rows: EventRow[] = await sql`
    SELECT DISTINCT ON (e.issue_id, e.kind) e.issue_id, e.kind, e.version, e.payload, i.state
    FROM factory.issue_events e JOIN factory.issues i ON i.id = e.issue_id
    WHERE e.issue_id IN ${sql(ids)} AND e.result = 'applied' AND e.kind IN ('filed', 'seated', 'admitted', 'lead_started')
    ORDER BY e.issue_id, e.kind, e.version DESC`
  const byIssue = new Map<string, Map<EventRow['kind'], EventRow>>()
  for (const row of rows) {
    const kinds = byIssue.get(row.issue_id) ?? new Map<EventRow['kind'], EventRow>()
    kinds.set(row.kind, row)
    byIssue.set(row.issue_id, kinds)
  }
  const lead = leadRow ? await leadRow().catch(() => null) : null
  for (const [id, kinds] of byIssue) {
    const started = kinds.get('lead_started')
    const admitted = kinds.get('admitted')
    if (started && (!admitted || started.version > admitted.version)) {
      const ran = isRecord(started.payload) ? seatOf(started.payload.seat, false) : null
      if (ran) seats.set(id, ran)
      continue
    }
    if (kinds.get('filed')?.state === 'closed') continue
    const filed = kinds.get('filed')?.payload
    const asked = seatOf(kinds.get('seated')?.payload, true) ?? seatOf(isRecord(filed) ? filed.seat : null, true)
    const planned = asked ?? (lead ? { ...lead, role: 'lead', planned: true } : null)
    if (planned) seats.set(id, planned)
  }
  return seats
}
