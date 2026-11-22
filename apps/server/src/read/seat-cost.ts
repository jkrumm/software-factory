import type { SQL } from 'bun'
import { percentile, per, windowOf } from './stats.ts'
import { costOfIssueAttempts, factsOf, type Fact } from './kpis-seats.ts'
import { USAGE_TIMEOUT_MS } from './usage.ts'

/** The days the seat cost reads: Issues whose first lead started in the last `SEAT_COST_DAYS` days. */
const SEAT_COST_DAYS = 7

/** One group of Issues: how many, their dollars an Issue and their median working ms (each null with none). */
export interface SeatCostGroup {
  issues: number
  costPerIssue: number | null
  medianWorkingMs: number | null
}

/** The Issues whose first lead ran on the tier asked for (`tier`), and those whose first lead ran on the lead row (`lead`). */
export interface SeatCostReading {
  tier: SeatCostGroup
  lead: SeatCostGroup
}

/**
 * The seat cost over the last `SEAT_COST_DAYS` days: dollars an Issue (every attempt counted, moved-up ones included, from the
 * usage schema) and the median working time. Null when the usage schema cannot be read; the factory's own reads are not caught.
 */
export async function readSeatCost(sql: SQL, input: { tier: string; now?: Date }): Promise<SeatCostReading | null> {
  const now = input.now ?? new Date()
  const facts = await factsOf(sql, windowOf(now, SEAT_COST_DAYS), now)
  const dollars = await costOfIssueAttempts(
    sql,
    facts.map((fact) => fact.issue_id),
    USAGE_TIMEOUT_MS,
  )
  if (dollars === null) return null
  const group = (list: readonly Fact[]): SeatCostGroup => ({
    issues: list.length,
    costPerIssue: per(
      list.reduce((sum, fact) => sum + (dollars.get(fact.issue_id) ?? 0), 0),
      list.length,
    ),
    medianWorkingMs: percentile(
      list.map((fact) => fact.working_ms),
      0.5,
    ),
  })
  return {
    tier: group(facts.filter((fact) => fact.tier === input.tier)),
    lead: group(facts.filter((fact) => fact.seat === 'lead')),
  }
}

const usd = (value: number): string => `${value.toFixed(2)} dollars`
const minutes = (ms: number): number => Math.round(ms / 60_000)
const present = (value: string | null): value is string => value !== null

/**
 * The seat cost as one line, e.g. `opus seats, last 7 days: 24.78 dollars an Issue, median 119 working minutes (59 Issues); the
 * lead row: 3.81 dollars, 40 minutes (276 Issues)`. A figure that is null is left out of its clause and a clause with no figure is
 * left out; null when no figure is left.
 */
export function seatCostLine(tier: string, cost: SeatCostReading): string | null {
  const own = [
    cost.tier.costPerIssue === null ? null : `${usd(cost.tier.costPerIssue)} an Issue`,
    cost.tier.medianWorkingMs === null ? null : `median ${minutes(cost.tier.medianWorkingMs)} working minutes`,
  ].filter(present)
  const lead = [
    cost.lead.costPerIssue === null ? null : usd(cost.lead.costPerIssue),
    cost.lead.medianWorkingMs === null ? null : `${minutes(cost.lead.medianWorkingMs)} minutes`,
  ].filter(present)
  const clauses = [
    own.length === 0
      ? null
      : `${tier} seats, last ${SEAT_COST_DAYS} days: ${own.join(', ')} (${cost.tier.issues} Issues)`,
    lead.length === 0 ? null : `the lead row: ${lead.join(', ')} (${cost.lead.issues} Issues)`,
  ].filter(present)
  return clauses.length === 0 ? null : clauses.join('; ')
}
