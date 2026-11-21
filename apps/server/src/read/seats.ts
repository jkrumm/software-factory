import type { SQL } from 'bun'
import { Effort, type LeadSeat, Tier } from '@software-factory/contract'
import type { LightFacts } from '../domains/leads/light.ts'

/** A row of the role table as it stands; null when the table cannot be read. */
export type TableRow = () => Promise<{ tier: Tier; effort: Effort } | null>

/**
 * What the planned seat is read from: the role table's `lead` row, and, to say what the light rule names for an Issue
 * as it is now (the same rule the lead's start applies), the `light` row, the tripwire that lets triage's `small` start
 * light. Without `light` every planned seat is the `lead` row.
 */
export interface SeatTable {
  lead: TableRow
  light?: {
    /** the role table's name of the light row (`light`) */
    role: string
    row: TableRow
    gate: () => Promise<boolean>
    /** `lightRule` (`domains/leads/light.ts`): the one rule the lead's start applies; read/ takes it, it does not import it */
    rule: (facts: LightFacts) => string | null
  }
}

interface EventRow {
  issue_id: string
  kind: 'filed' | 'seated' | 'admitted' | 'lead_started' | 'moved_up'
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
  const rule = typeof value.rule === 'string' && value.rule.trim() ? value.rule.trim() : null
  return { tier: tier.data, effort: effort.data, role, planned, rule, sizeKnown: true }
}

/** What the light rule reads of an Issue that has not started, from its events and the signals it was filed from. */
interface PlanRow {
  id: string
  filed: unknown
  settled_kind: string | null
  settled_size: string | null
  settled_spec: boolean
  moved_up: number
  hygiene_key: string | null
  unrouted: boolean
  text: string | null
}

async function planFacts(sql: SQL, ids: readonly string[]): Promise<Map<string, PlanRow>> {
  if (ids.length === 0) return new Map()
  const rows: PlanRow[] = await sql`
    SELECT i.id, f.payload AS filed,
      (SELECT s.payload->>'kind' FROM factory.issue_events s WHERE s.issue_id = i.id AND s.kind = 'settled' AND s.result = 'applied' AND s.payload->>'kind' IS NOT NULL ORDER BY s.version DESC LIMIT 1) AS settled_kind,
      (SELECT s.payload->>'size' FROM factory.issue_events s WHERE s.issue_id = i.id AND s.kind = 'settled' AND s.result = 'applied' AND s.payload->>'size' IS NOT NULL ORDER BY s.version DESC LIMIT 1) AS settled_size,
      EXISTS (SELECT 1 FROM factory.issue_events s WHERE s.issue_id = i.id AND s.kind = 'settled' AND s.result = 'applied' AND s.payload->>'checkpoint' IS NOT NULL) AS settled_spec,
      (SELECT count(*)::int FROM factory.issue_events m WHERE m.issue_id = i.id AND m.kind = 'moved_up' AND m.result = 'applied') AS moved_up,
      (SELECT key FROM factory.loop_findings WHERE issue_id = i.id AND loop = 'hygiene' ORDER BY key LIMIT 1) AS hygiene_key,
      EXISTS (SELECT 1 FROM factory.intake_door_unrouted WHERE filed_issue = i.id) AS unrouted,
      concat_ws(' ',
        (SELECT string_agg(s.title || ' ' || s.text, ' ' ORDER BY s.received_at, s.id) FROM factory.intake_signals s WHERE s.issue_id = i.id),
        (SELECT n.payload->>'text' FROM factory.issue_events n WHERE n.issue_id = i.id AND n.kind = 'noted' AND n.result = 'applied' ORDER BY n.version LIMIT 1)) AS text
    FROM factory.issues i
    JOIN factory.issue_events f ON f.issue_id = i.id AND f.kind = 'filed' AND f.version = 1
    WHERE i.id IN ${sql(ids)}`
  return new Map(rows.map((row) => [row.id, row]))
}

/**
 * The seat of each Issue's lead for the badge. An Issue whose latest `lead_started` is newer than its latest `admitted`
 * shows what that attempt started on; one waiting for its next attempt (or never started) shows the seat it will start on:
 * the last `seated`, else the filed seat, else what the light rule says for the Issue as it stands now (the table's
 * `light` row with the rule's name), else the table's `lead` row, marked `planned`. An Issue the rule does not name
 * and that has no size yet says so (`sizeKnown: false`): it may still start light once triage has sized it. A closed Issue
 * with no lead shows none. An Issue with nothing known is absent from the map.
 */
export async function readLeadSeats(
  sql: SQL,
  ids: readonly string[],
  table?: SeatTable,
): Promise<Map<string, LeadSeat>> {
  const seats = new Map<string, LeadSeat>()
  if (ids.length === 0) return seats
  const rows: EventRow[] = await sql`
    SELECT DISTINCT ON (e.issue_id, e.kind) e.issue_id, e.kind, e.version, e.payload, i.state
    FROM factory.issue_events e JOIN factory.issues i ON i.id = e.issue_id
    WHERE e.issue_id IN ${sql(ids)} AND e.result = 'applied' AND e.kind IN ('filed', 'seated', 'admitted', 'lead_started', 'moved_up')
    ORDER BY e.issue_id, e.kind, e.version DESC`
  const byIssue = new Map<string, Map<EventRow['kind'], EventRow>>()
  for (const row of rows) {
    const kinds = byIssue.get(row.issue_id) ?? new Map<EventRow['kind'], EventRow>()
    kinds.set(row.kind, row)
    byIssue.set(row.issue_id, kinds)
  }
  const lead = table ? await table.lead().catch(() => null) : null
  const unstarted: string[] = []
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
    // A seat that asked for the move-up is spent once it was moved up: the next lead starts on the rule's seat (`seatOf` in `app/leads-start.ts`).
    const spent = (named: unknown): boolean => kinds.has('moved_up') && isRecord(named) && named.moveUp === true
    const seated = kinds.get('seated')?.payload
    const filedSeat = isRecord(filed) ? filed.seat : null
    const seat = (spent(seated) ? null : seatOf(seated, true)) ?? (spent(filedSeat) ? null : seatOf(filedSeat, true))
    if (seat) seats.set(id, seat)
    else unstarted.push(id)
  }
  // What the light rule names now: the same facts and the same rule the lead's start reads (`seatOf` in `app/leads-start.ts`).
  const light = unstarted.length > 0 ? table?.light : undefined
  const facts = light ? await planFacts(sql, unstarted) : new Map<string, PlanRow>()
  const lightRow = light ? await light.row().catch(() => null) : null
  const gate = light ? await light.gate().catch(() => false) : false
  for (const id of unstarted) {
    const row = facts.get(id)
    const filed = byIssue.get(id)?.get('filed')?.payload
    const fields = isRecord(filed) ? filed : {}
    const size = row?.settled_size ?? null
    const rule =
      row && lightRow
        ? light?.rule({
            kind: row.settled_kind ?? (typeof fields.kind === 'string' ? fields.kind : 'feature'),
            size,
            spec: fields.checkpoint !== undefined || row.settled_spec,
            hygieneKey: row.hygiene_key,
            unroutedMonitor: row.unrouted,
            movedUp: row.moved_up,
            text: `${typeof fields.title === 'string' ? fields.title : ''} ${row.text ?? ''}`,
            triageSmall: size === 'small' && gate,
          })
        : null
    if (rule && lightRow) {
      seats.set(id, { ...lightRow, role: light?.role ?? 'light', planned: true, rule, sizeKnown: true })
    } else if (lead) {
      // still settling, no size yet and no rule that needs none: the seat may change once triage sized it, and the badge says
      // so. A settled Issue with no size (settled by rule, or before the size was kept) will not get one.
      const settling = byIssue.get(id)?.get('filed')?.state === 'settling'
      seats.set(id, {
        ...lead,
        role: 'lead',
        planned: true,
        rule: null,
        sizeKnown: size !== null || !settling || !light,
      })
    }
  }
  return seats
}
