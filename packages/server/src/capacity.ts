import type { SQL } from 'bun'
import { LOCKS } from './locks.ts'
import type { QuotaInput } from './schemas.ts'

/** An account takes new spawns below 85 % of its 5-hour window and below 95 % of its week: the owner's reserve. */
export const WEEKLY_LIMIT = 95
export const FIVE_HOUR_LIMIT = 85

export const WEEK_MS = 7 * 24 * 3_600_000

/** Readings older than this are deleted, except the newest of each account: the table stays small enough to scan. */
export const READINGS_KEEP_MS = WEEK_MS

/**
 * A reading the poller has not renewed for this long says nothing about the account now: a stopped poller, or an
 * account that left the registry, must not keep admitting on old numbers.
 */
export const READING_MAX_AGE_MS = 10 * 60_000

/** Serializes everything that assigns an account or changes what it sees, so each step sees the ones before it. */
export const lockCapacity = (tx: SQL) => tx`SELECT pg_advisory_xact_lock(${LOCKS.capacity})`

/** One reading per row; `id` orders them. Percentages are of the window, null is "no sample". */
export interface Reading {
  id: number
  account: string
  readAt: Date
  sampledAt: Date | null
  enabled: boolean
  authOk: boolean
  fiveHourUsed: number | null
  weeklyUsed: number | null
  fiveHourResetsAt: Date | null
  weeklyResetsAt: Date | null
  exhaustedUntil: Date | null
}

/** Spawns assigned to each account after its latest sample was taken, which therefore does not show them yet. */
export type Loads = ReadonlyMap<string, number>

interface ReadingRow {
  id: string
  account: string
  read_at: Date
  sampled_at: Date | null
  enabled: boolean
  auth_ok: boolean
  five_hour_used: number | null
  weekly_used: number | null
  five_hour_resets_at: Date | null
  weekly_resets_at: Date | null
  exhausted_until: Date | null
}

const toReading = (r: ReadingRow): Reading => ({
  id: Number(r.id),
  account: r.account,
  readAt: r.read_at,
  sampledAt: r.sampled_at,
  enabled: r.enabled,
  authOk: r.auth_ok,
  fiveHourUsed: r.five_hour_used,
  weeklyUsed: r.weekly_used,
  fiveHourResetsAt: r.five_hour_resets_at,
  weeklyResetsAt: r.weekly_resets_at,
  exhaustedUntil: r.exhausted_until,
})

export const isFresh = (r: Reading, now: Date): boolean => now.getTime() - r.readAt.getTime() <= READING_MAX_AGE_MS

/** One account's reading with the account named: what the poller and the injection route hand over. */
export type NamedQuota = QuotaInput & { account: string }

/**
 * Stores readings, one row each, and wakes every waiting spawn if one of them leaves an account with room: new
 * capacity may have appeared, so the next tick looks again instead of sleeping until `resume_at`. A wall that goes on
 * wakes nobody, so a minute of polling during a wall does not make every waiting spawn look again.
 */
export async function recordReadings(sql: SQL, readings: readonly NamedQuota[], now: Date): Promise<void> {
  if (readings.length === 0) return
  await sql.begin(async (tx) => {
    await lockCapacity(tx)
    for (const r of readings) {
      const sampledAt = r.ageS === null ? null : new Date(now.getTime() - r.ageS * 1000)
      await tx`
        INSERT INTO factory.quota_readings
          (account, read_at, sampled_at, enabled, auth_ok, five_hour_used, weekly_used, five_hour_resets_at,
           weekly_resets_at, exhausted_until)
        VALUES (${r.account}, ${now}, ${sampledAt}, ${r.enabled}, ${r.authOk}, ${r.fiveHourUsed}, ${r.weeklyUsed},
                ${r.fiveHourResetsAt}, ${r.weeklyResetsAt}, ${r.exhaustedUntil})`
      // For one release the previous server's table is still fed, so a rollback finds live readings, not frozen ones.
      const resetsAt = r.fiveHourResetsAt ?? r.weeklyResetsAt
      if (r.fiveHourUsed !== null && r.weeklyUsed !== null && resetsAt) {
        await tx`
          INSERT INTO factory.capacity_readings (account, weekly_used, five_hour_used, resets_at)
          VALUES (${r.account}, ${r.weeklyUsed}, ${r.fiveHourUsed}, ${resetsAt})`
      }
    }
    await pruneReadings(tx, now)
    const latest = await latestReadings(tx)
    if (pickEligible(latest, await currentLoads(tx, latest), { now })) await wakeWaiting(tx, now)
  })
}

async function pruneReadings(tx: SQL, now: Date): Promise<void> {
  const before = new Date(now.getTime() - READINGS_KEEP_MS)
  await tx`
    DELETE FROM factory.quota_readings
    WHERE read_at < ${before} AND id NOT IN (SELECT max(id) FROM factory.quota_readings GROUP BY account)`
  // The previous release's table has no clock: it keeps the newest hundred thousand rows.
  await tx`DELETE FROM factory.capacity_readings WHERE id < (SELECT max(id) FROM factory.capacity_readings) - 100000`
}

/** Test and ops convenience: one reading of one account. */
export const recordReading = (sql: SQL, reading: NamedQuota, now: Date): Promise<void> =>
  recordReadings(sql, [reading], now)

/** Every waiting spawn is due now: a new reading or a lifted restriction may let it start. */
export async function wakeWaiting(tx: SQL, now: Date): Promise<void> {
  await tx`UPDATE factory.spawns SET resume_at = ${now} WHERE status = 'waiting' AND (resume_at IS NULL OR resume_at > ${now})`
}

/** The newest reading of every account that ever had one. */
export async function latestReadings(sql: SQL): Promise<Reading[]> {
  const rows: ReadingRow[] = await sql`
    SELECT DISTINCT ON (account) id, account, read_at, sampled_at, enabled, auth_ok, five_hour_used, weekly_used,
           five_hour_resets_at, weekly_resets_at, exhausted_until
    FROM factory.quota_readings ORDER BY account, id DESC`
  return rows.map(toReading)
}

/**
 * Spawns that hold an account against its current reading: queued, starting or started, and assigned at or after
 * the moment its latest sample was taken. `except` leaves one spawn out, for a spawn that is re-checking its own account.
 */
export async function currentLoads(
  sql: SQL,
  readings: readonly Reading[],
  except?: string,
): Promise<Map<string, number>> {
  const rows: { account: string; assigned_at: Date }[] = await sql`
    SELECT account, assigned_at FROM factory.spawns
    WHERE status IN ('queued', 'starting', 'started') AND account IS NOT NULL AND assigned_at IS NOT NULL
      AND key IS DISTINCT FROM ${except ?? null}`
  const sampled = new Map(readings.map((r) => [r.account, r.sampledAt]))
  const loads = new Map<string, number>()
  for (const row of rows) {
    const at = sampled.get(row.account)
    if (at && row.assigned_at >= at) loads.set(row.account, (loads.get(row.account) ?? 0) + 1)
  }
  return loads
}

/** Where an account stands: open now, or closed until a time, or closed with no time anyone can name. */
export type Standing = { open: true } | { open: false; until: Date | null }

/** The share of its week an account's window has elapsed, in percent. Null when the window's end is unknown or past. */
export function elapsedWeekShare(r: Reading, now: Date): number | null {
  if (!r.weeklyResetsAt || r.weeklyResetsAt <= now) return null
  const start = r.weeklyResetsAt.getTime() - WEEK_MS
  return Math.min(100, Math.max(0, ((now.getTime() - start) / WEEK_MS) * 100))
}

/**
 * Whether an account can take a new spawn on this reading alone: enabled, auth fine, a sample (a window without a number
 * counts as unused, both without is no sample), not marked exhausted,
 * below both limits. With `pace`, also at or below the elapsed share of its week. A closed account says when it
 * opens, if the reading says so: the reset of the window that closed it (both: the later), or for pace the moment
 * the week's elapsed share reaches its use. A window whose reset is already past is a stale reading and names no time.
 */
export function standing(r: Reading, now: Date, pace = false): Standing {
  if (!r.enabled || !r.authOk || !r.sampledAt || (r.fiveHourUsed === null && r.weeklyUsed === null)) {
    return { open: false, until: null }
  }
  // A window the picker has no number for counts as unused, as the picker itself weighs it.
  const fiveHour = r.fiveHourUsed ?? 0
  const weekly = r.weeklyUsed ?? 0
  const reopens: (Date | null)[] = []
  const ahead = (at: Date | null) => (at && at > now ? at : null)
  if (r.exhaustedUntil && r.exhaustedUntil > now) reopens.push(r.exhaustedUntil)
  if (fiveHour >= FIVE_HOUR_LIMIT) reopens.push(ahead(r.fiveHourResetsAt))
  if (weekly >= WEEKLY_LIMIT) reopens.push(ahead(r.weeklyResetsAt))
  if (pace) {
    const share = elapsedWeekShare(r, now)
    if (share === null) reopens.push(null)
    else if (weekly > share && r.weeklyResetsAt) {
      reopens.push(new Date(r.weeklyResetsAt.getTime() - WEEK_MS + (weekly / 100) * WEEK_MS))
    }
  }
  if (reopens.length === 0) return { open: true }
  if (reopens.includes(null)) return { open: false, until: null }
  return { open: false, until: new Date(Math.max(...reopens.map((d) => d?.getTime() ?? 0))) }
}

export interface PickOptions {
  now: Date
  pace?: boolean
  /** an account the spawn already has: it keeps it while it is still open */
  prefer?: string | null
}

/**
 * The open account with the least weekly use, among the fresh readings. An account takes one new spawn per sample: while
 * a spawn assigned after the latest sample is not in it yet, the account is not offered again (the next poll, a minute
 * at most, shows that spawn's use). `prefer` wins while it is still open.
 */
export function pickEligible(readings: readonly Reading[], loads: Loads, options: PickOptions): Reading | undefined {
  const open = readings.filter(
    (r) => isFresh(r, options.now) && !loads.get(r.account) && standing(r, options.now, options.pace).open,
  )
  const preferred = open.find((r) => r.account === options.prefer)
  if (preferred) return preferred
  return open.sort((a, b) => (a.weeklyUsed ?? 0) - (b.weeklyUsed ?? 0) || a.account.localeCompare(b.account))[0]
}

/**
 * When a spawn without capacity may look again: the earliest time any fresh account opens, by its own reading. None
 * when no reading names one (a disabled account, a stale window): a new reading wakes the spawn.
 */
export function nextOpening(readings: readonly Reading[], options: PickOptions): Date | undefined {
  return readings
    .filter((r) => isFresh(r, options.now))
    .flatMap((r) => {
      const s = standing(r, options.now, options.pace)
      return !s.open && s.until ? [s.until] : []
    })
    .sort((a, b) => a.getTime() - b.getTime())[0]
}
