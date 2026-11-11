import { LOOP_NAMES } from '@software-factory/contract'
import type { SQL } from 'bun'
import * as z from 'zod'
import type { CallLoop, CallRow } from '../../domains/loops/calls.ts'
import type { HygienePassRecord, LoopStore } from '../../domains/loops/ports.ts'
import type { QueueAskRow } from '../../domains/loops/queue.ts'
import { FINDING_KINDS } from '../../domains/loops/selfwatch-model.ts'
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

const AttemptWorktreeRow = z.object({
  worktree_path: z.string(),
  issue_id: z.string(),
  attempt: z.number().int(),
  repo_path: z.string().nullable(),
  repo: z.string().nullable(),
})

const ReaperAttemptRow = z.object({
  issue_id: z.string(),
  attempt: z.number().int(),
  worktree_path: z.string().nullable(),
  done_at: z.date().nullable(),
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

const SelfwatchRowSchema = z.object({
  subject_key: z.string(),
  kind: z.enum(FINDING_KINDS),
  first_seen_at: z.date(),
  last_seen_at: z.date(),
  evidence_hash: z.string(),
  last_filed_at: z.date(),
  signal_id: z.string().nullable(),
  cleared_at: z.date().nullable(),
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

    async recordHostSample(at, sample, leads) {
      await tx`
        INSERT INTO factory.host_samples (at, load, memory_used_pct, swap_used_pct, swapout_mb_per_300s, leads, queued, seats, load_ceiling)
        VALUES (${at}, ${sample.load}, ${sample.memoryUsedPct}, ${sample.swapUsedPct}, ${sample.swapoutMbPer300s},
          ${sample.leads}, ${sample.queued}, ${sample.seats}, ${sample.loadCeiling})
        ON CONFLICT (at) DO NOTHING`
      for (const lead of leads) {
        await tx`
          INSERT INTO factory.lead_samples (at, worktree, repo, issue, attempt, rss_mib, procs)
          VALUES (${at}, ${lead.worktree}, ${lead.repo}, ${lead.issue}, ${lead.attempt}, ${lead.rssMib}, ${lead.procs})
          ON CONFLICT (at, worktree) DO NOTHING`
      }
    },

    async pruneHostSamples(before) {
      const rows: unknown[] = await tx`DELETE FROM factory.host_samples WHERE at < ${before} RETURNING at`
      return rows.length
    },

    async pruneLeadSamples(before) {
      const rows: unknown[] = await tx`DELETE FROM factory.lead_samples WHERE at < ${before} RETURNING at`
      return rows.length
    },

    async attemptWorktrees(since) {
      const rows: unknown[] = await tx`
        SELECT a.worktree_path, a.issue_id, a.attempt, a.repo_path, i.repo
        FROM factory.lead_attempts a LEFT JOIN factory.issues i ON i.id = a.issue_id
        WHERE a.worktree_path IS NOT NULL AND (a.gone_at IS NULL OR a.gone_at >= ${since})
        ORDER BY a.issue_id, a.attempt`
      return rows.map((raw) => {
        const row = AttemptWorktreeRow.parse(raw)
        return {
          path: row.worktree_path,
          repo: row.repo ?? row.repo_path?.split('/').filter(Boolean).at(-1) ?? '',
          issue: Number(row.issue_id.slice('issue_'.length)),
          attempt: row.attempt,
        }
      })
    },

    async reaperAttempts(since) {
      const rows: unknown[] = await tx`
        SELECT a.issue_id, a.attempt, a.worktree_path, f.done_at
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

    async passes() {
      const rows: unknown[] = await tx`SELECT loop, last_pass_at FROM factory.loop_passes`
      return new Map(
        rows.map((raw) => {
          const row = z.object({ loop: z.enum(LOOP_NAMES), last_pass_at: z.date() }).parse(raw)
          return [row.loop, row.last_pass_at]
        }),
      )
    },

    async recordPass(name, at) {
      await tx`
        INSERT INTO factory.loop_passes (loop, last_pass_at) VALUES (${name}, ${at})
        ON CONFLICT (loop) DO UPDATE SET last_pass_at = GREATEST(factory.loop_passes.last_pass_at, EXCLUDED.last_pass_at)`
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

    async recordFinding(row) {
      await tx`
        INSERT INTO factory.loop_findings (issue_id, loop, repo, class, key)
        VALUES (${row.issue}, ${row.loop}, ${row.repo}, ${row.class}, ${row.key})
        ON CONFLICT (issue_id) DO NOTHING`
    },

    async storedFixShas(repo) {
      const rows: unknown[] = await tx`SELECT sha FROM factory.fix_commits WHERE repo = ${repo}`
      return new Set(rows.map((row) => z.object({ sha: z.string() }).parse(row).sha))
    },

    async recordFixCommits(rows) {
      for (const row of rows) {
        await tx`
          INSERT INTO factory.fix_commits (repo, sha, committed_at, subject, scope, class, by, reason)
          VALUES (${row.repo}, ${row.sha}, ${row.committedAt}, ${row.subject}, ${row.scope}, ${row.class}, ${row.by}, ${row.reason})
          ON CONFLICT (repo, sha) DO NOTHING`
      }
    },

    async selfwatchRows() {
      const rows: unknown[] = await tx`SELECT * FROM factory.selfwatch_findings ORDER BY subject_key`
      return rows.map((raw) => {
        const row = SelfwatchRowSchema.parse(raw)
        return {
          subjectKey: row.subject_key,
          kind: row.kind,
          firstSeenAt: row.first_seen_at,
          lastSeenAt: row.last_seen_at,
          evidenceHash: row.evidence_hash,
          lastFiledAt: row.last_filed_at,
          signalId: row.signal_id,
          clearedAt: row.cleared_at,
        }
      })
    },

    async applySelfwatch(change) {
      for (const row of change.filed) {
        await tx`
          INSERT INTO factory.selfwatch_findings
            (subject_key, kind, first_seen_at, last_seen_at, evidence_hash, last_filed_at, signal_id, cleared_at)
          VALUES (${row.subjectKey}, ${row.kind}, ${row.firstSeenAt}, ${row.lastSeenAt}, ${row.evidenceHash}, ${row.lastFiledAt}, ${row.signalId}, NULL)
          ON CONFLICT (subject_key) DO UPDATE SET
            first_seen_at = EXCLUDED.first_seen_at, last_seen_at = EXCLUDED.last_seen_at,
            evidence_hash = EXCLUDED.evidence_hash, last_filed_at = EXCLUDED.last_filed_at,
            signal_id = EXCLUDED.signal_id, cleared_at = NULL`
      }
      if (change.touched.length > 0) {
        await tx`
          UPDATE factory.selfwatch_findings SET last_seen_at = ${change.at}
          WHERE subject_key IN ${tx(change.touched)} AND cleared_at IS NULL`
      }
      if (change.cleared.length > 0) {
        await tx`
          UPDATE factory.selfwatch_findings SET cleared_at = ${change.at}
          WHERE subject_key IN ${tx(change.cleared)} AND cleared_at IS NULL`
      }
    },
  }
}
