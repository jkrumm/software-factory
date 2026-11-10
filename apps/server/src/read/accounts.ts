import type { ReadAccountQuota } from '@software-factory/contract'
import type { SQL } from 'bun'
import * as z from 'zod'

/** A reading older than this says nothing about the account now (the capacity domain's `READING_MAX_AGE_MS`). */
const READING_MAX_AGE_MS = 10 * 60_000

/** The lane whose rank orders new leads (the capacity domain's `RANK_LANE`). */
const RANK_LANE = 'bulk'

interface ReadingRow {
  account: string
  read_at: Date
  five_hour_used: number | null
  weekly_used: number | null
  five_hour_resets_at: Date | null
  weekly_resets_at: Date | null
  exhausted_until: Date | null
}

const RankRow = z.object({
  lane: z.string(),
  read_at: z.date(),
  picked_at: z.date(),
  // the driver hands jsonb back as text
  ordering: z.preprocess(
    (v) => (typeof v === 'string' ? JSON.parse(v) : v),
    z.array(z.object({ account: z.string(), reason: z.string(), weight: z.number().nullable() })),
  ),
})

export interface StoredRank {
  lane: string
  at: Date
  readAt: Date
  fresh: boolean
  order: { account: string; reason: string; weight: number | null }[]
}

/** The picker's stored rank for the factory's lane; null when none was ever read. */
export async function readRank(sql: SQL, now: Date): Promise<StoredRank | null> {
  const [raw] = await sql`
    SELECT lane, read_at, picked_at, ordering FROM factory.capacity_ranks WHERE lane = ${RANK_LANE}`
  if (!raw) return null
  const row = RankRow.parse(raw)
  return {
    lane: row.lane,
    at: row.picked_at,
    readAt: row.read_at,
    fresh: now.getTime() - row.read_at.getTime() <= READING_MAX_AGE_MS,
    order: row.ordering,
  }
}

const iso = (at: Date | null): string | null => at?.toISOString() ?? null

/** The newest reading of each account, in the shape the cards carry. */
export async function readAccounts(sql: SQL, now: Date): Promise<ReadAccountQuota[]> {
  const rank = await readRank(sql, now)
  const rows: ReadingRow[] = await sql`
    SELECT DISTINCT ON (account) account, read_at, five_hour_used, weekly_used, five_hour_resets_at,
      weekly_resets_at, exhausted_until
    FROM factory.capacity_readings ORDER BY account, id DESC`
  const position = (account: string): number => (rank?.fresh ? rank.order.findIndex((r) => r.account === account) : -1)
  const accounts = rows.map((row) => ({
    account: row.account,
    fiveHourUsed: row.five_hour_used,
    weeklyUsed: row.weekly_used,
    fiveHourResetsAt: iso(row.five_hour_resets_at),
    weeklyResetsAt: iso(row.weekly_resets_at),
    exhaustedUntil: iso(row.exhausted_until),
    fresh: now.getTime() - row.read_at.getTime() <= READING_MAX_AGE_MS,
    rank: position(row.account) < 0 ? null : position(row.account) + 1,
    rankReason: rank?.fresh ? (rank.order[position(row.account)]?.reason ?? null) : null,
  }))
  return accounts.sort(
    (a, b) =>
      (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || a.account.localeCompare(b.account),
  )
}
