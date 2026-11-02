import type { SQL } from 'bun'

/**
 * A port throws this when the work is not done yet and nothing went wrong (a worktree being made): the effect stays open and is
 * asked again next pass, with no error recorded, and the Issue's later effects wait behind it.
 */
export class Waiting extends Error {}

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
 * The ports an Issue's effects go through, by kind. An effect whose kind has no port stays recorded and undone.
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
 * Runs recorded effects: of each Issue only the oldest open one, whatever its kind, so an effect never overtakes an earlier one, but for
 * `verify`, which runs for minutes on a line of its own: a note reaches the lead while the check runs. An effect never overtakes one
 * that has no port (but for `verify` and `finalize`, which hold nothing back without one); a close cancels what it makes pointless, so `finalize` waits behind nothing, and a new attempt's `start_lead` waits behind the last attempt's `finalize`. The least tried go first, so Issues whose port keeps failing leave room for the rest. Never inside a
 * transaction: the attempt is committed, the port is called, the result goes in a new statement. A crash between the two leaves
 * the row open, and the next pass calls the port again under the same key. A port that fails ends its Issue's turn for this pass.
 * One caller at a time: the tick, which the one server never overlaps.
 */
export async function runEffects(sql: SQL, ports: EffectPorts, now: () => Date): Promise<string[]> {
  const kinds = Object.keys(ports)
  if (kinds.length === 0) return []
  // A check or a cleanup with no port holds nobody back: the lead is still told of an answer or a regression, and a reopened Issue
  // still gets its next lead.
  const unported = (['verify', 'finalize'] as const).filter((kind) => !(kind in ports))
  const errors: string[] = []
  const stopped = new Set<number>()
  let budget = BATCH
  while (budget > 0) {
    const rows: EffectRow[] = await sql`
      SELECT * FROM (
        SELECT DISTINCT ON (issue_id, kind = 'verify') id, issue_id, key, kind, payload, attempts
        FROM factory.issue_effects
        WHERE done_at IS NULL AND cancelled_at IS NULL AND issue_id NOT IN ${sql([0, ...stopped])}
          AND kind NOT IN ${sql(['-', ...unported])}
        ORDER BY issue_id, kind = 'verify', id
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
        if (error instanceof Waiting) {
          // Not a try: `attempts` is what the owner's line counts failures by, and a check that runs for minutes would read as stuck.
          await sql`UPDATE factory.issue_effects SET attempts = ${row.attempts} WHERE id = ${row.id}`
          stopped.add(row.issue_id)
          continue
        }
        const message = error instanceof Error ? error.message : String(error)
        stopped.add(row.issue_id)
        errors.push(`${row.key}: ${message}`)
        await sql`UPDATE factory.issue_effects SET error = ${message} WHERE id = ${row.id}`
      }
    }
  }
  return errors
}
