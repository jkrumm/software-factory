import { LOOP_NAMES } from '@software-factory/contract'
import type { SQL } from 'bun'
import * as z from 'zod'
import type { CallLoop, CallRow } from '../../domains/loops/calls.ts'
import type { HygienePassRecord, LoopStore } from '../../domains/loops/ports.ts'
import type { DigestAnswer } from '@software-factory/contract'
import type { QueueAskRow } from '../../domains/loops/queue.ts'
import { FINDING_KINDS } from '../../domains/loops/selfwatch-model.ts'
import { THROUGHPUT_KPIS } from '../../domains/loops/throughput.ts'
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
  project: z.string().nullable(),
})

const ReaperAttemptRow = z.object({
  issue_id: z.string(),
  attempt: z.number().int(),
  worktree_path: z.string().nullable(),
  done_at: z.date().nullable(),
  // set only when the finalization kept the worktree (`worktree_kept` alone can be a branch note of a removed one)
  kept_path: z.string().nullable(),
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

const ThroughputRowSchema = z.object({
  id: z.string(),
  project: z.string(),
  kpi: z.enum(THROUGHPUT_KPIS),
  subject: z.string(),
  before: z.coerce.number(),
  target: z.coerce.number(),
  direction: z.enum(['up', 'down']),
  unit: z.string(),
  cost_minutes: z.coerce.number(),
  query: z.string(),
  signal_id: z.string().nullable(),
  issue_id: z.string().nullable(),
  filed_at: z.date(),
  shipped_at: z.date().nullable(),
  after: z.coerce.number().nullable(),
  after_at: z.date().nullable(),
  status: z.enum(['open', 'shipped', 'moved', 'flat', 'worse', 'dropped', 'unmeasured']),
  reopens: z.string().nullable(),
})

const LatestDigestRow = z.object({ project: z.string(), at: z.date(), input_hash: z.string(), headline: z.string() })

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
        INSERT INTO factory.host_samples (at, load, memory_used_pct, swap_used_pct, swapout_mb_per_300s, leads, queued, seats,
          load_ceiling, pressure_level, compressor_mib, processes, cpu_idle_pct, vm_free_gib, collector_cpu_ms)
        VALUES (${at}, ${sample.load}, ${sample.memoryUsedPct}, ${sample.swapUsedPct}, ${sample.swapoutMbPer300s},
          ${sample.leads}, ${sample.queued}, ${sample.seats}, ${sample.loadCeiling}, ${sample.pressureLevel},
          ${sample.compressorMib}, ${sample.processes}, ${sample.cpuIdlePct}, ${sample.vmFreeGib}, ${sample.collectorCpuMs})
        ON CONFLICT (at) DO NOTHING`
      for (const lead of leads) {
        await tx`
          INSERT INTO factory.lead_samples (at, worktree, repo, issue, attempt, rss_mib, footprint_mib, procs)
          VALUES (${at}, ${lead.worktree}, ${lead.repo}, ${lead.issue}, ${lead.attempt}, ${lead.rssMib}, ${lead.footprintMib}, ${lead.procs})
          ON CONFLICT (at, worktree) DO NOTHING`
      }
    },

    async pruneHostSamples(before) {
      const rows: unknown[] = await tx`DELETE FROM factory.host_samples WHERE at < ${before} RETURNING at`
      return rows.length
    },

    async latestDigests() {
      const rows: unknown[] = await tx`
        SELECT DISTINCT ON (project) project, at, input_hash, digest->>'headline' AS headline
        FROM factory.project_digests ORDER BY project, at DESC, id DESC`
      const latest = new Map<string, { hash: string; at: Date; headline: string }>()
      for (const raw of rows) {
        const row = LatestDigestRow.parse(raw)
        latest.set(row.project, { hash: row.input_hash, at: row.at, headline: row.headline })
      }
      return latest
    },

    async recordDigest(record) {
      await tx`
        INSERT INTO factory.project_digests (project, at, input_hash, route, digest)
        VALUES (${record.project}, ${record.at}, ${record.hash}, ${record.route}, ${JSON.stringify(record.digest satisfies DigestAnswer)}::text::jsonb)`
    },

    async pruneLeadSamples(before) {
      const rows: unknown[] = await tx`DELETE FROM factory.lead_samples WHERE at < ${before} RETURNING at`
      return rows.length
    },

    async recordClassSnapshot(at, classes, processes) {
      for (const row of classes) {
        await tx`
          INSERT INTO factory.host_class_samples (at, class, repo, tenant, issue, step, footprint_mib, cpu_ms, procs)
          VALUES (${at}, ${row.class}, ${row.repo}, ${row.tenant}, ${row.issue}, ${row.step}, ${row.footprintMib},
            ${row.cpuMs}, ${row.procs})`
      }
      for (const proc of processes) {
        await tx`
          INSERT INTO factory.host_process_samples (at, pid, ppid, name, class, repo, tenant, issue, footprint_mib, cpu_ms, why, grown_mib)
          VALUES (${at}, ${proc.pid}, ${proc.ppid}, ${proc.name}, ${proc.class}, ${proc.repo}, ${proc.tenant}, ${proc.issue},
            ${proc.footprintMib}, ${proc.cpuMs}, ${proc.why}, ${proc.grownMib})
          ON CONFLICT (at, pid) DO NOTHING`
      }
    },

    async rollUpClassHours(now) {
      // a minute's total per key first, then the hour: the peak is the largest minute, not the largest row
      const rows: unknown[] = await tx`
        INSERT INTO factory.host_class_hours (hour, class, repo, tenant, mib_minutes, peak_mib, cpu_seconds, minutes)
        SELECT hour, class, repo, tenant, sum(mib), max(mib), coalesce(sum(cpu), 0) / 1000.0, count(*)
        FROM (
          SELECT date_trunc('hour', at) AS hour, at, class, coalesce(repo, '') AS repo, coalesce(tenant, '') AS tenant,
            sum(footprint_mib) AS mib, sum(cpu_ms) AS cpu
          FROM factory.host_class_samples
          WHERE at < date_trunc('hour', ${now}::timestamptz)
            AND at >= coalesce((SELECT max(hour) + interval '1 hour' FROM factory.host_class_hours), '-infinity'::timestamptz)
          GROUP BY 1, 2, 3, 4, 5
        ) minute
        GROUP BY hour, class, repo, tenant
        ON CONFLICT DO NOTHING
        RETURNING hour`
      return rows.length
    },

    async pruneClassSamples(before) {
      const classes: unknown[] = await tx`DELETE FROM factory.host_class_samples WHERE at < ${before} RETURNING at`
      const processes: unknown[] = await tx`DELETE FROM factory.host_process_samples WHERE at < ${before} RETURNING at`
      return classes.length + processes.length
    },

    async pruneTestResults(before) {
      const rows: unknown[] = await tx`DELETE FROM factory.test_results WHERE at < ${before} RETURNING id`
      return rows.length
    },

    async pruneClassHours(before) {
      const rows: unknown[] = await tx`DELETE FROM factory.host_class_hours WHERE hour < ${before} RETURNING hour`
      return rows.length
    },

    async ciLedgerRepos(since) {
      const rows: unknown[] = await tx`
        SELECT DISTINCT i.repo FROM factory.issue_events e JOIN factory.issues i ON i.id = e.issue_id
        WHERE e.at >= ${since} ORDER BY i.repo`
      return rows.map((raw) => z.object({ repo: z.string() }).parse(raw).repo)
    },

    async newestCiRun(repo) {
      const [row] = await tx`SELECT max(finished_at) AS at FROM factory.ci_runs WHERE repo = ${repo}`
      return z.object({ at: z.date().nullable() }).parse(row).at
    },

    async recordCiRuns(repo, runs) {
      for (const r of runs)
        await tx`
          INSERT INTO factory.ci_runs (repo, run_id, workflow, event, head_branch, head_sha, run_attempt, queued_at, started_at,
             finished_at, conclusion)
          VALUES (${repo}, ${r.runId}, ${r.workflow}, ${r.event}, ${r.headBranch}, ${r.headSha}, ${r.runAttempt}, ${r.queuedAt},
                  ${r.startedAt}, ${r.finishedAt}, ${r.conclusion})
          ON CONFLICT (repo, run_id) DO UPDATE SET workflow = excluded.workflow, event = excluded.event,
            head_branch = excluded.head_branch, head_sha = excluded.head_sha, run_attempt = excluded.run_attempt,
            queued_at = excluded.queued_at, started_at = excluded.started_at, finished_at = excluded.finished_at,
            conclusion = excluded.conclusion`
      return runs.length
    },

    async pruneCiRuns(before) {
      const rows: unknown[] = await tx`DELETE FROM factory.ci_runs WHERE finished_at < ${before} RETURNING run_id`
      return rows.length
    },

    async attemptWorktrees(since) {
      const rows: unknown[] = await tx`
        SELECT a.worktree_path, a.issue_id, a.attempt, a.repo_path, i.repo, pr.name AS project
        FROM factory.lead_attempts a
        LEFT JOIN factory.issues i ON i.id = a.issue_id
        LEFT JOIN LATERAL (
          SELECT p.name FROM factory.planning_projects p
          WHERE p.name = i.repo OR p.repo = i.repo OR p.repo = a.repo_path
          ORDER BY (p.name = i.repo) DESC, p.name LIMIT 1
        ) pr ON true
        WHERE a.worktree_path IS NOT NULL AND (a.gone_at IS NULL OR a.gone_at >= ${since})
        ORDER BY a.issue_id, a.attempt`
      return rows.map((raw) => {
        const row = AttemptWorktreeRow.parse(raw)
        return {
          path: row.worktree_path,
          // The project's name, the one key a lead's cost is learned and looked up by (an Issue's repo text can be a path).
          repo: row.project ?? row.repo ?? row.repo_path?.split('/').filter(Boolean).at(-1) ?? '',
          issue: Number(row.issue_id.slice('issue_'.length)),
          attempt: row.attempt,
        }
      })
    },

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

    async throughputFindings() {
      const rows: unknown[] = await tx`SELECT * FROM factory.throughput_findings ORDER BY filed_at, id`
      return rows.map((raw) => {
        const row = ThroughputRowSchema.parse(raw)
        return {
          id: row.id,
          project: row.project,
          kpi: row.kpi,
          subject: row.subject,
          before: row.before,
          target: row.target,
          direction: row.direction,
          unit: row.unit,
          costMinutes: row.cost_minutes,
          query: row.query,
          signalId: row.signal_id,
          issueId: row.issue_id,
          filedAt: row.filed_at,
          shippedAt: row.shipped_at,
          after: row.after,
          afterAt: row.after_at,
          status: row.status,
          reopens: row.reopens,
        }
      })
    },

    async recordThroughputFinding(row) {
      await tx`
        INSERT INTO factory.throughput_findings
          (id, project, kpi, subject, before, target, direction, unit, cost_minutes, query, signal_id, issue_id, filed_at, status, reopens)
          VALUES (${row.id}, ${row.project}, ${row.kpi}, ${row.subject}, ${row.before}, ${row.target}, ${row.direction}, ${row.unit}, ${row.costMinutes}, ${row.query}, ${row.signalId}, ${row.issueId}, ${row.filedAt}, ${row.status}, ${row.reopens})
        ON CONFLICT (id) DO NOTHING`
    },

    async applyThroughputLedger(changes) {
      for (const { id, patch } of changes) {
        await tx`
          UPDATE factory.throughput_findings SET
            status = coalesce(${patch.status ?? null}, status), shipped_at = coalesce(${patch.shippedAt ?? null}, shipped_at),
            after = coalesce(${patch.after ?? null}, after), after_at = coalesce(${patch.afterAt ?? null}, after_at)
          WHERE id = ${id}`
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
