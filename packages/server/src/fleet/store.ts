import { Fleet } from '@software-factory/contract'
import type { SQL } from 'bun'

/** The one stored snapshot, parsed through the contract; `undefined` before the first build, or for a row an older release wrote. */
export async function readSnapshot(sql: SQL): Promise<Fleet | undefined> {
  const [row]: { model: unknown }[] = await sql`SELECT model FROM factory.fleet_snapshot WHERE id = 1`
  if (!row) return undefined
  const parsed = Fleet.safeParse(row.model)
  return parsed.success ? parsed.data : undefined
}

/**
 * Replaces the snapshot and, when the fingerprint is not the stored one, sends `NOTIFY fleet, '<fingerprint>'` with the commit.
 * One short transaction of its own: nothing is read or called inside it. Returns whether the model changed.
 */
export async function writeSnapshot(sql: SQL, model: Fleet): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [previous]: { fingerprint: string }[] =
      await tx`SELECT fingerprint FROM factory.fleet_snapshot WHERE id = 1 FOR UPDATE`
    await tx`
      INSERT INTO factory.fleet_snapshot (id, model, fingerprint, built_at)
      VALUES (1, ${JSON.stringify(model)}::text::jsonb, ${model.fingerprint}, ${model.builtAt})
      ON CONFLICT (id) DO UPDATE SET model = EXCLUDED.model, fingerprint = EXCLUDED.fingerprint, built_at = EXCLUDED.built_at`
    const changed = previous?.fingerprint !== model.fingerprint
    if (changed) await tx`SELECT pg_notify('fleet', ${model.fingerprint})`
    return changed
  })
}
