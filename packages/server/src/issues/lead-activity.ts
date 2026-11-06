import type { SQL } from 'bun'

/**
 * Background work of a lead, from stored facts only. The hook stores no subagent event, but a `Stop` with background work still in flight
 * is stored as `turn_ended` with `backgroundTasks: true` (`cli/src/hook.ts`). A lead whose latest event is that one is waiting on a
 * subagent, a shell or a monitor that wakes it when it ends: it is not silent. Any later event (a new turn, a plain stop) ends it.
 * The silent cause of the steward and the health line's "no hook event" both read this.
 */
export async function leadsOnBackgroundWork(sql: SQL): Promise<Set<number>> {
  const rows: { id: number }[] = await sql`
    SELECT i.id FROM factory.issues i
    WHERE i.state = 'working' AND (
      SELECT v.kind = 'turn_ended' AND v.payload->>'backgroundTasks' = 'true'
      FROM factory.events v WHERE v.session = 'lead-' || i.id || '-' || i.attempt ORDER BY v.at DESC, v.id DESC LIMIT 1
    ) IS TRUE`
  return new Set(rows.map((row) => row.id))
}
