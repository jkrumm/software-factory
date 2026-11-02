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

/** New decisions in one statement; one that exists (made before, undone or not) is left as it is. */
export async function insertLog(sql: SQL, rows: readonly NewLogRow[], at: Date): Promise<void> {
  if (rows.length === 0) return
  const payload = JSON.stringify(
    rows.map((r) => ({ ...r, payload: r.payload })),
    (_k, v: unknown) => (typeof v === 'string' ? v.replaceAll('\0', '') : v),
  )
  await sql`
    INSERT INTO factory.fleet_triage_log (kind, subject, fingerprint, what, why, evidence, payload, at)
    SELECT x.kind, x.subject, x.fingerprint, x.what, x.why, x.evidence, x.payload, ${at}
    FROM jsonb_to_recordset(${payload}::text::jsonb)
      AS x(kind text, subject text, fingerprint text, what text, why text, evidence text, payload jsonb)
    ON CONFLICT (kind, subject, fingerprint) DO NOTHING`
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

/** An ask's occurrence: what the owner did is of one occurrence (`fleet_ask_seen`). */
export const occKey = (id: string, occurrence: number): string => `${id}#${occurrence}`

/** What the owner did, for the build: which asks are done with, which wait, and the hand-offs whose result is to come back. */
export interface ActState {
  /** occurrences the owner resolved, denied or handed off: gone */
  closed: ReadonlySet<string>
  /** every intent but `later` that was acted, by occurrence */
  acted: ReadonlyMap<string, ReadonlySet<ActIntent>>
  /** occurrence → when it comes back */
  later: ReadonlyMap<string, Date>
  /** hand-offs younger than a day: the spawn key and the ask it was for */
  handoffs: readonly { ask: string; spawn: string; at: string }[]
  /** a hand-off result ask (`handoff:<spawn>`) was closed in any occurrence: its worker is not looked at again */
  closedAny(id: string): boolean
}

/** A hand-off's result is looked for this long. */
export const HANDOFF_WINDOW_MS = 24 * 3_600_000

/**
 * The acts that matter to a build, in one read: those of the asks listed (every occurrence), those of hand-off result asks, and the
 * hand-offs of the last day (whose workers are looked at for their end).
 */
export async function readActs(sql: SQL, now: Date, askIds: readonly string[]): Promise<ActState> {
  const listed = JSON.stringify(askIds)
  const since = new Date(now.getTime() - HANDOFF_WINDOW_MS)
  const rows: {
    ask_id: string
    occurrence: number
    intent: ActIntent
    until: Date | null
    at: Date
    result: { spawn?: string | null }
  }[] = await sql`
    SELECT ask_id, occurrence, intent, until, at, result FROM factory.fleet_acts
    WHERE ask_id IN (SELECT jsonb_array_elements_text(${listed}::text::jsonb))
       OR ask_id IN (SELECT 'handoff:' || (result->>'spawn') FROM factory.fleet_acts WHERE intent = 'hand_off' AND at > ${since})
       OR (intent = 'hand_off' AND at > ${since})
    ORDER BY id`
  const closed = new Set<string>()
  const acted = new Map<string, Set<ActIntent>>()
  const later = new Map<string, Date>()
  const handoffs: { ask: string; spawn: string; at: string }[] = []
  for (const r of rows) {
    const key = occKey(r.ask_id, r.occurrence)
    if (r.intent === 'later') {
      if (r.until && r.until > now) later.set(key, r.until)
      else later.delete(key)
      continue
    }
    const set = acted.get(key) ?? new Set<ActIntent>()
    set.add(r.intent)
    acted.set(key, set)
    if (r.intent === 'resolve' || r.intent === 'deny' || r.intent === 'hand_off') closed.add(key)
    if (r.intent === 'hand_off' && r.result.spawn && r.at > since)
      handoffs.push({ ask: r.ask_id, spawn: r.result.spawn, at: r.at.toISOString() })
  }
  const closedIds = new Set([...closed].map((k) => k.slice(0, k.lastIndexOf('#'))))
  return { closed, acted, later, handoffs, closedAny: (id) => closedIds.has(id) }
}

/**
 * What was done with the occurrence before: the same intent again is the first one's result; an occurrence closed by another intent
 * (`resolve`, `deny` or `hand_off` are one of each) is `closedBy` what closed it.
 */
export async function getAct(
  sql: SQL,
  ask: string,
  occurrence: number,
  intent: ActIntent,
): Promise<{ same: ActResult } | { closedBy: ActIntent } | undefined> {
  if (intent === 'later') return undefined
  const rows: { intent: ActIntent; result: Omit<ActResult, 'duplicate'> }[] = await sql`
    SELECT intent, result FROM factory.fleet_acts WHERE ask_id = ${ask} AND occurrence = ${occurrence} AND intent <> 'later'`
  const same = rows.find((r) => r.intent === intent)
  if (same) return { same: { ...same.result, duplicate: true } }
  const closing = intent === 'archive_plan' ? undefined : rows.find((r) => r.intent !== 'archive_plan')
  return closing ? { closedBy: closing.intent } : undefined
}

/**
 * Records an act; `false` when it closes an occurrence already closed, or archives twice: the first stands. `later` is one row per
 * occurrence (a second `later` moves the time).
 */
export async function recordAct(
  sql: SQL,
  input: {
    ask: string
    occurrence: number
    intent: ActIntent
    note: string | null
    at: Date
    until: Date | null
    result: Omit<ActResult, 'duplicate'>
  },
): Promise<boolean> {
  const result = JSON.stringify(input.result)
  if (input.intent === 'later') {
    await sql`
      INSERT INTO factory.fleet_acts (ask_id, occurrence, intent, note, at, until, result)
      VALUES (${input.ask}, ${input.occurrence}, 'later', ${input.note}, ${input.at}, ${input.until}, ${result}::text::jsonb)
      ON CONFLICT (ask_id, occurrence) WHERE intent = 'later'
      DO UPDATE SET note = EXCLUDED.note, at = EXCLUDED.at, until = EXCLUDED.until, result = EXCLUDED.result`
    return true
  }
  const stored = await sql`
    INSERT INTO factory.fleet_acts (ask_id, occurrence, intent, note, at, until, result)
    VALUES (${input.ask}, ${input.occurrence}, ${input.intent}, ${input.note}, ${input.at}, ${input.until}, ${result}::text::jsonb)
    ON CONFLICT DO NOTHING RETURNING id`
  return stored.length > 0
}

// ---------------------------------------------------------------------------------------------------------------------
// Occurrences: when each ask was first seen, and when it left.

/** Absent this long, with nothing the owner did about it, a row is forgotten. */
const SEEN_FORGET_MS = 90 * 24 * 3_600_000

/** The occurrence each of these asks is on as the table stands (the last one, also when it has left): a repeat of an act lands on it. */
export async function readOccurrences(sql: SQL, askIds: readonly string[]): Promise<Map<string, number>> {
  const rows: { ask_id: string; occurrence: number }[] = await sql`
    SELECT ask_id, occurrence FROM factory.fleet_ask_seen
    WHERE ask_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(askIds)}::text::jsonb))`
  return new Map(rows.map((r) => [r.ask_id, r.occurrence]))
}

/** The first-seen time of every ask that is listed now (the builder restarts with these). */
export async function readSeen(sql: SQL): Promise<Map<string, string>> {
  const rows: { ask_id: string; first_seen: Date }[] =
    await sql`SELECT ask_id, first_seen FROM factory.fleet_ask_seen WHERE present`
  return new Map(rows.map((r) => [r.ask_id, r.first_seen.toISOString()]))
}

/**
 * Notes the asks this build listed. An ask new to the table is occurrence 1; one that was absent in an earlier build and is back is
 * the next occurrence with its own first-seen time; one that is listed stays. With `mayEnd` (every source answered), the asks that
 * are not listed are marked absent. Returns the occurrence of each listed ask.
 */
export async function trackSeen(
  sql: SQL,
  asks: readonly { id: string; at: string }[],
  now: Date,
  mayEnd: boolean,
): Promise<Map<string, number>> {
  const listed = JSON.stringify(asks.map((a) => a.id))
  const known: { ask_id: string; occurrence: number; present: boolean }[] = await sql`
    SELECT ask_id, occurrence, present FROM factory.fleet_ask_seen
    WHERE present OR ask_id IN (SELECT jsonb_array_elements_text(${listed}::text::jsonb))`
  const byId = new Map(known.map((k) => [k.ask_id, k]))
  const occurrences = new Map<string, number>()
  const writes: { ask_id: string; occurrence: number; first_seen: string }[] = []
  for (const ask of asks) {
    const row = byId.get(ask.id)
    if (row?.present) {
      occurrences.set(ask.id, row.occurrence)
      continue
    }
    const occurrence = row ? row.occurrence + 1 : 1
    occurrences.set(ask.id, occurrence)
    writes.push({ ask_id: ask.id, occurrence, first_seen: ask.at })
  }
  if (writes.length > 0) {
    await sql`
      INSERT INTO factory.fleet_ask_seen (ask_id, occurrence, first_seen, present, absent_at)
      SELECT x.ask_id, x.occurrence, x.first_seen::timestamptz, true, NULL
      FROM jsonb_to_recordset(${JSON.stringify(writes)}::text::jsonb) AS x(ask_id text, occurrence int, first_seen text)
      ON CONFLICT (ask_id) DO UPDATE
        SET occurrence = EXCLUDED.occurrence, first_seen = EXCLUDED.first_seen, present = true, absent_at = NULL`
  }
  if (mayEnd) {
    await sql`
      UPDATE factory.fleet_ask_seen SET present = false, absent_at = ${now}
      WHERE present AND ask_id NOT IN (SELECT jsonb_array_elements_text(${listed}::text::jsonb))`
    const forget = new Date(now.getTime() - SEEN_FORGET_MS)
    await sql`
      DELETE FROM factory.fleet_ask_seen s
      WHERE NOT s.present AND s.absent_at < ${forget}
        AND NOT EXISTS (SELECT 1 FROM factory.fleet_acts a WHERE a.ask_id = s.ask_id)`
  }
  return occurrences
}
