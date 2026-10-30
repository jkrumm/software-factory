import type { SQL } from "bun";
import { earliestReset, latestReadings, pickEligible, type Reading } from "./capacity.ts";
import type { Clock } from "./clock.ts";
import { RunnerError, type Runner } from "./runner.ts";

export interface TickDeps {
  sql: SQL;
  runner: Runner;
  clock: Clock;
}

export interface TickResult {
  started: string[];
  failed: string[];
  /** spawns left alone: still waiting for capacity, or locked by a concurrent tick */
  skipped: number;
  /** unexpected errors; the spawn stays pending and the next tick retries it */
  errors: string[];
}

interface PendingRow {
  key: string;
  repo: string;
  prompt: string;
  status: "queued" | "waiting";
  account: string | null;
  resume_at: Date | null;
}

/** The account a pending spawn may run on now, or undefined if it must keep waiting. */
function accountFor(row: PendingRow, readings: readonly Reading[], now: Date): string | undefined {
  if (row.account) return row.account;
  const eligible = pickEligible(readings);
  if (eligible) return eligible.account;
  // Out of capacity: once resume_at has passed, the window that blocked it has reset.
  if (row.resume_at && row.resume_at <= now) return earliestReset(readings)?.account;
  return undefined;
}

/** Runs one spawn under its row lock. Returns what happened to it. */
async function tickOne(deps: TickDeps, key: string): Promise<"started" | "failed" | "skipped"> {
  const { sql, runner, clock } = deps;
  return sql.begin(async (tx): Promise<"started" | "failed" | "skipped"> => {
    const [row]: PendingRow[] = await tx`
      SELECT key, repo, prompt, status, account, resume_at FROM spawns
      WHERE key = ${key} AND status IN ('queued', 'waiting')
      FOR UPDATE SKIP LOCKED`;
    if (!row) return "skipped";

    const account = accountFor(row, await latestReadings(tx), clock.now());
    if (!account) return "skipped";

    // The pane is named after the key, so an interrupted earlier call to the adapter is found, not repeated.
    // An error that is not a RunnerError rolls this transaction back and leaves the spawn pending.
    try {
      const { session, attempts } = await runner.start({ key: row.key, repo: row.repo, prompt: row.prompt });
      await tx`
        UPDATE spawns SET status = 'started', account = ${account}, session = ${session}, attempts = attempts + ${attempts}
        WHERE key = ${key}`;
      return "started";
    } catch (error) {
      if (!(error instanceof RunnerError)) throw error;
      await tx`
        UPDATE spawns SET status = 'failed', account = ${account}, error = ${error.message}, attempts = attempts + ${error.attempts}
        WHERE key = ${key}`;
      return "failed";
    }
  });
}

/** One pass over the pending spawns. Safe to run concurrently with itself: rows are claimed with SKIP LOCKED. */
export async function tick(deps: TickDeps): Promise<TickResult> {
  const result: TickResult = { started: [], failed: [], skipped: 0, errors: [] };
  const pending: { key: string }[] = await deps.sql`
    SELECT key FROM spawns WHERE status IN ('queued', 'waiting') ORDER BY created_at, key`;

  for (const { key } of pending) {
    try {
      const outcome = await tickOne(deps, key);
      if (outcome === "started") result.started.push(key);
      else if (outcome === "failed") result.failed.push(key);
      else result.skipped++;
    } catch (error) {
      result.errors.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

export const TICK_INTERVAL_MS = 5_000;

/** Ticks once now and then every interval; a pass that is still running makes the next one skip. */
export function startTicker(deps: TickDeps, intervalMs: number = TICK_INTERVAL_MS): { stop(): void } {
  let running = false;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      const { started, failed, errors } = await tick(deps);
      if (started.length || failed.length || errors.length) console.log("tick", { started, failed, errors });
    } catch (error) {
      console.error("tick failed", error);
    } finally {
      running = false;
    }
  };
  void pass();
  const timer = setInterval(() => void pass(), intervalMs);
  return { stop: () => clearInterval(timer) };
}
