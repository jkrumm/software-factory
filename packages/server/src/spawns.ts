import type { Effort, HoldReason, Spawn, SpawnStatus, Tier } from '@software-factory/contract'
import type { SQL } from 'bun'
import { admit, HOLD_RECHECK_MS } from './admission.ts'
import { lockCapacity } from './capacity.ts'

export type SpawnView = Spawn

interface SpawnRow {
  key: string
  status: SpawnStatus
  role: string
  tier: Tier
  effort: Effort
  hold: HoldReason | null
  account: string | null
  resume_at: Date | null
  attempts: number
  session: string | null
  error: string | null
  parent: string | null
}

export const toView = (row: SpawnRow): SpawnView => ({
  key: row.key,
  status: row.status,
  role: row.role,
  tier: row.tier,
  effort: row.effort,
  hold: row.hold,
  account: row.account,
  resumeAt: row.resume_at?.toISOString() ?? null,
  attempts: row.attempts,
  session: row.session,
  error: row.error,
  parent: row.parent,
})

export async function getSpawn(sql: SQL, key: string): Promise<SpawnView | undefined> {
  const [row]: SpawnRow[] = await sql`
    SELECT key, status, role, tier, effort, hold, account, resume_at, attempts, session, error, parent FROM factory.spawns WHERE key = ${key}`
  return row && toView(row)
}

export async function listSpawns(sql: SQL, limit = 200): Promise<SpawnView[]> {
  const rows: SpawnRow[] = await sql`
    SELECT key, status, role, tier, effort, hold, account, resume_at, attempts, session, error, parent FROM factory.spawns
    ORDER BY created_at DESC, key LIMIT ${limit}`
  return rows.map(toView)
}

/** A spawn as it is stored: the role has been looked up, so its tier and effort are the table's of that moment. */
export interface NewSpawn {
  key: string
  repo: string
  prompt: string
  role: string
  tier: Tier
  effort: Effort
  /** the session that asked for it */
  parent?: string | null
}

/**
 * Stores a spawn, always `queued` or `waiting`, never dropped. Admission decides in the same transaction as the insert,
 * behind the capacity lock: with room it is `queued` on an account and the next tick starts it; held by the queue state
 * or the one-wave-per-repo rule it is `queued` with its reason and no account; without capacity it is `waiting` with
 * `resume_at` at the first opening (none if no reading names one: a new reading wakes it). A repeated key returns the
 * existing row untouched.
 */
export async function createSpawn(
  sql: SQL,
  input: NewSpawn,
  now: Date,
): Promise<{ spawn: SpawnView; created: boolean }> {
  return sql.begin(async (tx) => {
    await lockCapacity(tx)
    const existing = await getSpawn(tx, input.key)
    if (existing) return { spawn: existing, created: false }

    const decision = await admit(tx, { key: input.key, repo: input.repo, role: input.role }, now)
    const status: SpawnStatus = decision.kind === 'wait' ? 'waiting' : 'queued'
    const account = decision.kind === 'start' ? decision.account : null
    const hold = decision.kind === 'hold' ? decision.reason : null
    const resumeAt =
      decision.kind === 'wait'
        ? decision.resumeAt
        : decision.kind === 'hold'
          ? new Date(now.getTime() + HOLD_RECHECK_MS)
          : null

    const [row]: SpawnRow[] = await tx`
      INSERT INTO factory.spawns (key, repo, prompt, role, tier, effort, status, account, assigned_at, hold, resume_at, created_at, parent)
      VALUES (${input.key}, ${input.repo}, ${input.prompt}, ${input.role}, ${input.tier}, ${input.effort}, ${status},
              ${account}, ${account ? now : null}, ${hold}, ${resumeAt}, ${now}, ${input.parent ?? null})
      RETURNING key, status, role, tier, effort, hold, account, resume_at, attempts, session, error, parent`
    if (!row) throw new Error(`spawn ${input.key} was not stored`)
    return { spawn: toView(row), created: true }
  })
}

/**
 * Puts a `failed` spawn back in the queue with a fresh retry budget: the next tick picks an account and starts it.
 * Anything else is left alone (`not_failed`), so a double click or a replay changes nothing.
 */
export async function requeueSpawn(
  sql: SQL,
  key: string,
): Promise<{ spawn: SpawnView } | { problem: 'unknown' | 'not_failed'; status?: SpawnStatus }> {
  const [row]: SpawnRow[] = await sql`
    UPDATE factory.spawns
    SET status = 'queued', attempts = 0, error = NULL, claimed_at = NULL, resume_at = NULL, first_claimed_at = NULL,
        hold = NULL, assigned_at = NULL
    WHERE key = ${key} AND status = 'failed'
    RETURNING key, status, role, tier, effort, hold, account, resume_at, attempts, session, error, parent`
  if (row) return { spawn: toView(row) }
  const current = await getSpawn(sql, key)
  return current ? { problem: 'not_failed', status: current.status } : { problem: 'unknown' }
}
