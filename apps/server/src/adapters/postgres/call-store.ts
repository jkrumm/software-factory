import type { SQL } from 'bun'
import * as z from 'zod'
import type { CallLoop, CallRow } from '../../domains/planning/calls.ts'
import type { CallStore } from '../../domains/planning/ports.ts'

const Row = z.object({
  key: z.string(),
  loop: z.enum(['steward', 'triage', 'queue']),
  scope: z.string(),
  subject: z.string(),
  round: z.number().int(),
  claimed_at: z.date(),
  lease_until: z.date(),
  outcome: z.enum(['answered', 'rejected', 'failed']).nullable(),
  answer: z.unknown(),
  detail: z.string().nullable(),
  finished_at: z.date().nullable(),
  applied: z.unknown(),
})

const json = (value: unknown): unknown => (typeof value === 'string' ? JSON.parse(value) : value)

const callOf = (raw: unknown): CallRow => {
  const row = Row.parse(raw)
  return {
    key: row.key,
    loop: row.loop,
    scope: row.scope,
    subject: row.subject,
    round: row.round,
    claimedAt: row.claimed_at,
    leaseUntil: row.lease_until,
    outcome: row.outcome,
    answer: json(row.answer),
    detail: row.detail,
    finishedAt: row.finished_at,
    applied: json(row.applied) ?? null,
  }
}

/** The loops' agw calls (`migrations/0700_loops.sql`), on the transaction's connection. */
export function postgresCallStore(tx: SQL): CallStore {
  return {
    async calls(loop: CallLoop, scope, subject) {
      const rows: unknown[] = await tx`
        SELECT * FROM factory.loop_calls
        WHERE loop = ${loop} AND scope = ${scope} AND (${subject ?? null}::text IS NULL OR subject = ${subject ?? null})
        ORDER BY round, claimed_at`
      return rows.map(callOf)
    },

    async claimCall(row) {
      const inserted: unknown[] = await tx`
        INSERT INTO factory.loop_calls (key, loop, issue_id, repo, subject, round, claimed_at, lease_until)
        VALUES (${row.key}, ${row.loop}, ${row.loop === 'queue' ? null : row.scope}, ${row.loop === 'queue' ? row.scope : null},
          ${row.subject}, ${row.round}, ${row.claimedAt}, ${row.leaseUntil})
        ON CONFLICT DO NOTHING RETURNING key`
      return inserted.length === 1
    },

    async retakeCall(key, claimedAt, leaseUntil) {
      const taken: unknown[] = await tx`
        UPDATE factory.loop_calls SET claimed_at = ${claimedAt}, lease_until = ${leaseUntil}
        WHERE key = ${key} AND outcome IS NULL AND lease_until <= ${claimedAt} RETURNING key`
      return taken.length === 1
    },

    async lapseOpen(now) {
      const lapsed: unknown[] = await tx`
        UPDATE factory.loop_calls SET lease_until = ${now} WHERE outcome IS NULL AND lease_until > ${now} RETURNING key`
      return lapsed.length
    },

    async finishCall(key, result) {
      await tx`
        UPDATE factory.loop_calls
        SET outcome = ${result.outcome}, answer = ${result.answer === undefined ? null : JSON.stringify(result.answer)}::jsonb,
            detail = ${result.detail}, finished_at = ${result.at}
        WHERE key = ${key} AND outcome IS NULL`
    },

    async recordQueueApplied(key, result) {
      await tx`
        UPDATE factory.loop_calls SET applied = ${JSON.stringify(result)}::jsonb
        WHERE key = ${key} AND loop = 'queue' AND applied IS NULL`
    },
  }
}
