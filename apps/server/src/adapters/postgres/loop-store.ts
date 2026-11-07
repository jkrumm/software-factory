import type { SQL } from 'bun'
import * as z from 'zod'
import type { CallLoop, CallRow } from '../../domains/loops/calls.ts'
import type { LoopStore } from '../../domains/loops/ports.ts'
import type { IssueId } from '../../kernel/ids.ts'

const Row = z.object({
  key: z.string(),
  loop: z.enum(['steward', 'triage']),
  issue_id: z.string(),
  subject: z.string(),
  round: z.number().int(),
  claimed_at: z.date(),
  lease_until: z.date(),
  outcome: z.enum(['answered', 'rejected', 'failed']).nullable(),
  answer: z.unknown(),
  detail: z.string().nullable(),
  finished_at: z.date().nullable(),
})

const callOf = (raw: unknown): CallRow => {
  const row = Row.parse(raw)
  return {
    key: row.key,
    loop: row.loop,
    issueId: row.issue_id as IssueId,
    subject: row.subject,
    round: row.round,
    claimedAt: row.claimed_at,
    leaseUntil: row.lease_until,
    outcome: row.outcome,
    answer: typeof row.answer === 'string' ? JSON.parse(row.answer) : row.answer,
    detail: row.detail,
    finishedAt: row.finished_at,
  }
}

/** The loops' table (`migrations/0700_loops.sql`), on the transaction's connection. */
export function postgresLoopStore(tx: SQL): LoopStore {
  return {
    async calls(loop: CallLoop, issue, subject) {
      const rows: unknown[] = await tx`
        SELECT * FROM factory.loop_calls WHERE loop = ${loop} AND issue_id = ${issue} AND subject = ${subject}
        ORDER BY round`
      return rows.map(callOf)
    },

    async claimCall(row) {
      const inserted: unknown[] = await tx`
        INSERT INTO factory.loop_calls (key, loop, issue_id, subject, round, claimed_at, lease_until)
        VALUES (${row.key}, ${row.loop}, ${row.issueId}, ${row.subject}, ${row.round}, ${row.claimedAt}, ${row.leaseUntil})
        ON CONFLICT DO NOTHING RETURNING key`
      return inserted.length === 1
    },

    async finishCall(key, result) {
      await tx`
        UPDATE factory.loop_calls
        SET outcome = ${result.outcome}, answer = ${result.answer === undefined ? null : JSON.stringify(result.answer)}::jsonb,
            detail = ${result.detail}, finished_at = ${result.at}
        WHERE key = ${key} AND outcome IS NULL`
    },
  }
}
