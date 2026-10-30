import type { SQL } from 'bun'
import type { CapacityInput } from './schemas.ts'

export const WEEKLY_LIMIT = 95
export const FIVE_HOUR_LIMIT = 85

/** What one spawn is assumed to cost its account, in percentage points, until a newer reading shows the real use. */
export const SPAWN_COST = { weekly: 1, fiveHour: 5 } as const

/** Serializes everything that assigns an account or changes what it sees, so each step sees the ones before it. */
const CAPACITY_LOCK = 7_093_002

export const lockCapacity = (tx: SQL) => tx`SELECT pg_advisory_xact_lock(${CAPACITY_LOCK})`

/** One reading per row; `id` orders them, so "the same reading" is an id, not a clock comparison. */
export interface Reading {
  id: number
  account: string
  weeklyUsed: number
  fiveHourUsed: number
  resetsAt: Date
}

/** Spawns assigned to each account since its latest reading, which therefore does not show them yet. */
export type Loads = ReadonlyMap<string, number>

/**
 * Stores a reading and wakes every waiting spawn: new capacity may have appeared, so the next tick looks again
 * instead of sleeping until `resume_at`.
 */
export async function recordReading(sql: SQL, account: string, reading: CapacityInput, now: Date): Promise<void> {
  await sql.begin(async (tx) => {
    await lockCapacity(tx)
    await tx`
      INSERT INTO factory.capacity_readings (account, weekly_used, five_hour_used, resets_at)
      VALUES (${account}, ${reading.weeklyUsed}, ${reading.fiveHourUsed}, ${reading.resetsAt})`
    await tx`
      UPDATE factory.spawns SET resume_at = ${now}
      WHERE status = 'waiting' AND (resume_at IS NULL OR resume_at > ${now})`
  })
}

/** The newest reading of every account. */
export async function latestReadings(sql: SQL): Promise<Reading[]> {
  const rows: { id: string; account: string; weekly_used: number; five_hour_used: number; resets_at: Date }[] =
    await sql`
    SELECT DISTINCT ON (account) id, account, weekly_used, five_hour_used, resets_at
    FROM factory.capacity_readings ORDER BY account, id DESC`
  return rows.map((r) => ({
    id: Number(r.id),
    account: r.account,
    weeklyUsed: r.weekly_used,
    fiveHourUsed: r.five_hour_used,
    resetsAt: r.resets_at,
  }))
}

/**
 * Spawns that hold an account against its current reading: queued, starting or started since that reading was
 * taken. `except` leaves one spawn out, for a spawn that is re-checking its own account.
 */
export async function currentLoads(
  sql: SQL,
  readings: readonly Reading[],
  except?: string,
): Promise<Map<string, number>> {
  const rows: { account: string; reading_id: string; n: number }[] = await sql`
    SELECT account, reading_id, count(*)::int AS n FROM factory.spawns
    WHERE status IN ('queued', 'starting', 'started') AND account IS NOT NULL AND key IS DISTINCT FROM ${except ?? null}
    GROUP BY account, reading_id`
  const latest = new Map(readings.map((r) => [r.account, r.id]))
  const loads = new Map<string, number>()
  for (const row of rows) {
    if (latest.get(row.account) === Number(row.reading_id)) loads.set(row.account, row.n)
  }
  return loads
}

export function isEligible(r: Reading, load = 0): boolean {
  return (
    r.weeklyUsed + load * SPAWN_COST.weekly < WEEKLY_LIMIT &&
    r.fiveHourUsed + load * SPAWN_COST.fiveHour < FIVE_HOUR_LIMIT
  )
}

/** The eligible account with the least projected weekly use; `prefer` wins while it is still eligible. */
export function pickEligible(readings: readonly Reading[], loads: Loads, prefer?: string | null): Reading | undefined {
  const eligible = readings.filter((r) => isEligible(r, loads.get(r.account) ?? 0))
  const preferred = eligible.find((r) => r.account === prefer)
  if (preferred) return preferred
  const projected = (r: Reading) => r.weeklyUsed + (loads.get(r.account) ?? 0) * SPAWN_COST.weekly
  return eligible.sort((a, b) => projected(a) - projected(b) || a.account.localeCompare(b.account))[0]
}

/** When a spawn without capacity may look again: the first reset still ahead. A reset in the past is a stale reading. */
export function nextReset(readings: readonly Reading[], now: Date): Date | undefined {
  return readings
    .map((r) => r.resetsAt)
    .filter((at) => at > now)
    .sort((a, b) => a.getTime() - b.getTime())[0]
}
