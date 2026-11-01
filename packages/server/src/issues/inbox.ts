import type { SQL } from 'bun'

export interface InboxEvent {
  issueId: number
  /** §4's key table: the same key is one row, whoever sends it how often */
  key: string
  kind: string
  at: Date
  payload?: Record<string, unknown>
}

/** Files one event for an Issue; a repeated key changes nothing. Takes a transaction, or the pool. */
export async function enqueue(sql: SQL, event: InboxEvent): Promise<{ duplicate: boolean }> {
  const rows = await sql`
    INSERT INTO factory.issue_inbox (issue_id, key, kind, at, payload)
    VALUES (${event.issueId}, ${event.key}, ${event.kind}, ${event.at}, ${event.payload ?? null})
    ON CONFLICT (key) DO NOTHING
    RETURNING id`
  return { duplicate: rows.length === 0 }
}

/**
 * A session event of a session that works on an Issue, copied into the inbox by the transaction that stores it. The key is the
 * event's, so a live post and its spool replay are one row here too.
 */
export async function copySessionEvent(
  tx: SQL,
  event: { key: string; session: string; kind: string; at: Date; payload?: Record<string, unknown> },
): Promise<void> {
  // In a SELECT the parameter has no column to take its type from, so the JSON goes in as text.
  const payload = event.payload === undefined ? null : JSON.stringify(event.payload)
  await tx`
    INSERT INTO factory.issue_inbox (issue_id, key, kind, session, at, payload)
    SELECT s.issue_id, ${event.key}, ${event.kind}, ${event.session}, ${event.at}, ${payload}::text::jsonb
    FROM factory.sessions s
    WHERE s.id = ${event.session} AND s.issue_id IS NOT NULL
    ON CONFLICT (key) DO NOTHING`
}
