import type { ReadAccountQuota } from '@software-factory/contract'
import type { SQL } from 'bun'

/** A reading older than this says nothing about the account now (the capacity domain's `READING_MAX_AGE_MS`). */
const READING_MAX_AGE_MS = 10 * 60_000

interface ReadingRow {
  account: string
  read_at: Date
  bulk_open: boolean
  bulk_position: number | null
  bulk_reason: string | null
  five_hour_used: number | null
  weekly_used: number | null
  five_hour_resets_at: Date | null
  weekly_resets_at: Date | null
  exhausted_until: Date | null
}

const iso = (at: Date | null): string | null => at?.toISOString() ?? null

/** The newest reading of each account, in the shape the cards carry. */
export async function readAccounts(sql: SQL, now: Date): Promise<ReadAccountQuota[]> {
  const rows: ReadingRow[] = await sql`
    SELECT DISTINCT ON (account) account, read_at, bulk_open, bulk_position, bulk_reason, five_hour_used, weekly_used,
      five_hour_resets_at, weekly_resets_at, exhausted_until
    FROM factory.capacity_readings ORDER BY account, id DESC`
  const accounts = rows.map((row) => {
    const fresh = now.getTime() - row.read_at.getTime() <= READING_MAX_AGE_MS
    const ranked = fresh && row.bulk_open && row.bulk_position !== null
    return {
      account: row.account,
      fiveHourUsed: row.five_hour_used,
      weeklyUsed: row.weekly_used,
      fiveHourResetsAt: iso(row.five_hour_resets_at),
      weeklyResetsAt: iso(row.weekly_resets_at),
      exhaustedUntil: iso(row.exhausted_until),
      fresh,
      rank: ranked ? row.bulk_position : null,
      rankReason: ranked ? row.bulk_reason : null,
    }
  })
  return accounts.sort(
    (a, b) =>
      (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || a.account.localeCompare(b.account),
  )
}
