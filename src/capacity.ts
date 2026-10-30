import type { SQL } from "bun";
import type { CapacityInput } from "./schemas.ts";

export const WEEKLY_LIMIT = 95;
export const FIVE_HOUR_LIMIT = 85;

export interface Reading {
  account: string;
  weeklyUsed: number;
  fiveHourUsed: number;
  resetsAt: Date;
}

export async function recordReading(sql: SQL, account: string, reading: CapacityInput): Promise<void> {
  await sql`
    INSERT INTO capacity_readings (account, weekly_used, five_hour_used, resets_at)
    VALUES (${account}, ${reading.weeklyUsed}, ${reading.fiveHourUsed}, ${reading.resetsAt})`;
}

/** The newest reading of every account. */
export async function latestReadings(sql: SQL): Promise<Reading[]> {
  const rows: { account: string; weekly_used: number; five_hour_used: number; resets_at: Date }[] = await sql`
    SELECT DISTINCT ON (account) account, weekly_used, five_hour_used, resets_at
    FROM capacity_readings ORDER BY account, id DESC`;
  return rows.map((r) => ({
    account: r.account,
    weeklyUsed: r.weekly_used,
    fiveHourUsed: r.five_hour_used,
    resetsAt: r.resets_at,
  }));
}

export const isEligible = (r: Reading): boolean => r.weeklyUsed < WEEKLY_LIMIT && r.fiveHourUsed < FIVE_HOUR_LIMIT;

/** The least-used eligible account. */
export function pickEligible(readings: readonly Reading[]): Reading | undefined {
  return readings
    .filter(isEligible)
    .sort((a, b) => a.weeklyUsed - b.weeklyUsed || a.account.localeCompare(b.account))[0];
}

/** The reading whose window resets first: when a spawn without capacity may try again. */
export function earliestReset(readings: readonly Reading[]): Reading | undefined {
  return [...readings].sort((a, b) => a.resetsAt.getTime() - b.resetsAt.getTime())[0];
}
