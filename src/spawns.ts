import type { SQL } from "bun";
import { earliestReset, latestReadings, pickEligible } from "./capacity.ts";
import type { SpawnInput } from "./schemas.ts";

export type SpawnStatus = "queued" | "waiting" | "started" | "failed";

export interface SpawnView {
  key: string;
  status: SpawnStatus;
  account: string | null;
  resumeAt: string | null;
  attempts: number;
  session: string | null;
}

interface SpawnRow {
  key: string;
  status: SpawnStatus;
  account: string | null;
  resume_at: Date | null;
  attempts: number;
  session: string | null;
}

export const toView = (row: SpawnRow): SpawnView => ({
  key: row.key,
  status: row.status,
  account: row.account,
  resumeAt: row.resume_at?.toISOString() ?? null,
  attempts: row.attempts,
  session: row.session,
});

export async function getSpawn(sql: SQL, key: string): Promise<SpawnView | undefined> {
  const [row]: SpawnRow[] = await sql`
    SELECT key, status, account, resume_at, attempts, session FROM spawns WHERE key = ${key}`;
  return row && toView(row);
}

/**
 * Stores a spawn. With capacity it is `queued` on an account and the next tick starts it; without, it is
 * `waiting` with `resume_at` at the earliest reset. A repeated key returns the existing row untouched.
 */
export async function createSpawn(
  sql: SQL,
  input: SpawnInput,
  now: Date,
): Promise<{ spawn: SpawnView; created: boolean }> {
  const readings = await latestReadings(sql);
  const account = pickEligible(readings)?.account ?? null;
  const status: SpawnStatus = account ? "queued" : "waiting";
  const resumeAt = account ? null : (earliestReset(readings)?.resetsAt ?? null);

  const inserted: SpawnRow[] = await sql`
    INSERT INTO spawns (key, repo, prompt, status, account, resume_at, created_at)
    VALUES (${input.key}, ${input.repo}, ${input.prompt}, ${status}, ${account}, ${resumeAt}, ${now})
    ON CONFLICT (key) DO NOTHING
    RETURNING key, status, account, resume_at, attempts, session`;
  const row = inserted[0];
  if (row) return { spawn: toView(row), created: true };

  const existing = await getSpawn(sql, input.key);
  if (!existing) throw new Error(`spawn ${input.key} vanished after conflict`);
  return { spawn: existing, created: false };
}
