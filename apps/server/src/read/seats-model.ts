import type { SQL } from 'bun'
import type { Effort, SeatsModel, Tier } from '@software-factory/contract'
import { costOfIssues, reviewerCostOfIssues } from './kpis.ts'
import { readReviewerKpis } from './kpis-reviewers.ts'
import { readSeatKpis } from './kpis-seats.ts'
import { windowOf } from './stats.ts'

/**
 * The light-seat and cheap-reviewer gates' figures over the last `days` days: the seat table, the reviewer table and the two
 * tripwires that decide on them. A read of its own: the gates are a decision lane, not KPIs.
 */
export async function readSeats(
  sql: SQL,
  options: {
    now: Date
    days: number
    usageTimeoutMs?: number
    /** the role table's reviewer rows, for the words beside the reviewer numbers; absent: the numbers stand alone */
    reviewerRows?: { cheap: { tier: Tier; effort: Effort }; reviewer: { tier: Tier; effort: Effort } } | null
  },
): Promise<SeatsModel> {
  const w = windowOf(options.now, options.days)
  return {
    at: options.now.toISOString(),
    days: options.days,
    window: { from: w.from.toISOString(), to: w.to.toISOString() },
    seats: await readSeatKpis(sql, w, {
      now: options.now,
      cost: (issues) => costOfIssues(sql, issues, options.usageTimeoutMs),
      ...(options.usageTimeoutMs === undefined ? {} : { usageTimeoutMs: options.usageTimeoutMs }),
    }),
    reviewers: await readReviewerKpis(sql, w, {
      now: options.now,
      table: { cheap: options.reviewerRows?.cheap ?? null, reviewer: options.reviewerRows?.reviewer ?? null },
      cost: (issues) => reviewerCostOfIssues(sql, issues, options.usageTimeoutMs),
    }),
  }
}
