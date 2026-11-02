import type { ActIntent, ActResult, TriageEntry, TriageKind } from '@software-factory/contract'
import type { SQL } from 'bun'

/** The triage's rows (migration `024`): what it did on its own, and what the owner did with an ask. Short statements, no transaction held over a port. */

export interface LogRow {
  id: number
  kind: TriageKind
  subject: string
  fingerprint: string
  what: string
  why: string
  evidence: string
  payload: Record<string, unknown>
  at: string
  undoneAt: string | null
}

export interface NewLogRow {
  kind: TriageKind
  subject: string
  fingerprint: string
  what: string
  why: string
  evidence: string
  payload: Record<string, unknown>
}

interface RawLog {
  id: string
  kind: TriageKind
  subject: string
  fingerprint: string
  what: string
  why: string
  evidence: string
  payload: Record<string, unknown>
  at: Date
  undone_at: Date | null
}

const toRow = (r: RawLog): LogRow => ({
  id: Number(r.id),
  kind: r.kind,
  subject: r.subject,
  fingerprint: r.fingerprint,
  what: r.what,
  why: r.why,
  evidence: r.evidence,
  payload: r.payload,
  at: r.at.toISOString(),
  undoneAt: r.undone_at?.toISOString() ?? null,
})

/**
 * Every row that has an effect on the model, however old: a fold or a dismissal that stands, and a stale mark the owner undid.
 * (A stale mark that stands changes nothing, an undone fold or dismissal neither.) The log's display is bounded by `listEntries`, this is not.
 */
export async function readLog(sql: SQL): Promise<LogRow[]> {
  const rows: RawLog[] = await sql`
    SELECT id, kind, subject, fingerprint, what, why, evidence, payload, at, undone_at
    FROM factory.fleet_triage_log
    WHERE (kind IN ('fold', 'dismiss_note') AND undone_at IS NULL) OR (kind = 'plan_stale' AND undone_at IS NOT NULL)
    ORDER BY id`
  return rows.map(toRow)
}

/** New decisions; one that exists (made before, undone or not) is left as it is. Returns the rows that were made. */
export async function insertLog(sql: SQL, rows: readonly NewLogRow[], at: Date): Promise<LogRow[]> {
  const made: LogRow[] = []
  for (const r of rows) {
    const inserted: RawLog[] = await sql`
      INSERT INTO factory.fleet_triage_log (kind, subject, fingerprint, what, why, evidence, payload, at)
      VALUES (${r.kind}, ${r.subject}, ${r.fingerprint}, ${r.what}, ${r.why}, ${r.evidence}, ${JSON.stringify(r.payload)}::text::jsonb, ${at})
      ON CONFLICT (kind, subject, fingerprint) DO NOTHING
      RETURNING id, kind, subject, fingerprint, what, why, evidence, payload, at, undone_at`
    for (const row of inserted) made.push(toRow(row))
  }
  return made
}

export const toEntry = (r: LogRow): TriageEntry => ({
  id: r.id,
  kind: r.kind,
  subject: r.subject,
  what: r.what,
  why: r.why,
  evidence: r.evidence,
  at: r.at,
  undoneAt: r.undoneAt,
})

export async function listEntries(sql: SQL, limit = 100): Promise<TriageEntry[]> {
  const rows: RawLog[] = await sql`
    SELECT id, kind, subject, fingerprint, what, why, evidence, payload, at, undone_at
    FROM factory.fleet_triage_log ORDER BY id DESC LIMIT ${limit}`
  return rows.map((r) => toEntry(toRow(r)))
}

/** `unknown`: no such row. A row already undone answers `duplicate`, with its first undo time. */
export async function undoEntry(
  sql: SQL,
  id: number,
  at: Date,
): Promise<{ entry: TriageEntry; duplicate: boolean } | undefined> {
  const done: RawLog[] = await sql`
    UPDATE factory.fleet_triage_log SET undone_at = ${at} WHERE id = ${id} AND undone_at IS NULL
    RETURNING id, kind, subject, fingerprint, what, why, evidence, payload, at, undone_at`
  const [first] = done
  if (first) return { entry: toEntry(toRow(first)), duplicate: false }
  const [existing]: RawLog[] = await sql`
    SELECT id, kind, subject, fingerprint, what, why, evidence, payload, at, undone_at
    FROM factory.fleet_triage_log WHERE id = ${id}`
  return existing ? { entry: toEntry(toRow(existing)), duplicate: true } : undefined
}

/** What the owner did, for the build: which asks are done with, which wait, and the hand-offs whose result is to come back. */
export interface ActState {
  /** asks the owner resolved, denied or handed off: gone for good (an id is one occurrence) */
  closed: ReadonlySet<string>
  /** every intent but `later` that was acted, by ask */
  acted: ReadonlyMap<string, ReadonlySet<ActIntent>>
  /** ask → when it comes back */
  later: ReadonlyMap<string, Date>
  /** hand-offs: the spawn key and the ask it was for */
  handoffs: readonly { ask: string; spawn: string; at: string }[]
}

export async function readActs(sql: SQL, now: Date): Promise<ActState> {
  const rows: { ask_id: string; intent: ActIntent; until: Date | null; at: Date; result: { spawn?: string | null } }[] =
    await sql`SELECT ask_id, intent, until, at, result FROM factory.fleet_acts ORDER BY id`
  const closed = new Set<string>()
  const acted = new Map<string, Set<ActIntent>>()
  const later = new Map<string, Date>()
  const handoffs: { ask: string; spawn: string; at: string }[] = []
  for (const r of rows) {
    if (r.intent === 'later') {
      if (r.until && r.until > now) later.set(r.ask_id, r.until)
      else later.delete(r.ask_id)
      continue
    }
    const set = acted.get(r.ask_id) ?? new Set<ActIntent>()
    set.add(r.intent)
    acted.set(r.ask_id, set)
    if (r.intent === 'resolve' || r.intent === 'deny' || r.intent === 'hand_off') closed.add(r.ask_id)
    if (r.intent === 'hand_off' && r.result.spawn)
      handoffs.push({ ask: r.ask_id, spawn: r.result.spawn, at: r.at.toISOString() })
  }
  return { closed, acted, later, handoffs }
}

/**
 * What was done with the ask before: the same intent again is the first one's result; an ask closed by another intent
 * (`resolve`, `deny` or `hand_off` are one of each ask) is `closed` with what closed it.
 */
export async function getAct(
  sql: SQL,
  ask: string,
  intent: ActIntent,
): Promise<{ same: ActResult } | { closedBy: ActIntent } | undefined> {
  if (intent === 'later') return undefined
  const rows: { intent: ActIntent; result: Omit<ActResult, 'duplicate'> }[] =
    await sql`SELECT intent, result FROM factory.fleet_acts WHERE ask_id = ${ask} AND intent <> 'later'`
  const same = rows.find((r) => r.intent === intent)
  if (same) return { same: { ...same.result, duplicate: true } }
  const closing = intent === 'archive_plan' ? undefined : rows.find((r) => r.intent !== 'archive_plan')
  return closing ? { closedBy: closing.intent } : undefined
}

/** Records an act. One that closes an ask already closed, or a second archive, is not stored: the first stands. */
export async function recordAct(
  sql: SQL,
  input: {
    ask: string
    intent: ActIntent
    note: string | null
    at: Date
    until: Date | null
    result: Omit<ActResult, 'duplicate'>
  },
): Promise<void> {
  await sql`
    INSERT INTO factory.fleet_acts (ask_id, intent, note, at, until, result)
    VALUES (${input.ask}, ${input.intent}, ${input.note}, ${input.at}, ${input.until}, ${JSON.stringify(input.result)}::text::jsonb)
    ON CONFLICT DO NOTHING`
}
