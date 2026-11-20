import type { SQL } from 'bun'
import * as z from 'zod'
import type { ReaperStore } from '../../domains/leads/ports.ts'

const ReaperAttemptRow = z.object({
  issue_id: z.string(),
  attempt: z.number().int(),
  worktree_path: z.string().nullable(),
  done_at: z.date().nullable(),
  // set only when the finalization kept the worktree (`worktree_kept` alone can be a branch note of a removed one)
  kept_path: z.string().nullable(),
})

/** The reaper's tables (the attempts it weighs, the signals it sent), on the transaction's connection. */
export function postgresReaperStore(tx: SQL): ReaperStore {
  return {
    async reaperAttempts(since) {
      const rows: unknown[] = await tx`
        SELECT a.issue_id, a.attempt, a.worktree_path, f.done_at, f.worktree_path AS kept_path
        FROM factory.lead_attempts a
        LEFT JOIN factory.lead_finalizations f ON f.issue_id = a.issue_id AND f.attempt = a.attempt
        WHERE f.done_at IS NULL OR f.done_at >= ${since}
        ORDER BY a.issue_id, a.attempt`
      return rows.map((raw) => {
        const row = ReaperAttemptRow.parse(raw)
        return {
          session: `lead-${row.issue_id.slice('issue_'.length)}-${row.attempt}`,
          worktree: row.worktree_path,
          closedAt: row.done_at,
          kept: row.kept_path !== null,
        }
      })
    },

    async termedSince(since) {
      const rows: unknown[] = await tx`
        SELECT pid, age_s FROM factory.reaped_processes WHERE signal = 'SIGTERM' AND at >= ${since} ORDER BY at`
      return rows.map((raw) => {
        const row = z.object({ pid: z.number().int(), age_s: z.number().int() }).parse(raw)
        return { pid: row.pid, ageS: row.age_s }
      })
    },

    async recordReaped(rows) {
      for (const row of rows) {
        await tx`
          INSERT INTO factory.reaped_processes (at, pid, session, worktree, comm, signal, reason, age_s)
          VALUES (${row.at}, ${row.pid}, ${row.session}, ${row.worktree}, ${row.comm}, ${row.signal}, ${row.reason}, ${row.ageS})`
      }
    },

    async pruneReaped(before) {
      const rows: unknown[] = await tx`DELETE FROM factory.reaped_processes WHERE at < ${before} RETURNING at`
      return rows.length
    },
  }
}
