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

/** The most log rows the build reads: bookkeeping older than this has no effect on the model that matters (a fold of an ask long gone). */
const LOG_WINDOW = 2000

export async function readLog(sql: SQL): Promise<LogRow[]> {
  const rows: RawLog[] = await sql`
    SELECT id, kind, subject, fingerprint, what, why, evidence, payload, at, undone_at
    FROM factory.fleet_triage_log ORDER BY id DESC LIMIT ${LOG_WINDOW}`
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

export async function getAct(sql: SQL, ask: string, intent: ActIntent): Promise<ActResult | undefined> {
  if (intent === 'later') return undefined
  const [row]: { result: Omit<ActResult, 'duplicate'> }[] =
    await sql`SELECT result FROM factory.fleet_acts WHERE ask_id = ${ask} AND intent = ${intent}`
  return row ? { ...row.result, duplicate: true } : undefined
}

/** Records an act. A second of the same ask and intent (not `later`) is not stored: the first stands. */
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
    ON CONFLICT (ask_id, intent) WHERE intent <> 'later' DO NOTHING`
}
