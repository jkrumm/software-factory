import type { SQL } from "bun";
import type { EVENT_KINDS, EventInput } from "./schemas.ts";

export type EventKind = (typeof EVENT_KINDS)[number];
export type SessionState = "starting" | "working" | "idle" | "walled" | "dead";

export interface SessionView {
  id: string;
  state: SessionState;
  lastEventAt: string;
}

/** Stores an event. A repeated `key` changes nothing and reports `duplicate: true`. */
export async function recordEvent(sql: SQL, event: EventInput): Promise<{ duplicate: boolean }> {
  const payload = event.payload === undefined ? null : JSON.stringify(event.payload);
  const rows = await sql`
    INSERT INTO events (key, session, kind, at, payload)
    VALUES (${event.key}, ${event.session}, ${event.kind}, ${event.at}, ${payload}::jsonb)
    ON CONFLICT (key) DO NOTHING
    RETURNING id`;
  return { duplicate: rows.length === 0 };
}

/**
 * State is a pure function of the ordered events, never stored. The latest event decides, except that
 * `session_ended` is terminal: a spool replay can deliver an earlier-stamped event after it.
 */
export function deriveState(kinds: readonly EventKind[]): SessionState | undefined {
  if (kinds.length === 0) return undefined;
  if (kinds.includes("session_ended")) return "dead";
  switch (kinds[kinds.length - 1]) {
    case "session_started":
      return "starting";
    case "turn_started":
      return "working";
    case "limit_stop":
      return "walled";
    default:
      return "idle";
  }
}

export async function getSession(sql: SQL, id: string): Promise<SessionView | undefined> {
  // Event time first, insertion order second: a replay delivers late.
  const rows: { kind: EventKind; at: Date }[] = await sql`
    SELECT kind, at FROM events WHERE session = ${id} ORDER BY at, id`;
  const state = deriveState(rows.map((r) => r.kind));
  const last = rows[rows.length - 1];
  if (!state || !last) return undefined;
  return { id, state, lastEventAt: last.at.toISOString() };
}
