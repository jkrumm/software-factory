import type { SQL } from 'bun'

export type EffectKind = 'start_lead' | 'note_lead' | 'verify' | 'finalize'

export interface Effect {
  id: number
  issueId: number
  /** `<kind>:<inbox key>`: what a port keys its own work on, so a call repeated after a crash finds it done */
  key: string
  kind: EffectKind
  payload: Record<string, unknown> | null
  attempts: number
}

/**
 * The ports an Issue's effects go through, by kind. An effect whose kind has no port yet stays recorded and undone: the wave
 * that brings the port (W3 the lead, W4 verify and finalize) runs what waited.
 */
export type EffectPorts = Partial<Record<EffectKind, (effect: Effect) => Promise<void>>>

interface EffectRow {
  id: string
  issue_id: number
  key: string
  kind: EffectKind
  payload: Record<string, unknown> | null
  attempts: number
}

const BATCH = 20

/**
 * Runs recorded effects: of each Issue only the oldest open one, whatever its kind, so an effect never overtakes an earlier one
 * that has no port yet; a close cancels what it makes pointless, so `finalize` waits behind nothing. The least tried go first, so Issues whose port keeps failing leave room for the rest. Never inside a
 * transaction: the attempt is committed, the port is called, the result goes in a new statement. A crash between the two leaves
 * the row open, and the next pass calls the port again under the same key. A port that fails ends its Issue's turn for this pass.
 * One caller at a time: the tick, which the one server never overlaps.
 */
export async function runEffects(sql: SQL, ports: EffectPorts, now: () => Date): Promise<string[]> {
  const kinds = Object.keys(ports)
  if (kinds.length === 0) return []
  const errors: string[] = []
  const stopped = new Set<number>()
  let budget = BATCH
  while (budget > 0) {
    const rows: EffectRow[] = await sql`
      SELECT * FROM (
        SELECT DISTINCT ON (issue_id) id, issue_id, key, kind, payload, attempts
        FROM factory.issue_effects
        WHERE done_at IS NULL AND cancelled_at IS NULL AND issue_id NOT IN ${sql([0, ...stopped])}
        ORDER BY issue_id, id
      ) head
      WHERE kind IN ${sql(kinds)}
      ORDER BY attempts, id
      LIMIT ${budget}`
    if (rows.length === 0) break
    budget -= rows.length
    for (const row of rows) {
      const attempts = row.attempts + 1
      await sql`UPDATE factory.issue_effects SET attempts = ${attempts} WHERE id = ${row.id}`
      try {
        await ports[row.kind]?.({
          id: Number(row.id),
          issueId: row.issue_id,
          key: row.key,
          kind: row.kind,
          payload: row.payload,
          attempts,
        })
        await sql`UPDATE factory.issue_effects SET done_at = ${now()}, error = NULL WHERE id = ${row.id}`
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        stopped.add(row.issue_id)
        errors.push(`${row.key}: ${message}`)
        await sql`UPDATE factory.issue_effects SET error = ${message} WHERE id = ${row.id}`
      }
    }
  }
  return errors
}
