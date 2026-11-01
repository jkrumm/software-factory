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
 * Runs recorded effects, oldest first. Never inside a transaction: the attempt is committed, the port is called, the result
 * goes in a new statement. A crash between the two leaves the row open, and the next pass calls the port again under the same
 * key. A port that fails keeps the Issue's later effects for the next pass, so they stay in order.
 */
export async function runEffects(sql: SQL, ports: EffectPorts, now: () => Date): Promise<string[]> {
  const kinds = Object.keys(ports)
  if (kinds.length === 0) return []
  const rows: EffectRow[] = await sql`
    SELECT id, issue_id, key, kind, payload, attempts FROM factory.issue_effects
    WHERE done_at IS NULL AND kind IN ${sql(kinds)}
    ORDER BY id LIMIT ${BATCH}`

  const errors: string[] = []
  const stopped = new Set<number>()
  for (const row of rows) {
    if (stopped.has(row.issue_id)) continue
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
  return errors
}
