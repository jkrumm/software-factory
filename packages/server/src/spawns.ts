import type { SQL } from 'bun'
import { currentLoads, latestReadings, nextReset, pickEligible } from './capacity.ts'
import type { SpawnInput } from './schemas.ts'

export type SpawnStatus = 'queued' | 'waiting' | 'starting' | 'started' | 'failed'

export interface SpawnView {
  key: string
  status: SpawnStatus
  account: string | null
  resumeAt: string | null
  attempts: number
  session: string | null
  error: string | null
}

interface SpawnRow {
  key: string
  status: SpawnStatus
  account: string | null
  resume_at: Date | null
  attempts: number
  session: string | null
  error: string | null
}

/** Serializes everything that assigns an account, so each assignment sees the ones before it. */
const CAPACITY_LOCK = 7_093_002

export const lockCapacity = (tx: SQL) => tx`SELECT pg_advisory_xact_lock(${CAPACITY_LOCK})`

export const toView = (row: SpawnRow): SpawnView => ({
  key: row.key,
  status: row.status,
  account: row.account,
  resumeAt: row.resume_at?.toISOString() ?? null,
  attempts: row.attempts,
  session: row.session,
  error: row.error,
})

export async function getSpawn(sql: SQL, key: string): Promise<SpawnView | undefined> {
  const [row]: SpawnRow[] = await sql`
    SELECT key, status, account, resume_at, attempts, session, error FROM factory.spawns WHERE key = ${key}`
  return row && toView(row)
}

export async function listSpawns(sql: SQL, limit = 200): Promise<SpawnView[]> {
  const rows: SpawnRow[] = await sql`
    SELECT key, status, account, resume_at, attempts, session, error FROM factory.spawns
    ORDER BY created_at DESC, key LIMIT ${limit}`
  return rows.map(toView)
}

/**
 * Stores a spawn. With capacity it is `queued` on an account and the next tick starts it; without, it is
 * `waiting` with `resume_at` at the first reset still ahead (none if every reading is stale: a new reading wakes it).
 * The account is chosen in the same transaction as the insert, behind the capacity lock, counting every spawn
 * already assigned against the same readings. A repeated key returns the existing row untouched.
 */
export async function createSpawn(
  sql: SQL,
  input: SpawnInput,
  now: Date,
): Promise<{ spawn: SpawnView; created: boolean }> {
  return sql.begin(async (tx) => {
    await lockCapacity(tx)
    const existing = await getSpawn(tx, input.key)
    if (existing) return { spawn: existing, created: false }

    const readings = await latestReadings(tx)
    const picked = pickEligible(readings, await currentLoads(tx, readings))
    const status: SpawnStatus = picked ? 'queued' : 'waiting'
    const resumeAt = picked ? null : (nextReset(readings, now) ?? null)

    const [row]: SpawnRow[] = await tx`
      INSERT INTO factory.spawns (key, repo, prompt, status, account, reading_id, resume_at, created_at)
      VALUES (${input.key}, ${input.repo}, ${input.prompt}, ${status}, ${picked?.account ?? null}, ${picked?.id ?? null},
              ${resumeAt}, ${now})
      RETURNING key, status, account, resume_at, attempts, session, error`
    if (!row) throw new Error(`spawn ${input.key} was not stored`)
    return { spawn: toView(row), created: true }
  })
}
