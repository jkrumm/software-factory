import type { SQL } from 'bun'
import * as z from 'zod'
import type { CallLoop, CallRow } from '../../domains/loops/calls.ts'
import type { HygienePassRecord, LoopStore } from '../../domains/loops/ports.ts'
import type { QueueAskRow } from '../../domains/loops/queue.ts'
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

const AskRow = z.object({
  key: z.string(),
  repo: z.string(),
  shape: z.string(),
  round: z.number().int(),
  claimed_at: z.date(),
  lease_until: z.date(),
  outcome: z.enum(['answered', 'rejected', 'failed']).nullable(),
  answer: z.unknown(),
  applied: z.unknown(),
  refused: z.unknown(),
  after_shape: z.string().nullable(),
  detail: z.string().nullable(),
  finished_at: z.date().nullable(),
})

const json = (value: unknown): unknown => (typeof value === 'string' ? JSON.parse(value) : value)

const askOf = (raw: unknown): QueueAskRow => {
  const row = AskRow.parse(raw)
  return {
    key: row.key,
    repo: row.repo,
    shape: row.shape,
    round: row.round,
    claimedAt: row.claimed_at,
    leaseUntil: row.lease_until,
    outcome: row.outcome,
    answer: json(row.answer),
    applied: (json(row.applied) ?? null) as QueueAskRow['applied'],
    refused: (json(row.refused) ?? null) as QueueAskRow['refused'],
    afterShape: row.after_shape,
    detail: row.detail,
    finishedAt: row.finished_at,
  }
}

const HygieneRow = z.object({
  id: z.string(),
  repo: z.string(),
  at: z.date(),
  ref: z.string(),
  report: z.unknown(),
  judgment: z.unknown(),
  filed: z.unknown(),
  over_budget: z.unknown(),
  failed: z.unknown(),
})

const hygieneOf = (raw: unknown): HygienePassRecord => {
  const row = HygieneRow.parse(raw)
  const judgment = json(row.judgment) as Omit<HygienePassRecord['judgment'], 'judgedAt'> & { judgedAt: string | null }
  return {
    id: row.id,
    repo: row.repo,
    at: row.at,
    ref: row.ref,
    report: json(row.report) as HygienePassRecord['report'],
    judgment: { ...judgment, judgedAt: judgment.judgedAt === null ? null : new Date(judgment.judgedAt) },
    filed: json(row.filed) as HygienePassRecord['filed'],
    overBudget: json(row.over_budget) as HygienePassRecord['overBudget'],
    failed: json(row.failed) as HygienePassRecord['failed'],
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

    async retakeCall(key, claimedAt, leaseUntil) {
      const taken: unknown[] = await tx`
        UPDATE factory.loop_calls SET claimed_at = ${claimedAt}, lease_until = ${leaseUntil}
        WHERE key = ${key} AND outcome IS NULL AND lease_until <= ${claimedAt} RETURNING key`
      return taken.length === 1
    },

    async lapseOpen(now) {
      const lapsed: unknown[] = await tx`
        UPDATE factory.loop_calls SET lease_until = ${now} WHERE outcome IS NULL AND lease_until > ${now} RETURNING key`
      const lapsedAsks: unknown[] = await tx`
        UPDATE factory.queue_asks SET lease_until = ${now} WHERE outcome IS NULL AND lease_until > ${now} RETURNING key`
      return lapsed.length + lapsedAsks.length
    },

    async finishCall(key, result) {
      await tx`
        UPDATE factory.loop_calls
        SET outcome = ${result.outcome}, answer = ${result.answer === undefined ? null : JSON.stringify(result.answer)}::jsonb,
            detail = ${result.detail}, finished_at = ${result.at}
        WHERE key = ${key} AND outcome IS NULL`
    },

    async queueAsks(repo, shape) {
      const rows: unknown[] = await tx`
        SELECT * FROM factory.queue_asks WHERE repo = ${repo} AND shape = ${shape} ORDER BY round`
      return rows.map(askOf)
    },

    async claimQueueAsk(row) {
      const inserted: unknown[] = await tx`
        INSERT INTO factory.queue_asks (key, repo, shape, round, claimed_at, lease_until)
        VALUES (${row.key}, ${row.repo}, ${row.shape}, ${row.round}, ${row.claimedAt}, ${row.leaseUntil})
        ON CONFLICT DO NOTHING RETURNING key`
      return inserted.length === 1
    },

    async retakeQueueAsk(key, claimedAt, leaseUntil) {
      const taken: unknown[] = await tx`
        UPDATE factory.queue_asks SET claimed_at = ${claimedAt}, lease_until = ${leaseUntil}
        WHERE key = ${key} AND outcome IS NULL AND lease_until <= ${claimedAt} RETURNING key`
      return taken.length === 1
    },

    async finishQueueAsk(key, result) {
      await tx`
        UPDATE factory.queue_asks
        SET outcome = ${result.outcome}, answer = ${result.answer === undefined ? null : JSON.stringify(result.answer)}::jsonb,
            detail = ${result.detail}, finished_at = ${result.at}
        WHERE key = ${key} AND outcome IS NULL`
    },

    async recordQueueApplied(key, result) {
      await tx`
        UPDATE factory.queue_asks
        SET applied = ${JSON.stringify(result.applied)}::jsonb, refused = ${JSON.stringify(result.refused)}::jsonb,
            after_shape = ${result.afterShape}
        WHERE key = ${key} AND applied IS NULL`
    },

    async shapeAsked(repo, shape) {
      const rows: unknown[] = await tx`
        SELECT 1 AS found FROM factory.queue_asks
        WHERE repo = ${repo} AND outcome = 'answered' AND (shape = ${shape} OR after_shape = ${shape}) LIMIT 1`
      return rows.length > 0
    },

    async lastQueueAskAt(repo) {
      const rows: unknown[] = await tx`SELECT max(claimed_at) AS at FROM factory.queue_asks WHERE repo = ${repo}`
      return z.object({ at: z.date().nullable() }).parse(rows[0]).at
    },

    async lastFrictionPassAt() {
      const rows: unknown[] = await tx`SELECT max(at) AS at FROM factory.friction_passes`
      return z.object({ at: z.date().nullable() }).parse(rows[0]).at
    },

    async recordFrictionPass(pass) {
      await tx`
        INSERT INTO factory.friction_passes (id, at, window_from, window_to, issues, filed, over_budget, failed)
        VALUES (${pass.id}, ${pass.at}, ${pass.windowFrom}, ${pass.windowTo}, ${pass.issues},
          ${JSON.stringify(pass.filed)}::jsonb, ${JSON.stringify(pass.overBudget)}::jsonb, ${JSON.stringify(pass.failed)}::jsonb)`
    },

    async hygienePasses() {
      const rows: unknown[] = await tx`SELECT DISTINCT ON (repo) * FROM factory.hygiene_passes ORDER BY repo, at DESC`
      return rows.map(hygieneOf)
    },

    async lastHygienePass(repo) {
      const rows: unknown[] = await tx`
        SELECT * FROM factory.hygiene_passes WHERE repo = ${repo} ORDER BY at DESC LIMIT 1`
      return rows[0] === undefined ? null : hygieneOf(rows[0])
    },

    async recordHygienePass(pass) {
      await tx`
        INSERT INTO factory.hygiene_passes (id, repo, at, ref, report, judgment, filed, over_budget, failed)
        VALUES (${pass.id}, ${pass.repo}, ${pass.at}, ${pass.ref}, ${JSON.stringify(pass.report)}::jsonb,
          ${JSON.stringify(pass.judgment)}::jsonb, ${JSON.stringify(pass.filed)}::jsonb,
          ${JSON.stringify(pass.overBudget)}::jsonb, ${JSON.stringify(pass.failed)}::jsonb)`
    },

    async updateHygieneJudgment(id, next) {
      await tx`
        UPDATE factory.hygiene_passes
        SET judgment = ${JSON.stringify(next.judgment)}::jsonb, filed = ${JSON.stringify(next.filed)}::jsonb,
            over_budget = ${JSON.stringify(next.overBudget)}::jsonb, failed = ${JSON.stringify(next.failed)}::jsonb
        WHERE id = ${id}`
    },
  }
}
