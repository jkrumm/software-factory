import type { SQL } from 'bun'

/** The events that move the queue: an Issue enters it, leaves it for a lead, comes back or ends. */
const MOVES = ['filed', 'settled', 'admitted', 'lead_gone', 'closed', 'cancelled', 'reopened']

/** When the queue last changed, from the Issues' own events; null while there is none. `/health`'s `queueMovedAt`. */
export async function queueMovedAt(sql: SQL): Promise<Date | null> {
  const [row] = await sql`
    SELECT max(at) AS at FROM factory.issue_events WHERE result = 'applied' AND kind IN ${sql(MOVES)}`
  return row?.at instanceof Date ? row.at : null
}
