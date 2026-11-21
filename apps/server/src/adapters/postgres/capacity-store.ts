import type { SQL } from 'bun'
import * as z from 'zod'
import type { AccountReading } from '../../domains/capacity/accounts.ts'
import type { Claim } from '../../domains/capacity/claims.ts'
import { BASELINE_WINDOW_MS } from '../../kernel/remote-pressure.ts'
import type {
  Assignment,
  CapacityStore,
  HostSampleFact,
  LeadPeaks,
  WorktreeSizes,
} from '../../domains/capacity/ports.ts'
import { ENDED_AFTER_MS, LEARN_WINDOW_MS, PEAKS_FETCHED, SETTLED_RUN_MS } from '../../domains/capacity/leadcost.ts'
import type { AimState, LeadAim } from '../../domains/capacity/slot-aim.ts'
import { QUEUE_STATES, type QueueStates } from '../../domains/capacity/queue-state.ts'
import { type SlotRow, WAIT_KINDS } from '../../domains/capacity/slots.ts'
import { type IssueId, issueId } from '../../kernel/ids.ts'
import { LOCKS } from './locks.ts'

const idOf = (text: string): IssueId => issueId(Number(text.slice('issue_'.length)))

const ReadingRow = z.object({
  account: z.string(),
  read_at: z.date(),
  sampled_at: z.date().nullable(),
  enabled: z.boolean(),
  auth_ok: z.boolean(),
  five_hour_used: z.number().nullable(),
  weekly_used: z.number().nullable(),
  five_hour_resets_at: z.date().nullable(),
  weekly_resets_at: z.date().nullable(),
  exhausted_until: z.date().nullable(),
  bulk_open: z.boolean(),
  bulk_position: z.number().int().nullable(),
  bulk_reason: z.string().nullable(),
  closed_why: z.string().nullable(),
  opens_at: z.date().nullable(),
  wall_reset_at: z.date().nullable(),
  /** a lead's turn ended on a 401 and the owner's login Errand is still open */
  auth_marked: z.boolean(),
})

const ClaimRow = z.object({
  issue_id: z.string(),
  repo: z.string(),
  urgent: z.boolean(),
  account: z.string().nullable(),
  taken_at: z.date(),
})

const AssignmentRow = z.object({
  issue_id: z.string(),
  attempt: z.number().int(),
  account: z.string(),
  repo: z.string(),
  assigned_at: z.date(),
})

const SlotDbRow = z.object({
  id: z.string(),
  name: z.string(),
  requested_at: z.date(),
  seen_at: z.date(),
  slot: z.number().int().nullable(),
  leased_until: z.date().nullable(),
  granted_at: z.date().nullable(),
  run_ms: z.number().int().nullable(),
  rss_mib: z.number().int().nullable(),
  peak_rss_mib: z.number().int().nullable(),
  why: z.string().nullable(),
  cwd: z.string().nullable(),
  passed_at: z.date().nullable(),
  passed_by: z.string().nullable(),
  why_kind: z.enum(WAIT_KINDS).nullable(),
  // the driver hands jsonb back as text
  wait_split: z.preprocess(
    (v) => (typeof v === 'string' ? JSON.parse(v) : v),
    z.partialRecord(z.enum(WAIT_KINDS), z.number()),
  ),
  host: z.enum(['mini', 'vps']).nullable(),
})

const RunRow = z.object({
  peak_rss_mib: z.number().int().nullable(),
  cpu_seconds: z.number().nullable(),
  duration_ms: z.coerce.number(),
  host: z.enum(['mini', 'vps']).nullable(),
})
const ProjectPeakRow = z.object({ step: z.string(), peak_rss_mib: z.number().int().nullable() })
const HostSampleRow = z.object({
  at: z.date(),
  memory_used_pct: z.number().nullable(),
  kernel_free_pct: z.number().nullable(),
})

const HostFactRow = z.object({
  at: z.date(),
  load: z.number().nullable(),
  memory_used_pct: z.number().nullable(),
  swap_used_pct: z.number().nullable(),
  swapout_mb_per_300s: z.number().nullable(),
  processes: z.number().int().nullable(),
  pressure_level: z.number().int().nullable(),
  kernel_free_pct: z.number().int().nullable(),
})
const AimRow = z.object({ target: z.number().int(), quiet_since: z.date().nullable() })
const LeadAimRow = z.object({ lead_target: z.number().int().nullable(), lead_since: z.date().nullable() })
const PeakFactRow = z.object({
  repo: z.string(),
  peak: z.number().int(),
  n: z.coerce.number().int(),
  settled: z.boolean(),
})
const SizeRow = z.object({ repo: z.string(), mib: z.number().int(), n: z.coerce.number().int() })
const RelearnRow = z.object({ repo: z.string(), at: z.date(), set_at: z.date(), set_by: z.string() })
const RssRow = z.object({ issue: z.number().int(), rss_mib: z.number().int() })

const assignmentOf = (raw: unknown): Assignment => {
  const row = AssignmentRow.parse(raw)
  return {
    issue: idOf(row.issue_id),
    attempt: row.attempt,
    account: row.account,
    repo: row.repo,
    assignedAt: row.assigned_at,
  }
}

const GLOBAL = ''

/** Capacity's tables on one transaction's connection. */
export function postgresCapacityStore(tx: SQL): CapacityStore {
  return {
    async lock() {
      await tx`SELECT pg_advisory_xact_lock(${LOCKS.capacity})`
    },

    async recordReadings(readings) {
      for (const r of readings) {
        await tx`
          INSERT INTO factory.capacity_readings
            (account, read_at, sampled_at, enabled, auth_ok, five_hour_used, weekly_used, five_hour_resets_at,
             weekly_resets_at, exhausted_until, bulk_open, bulk_position, bulk_reason, closed_why, opens_at, wall_reset_at)
          VALUES (${r.account}, ${r.readAt}, ${r.sampledAt}, ${r.enabled}, ${r.authOk}, ${r.fiveHourUsed}, ${r.weeklyUsed},
                  ${r.fiveHourResetsAt}, ${r.weeklyResetsAt}, ${r.exhaustedUntil}, ${r.open}, ${r.position}, ${r.reason},
                  ${r.closedWhy}, ${r.opensAt}, ${r.wallResetAt})`
      }
      // The table stays small enough to scan: a week of history, and always the newest reading of each account.
      const newest = readings.reduce((latest, r) => Math.max(latest, r.readAt.getTime()), 0)
      if (newest > 0) {
        const before = new Date(newest - 7 * 24 * 3_600_000)
        await tx`
          DELETE FROM factory.capacity_readings
          WHERE read_at < ${before} AND id NOT IN (SELECT max(id) FROM factory.capacity_readings GROUP BY account)`
      }
    },

    async latestReadings() {
      // An account the API-error path marked (a lead's turn ended on a 401) is not signed in whatever the picker says, until
      // the owner's login Errand closes: it takes no new lead, so `open` and `auth_ok` are false while the mark is open.
      const rows: unknown[] = await tx`
        SELECT DISTINCT ON (r.account) r.account, r.read_at, r.sampled_at, r.enabled, r.auth_ok,
          r.five_hour_used, r.weekly_used, r.five_hour_resets_at, r.weekly_resets_at, r.exhausted_until,
          r.bulk_open, r.bulk_position, r.bulk_reason, r.closed_why, r.opens_at, r.wall_reset_at,
          EXISTS (
            SELECT 1 FROM factory.account_auth_marks m WHERE m.account = r.account AND m.cleared_at IS NULL
          ) AS auth_marked
        FROM factory.capacity_readings r ORDER BY r.account, r.id DESC`
      return rows.map((raw): AccountReading => {
        const r = ReadingRow.parse(raw)
        const open = r.bulk_open && !r.auth_marked
        return {
          account: r.account,
          readAt: r.read_at,
          sampledAt: r.sampled_at,
          enabled: r.enabled,
          authOk: r.auth_ok && !r.auth_marked,
          fiveHourUsed: r.five_hour_used,
          weeklyUsed: r.weekly_used,
          fiveHourResetsAt: r.five_hour_resets_at,
          weeklyResetsAt: r.weekly_resets_at,
          exhaustedUntil: r.exhausted_until,
          open,
          position: open ? r.bulk_position : null,
          reason: open ? r.bulk_reason : null,
          closedWhy: open ? null : r.auth_marked ? 'not signed in' : r.closed_why,
          opensAt: open || r.auth_marked ? null : r.opens_at,
          wallResetAt: r.wall_reset_at,
        }
      })
    },

    async claims() {
      const rows: unknown[] = await tx`SELECT * FROM factory.capacity_claims ORDER BY taken_at, issue_id`
      return rows.map((raw): Claim => {
        const row = ClaimRow.parse(raw)
        return {
          issue: idOf(row.issue_id),
          repo: row.repo,
          urgent: row.urgent,
          account: row.account,
          takenAt: row.taken_at,
        }
      })
    },

    async takeClaim(claim) {
      await tx`
        INSERT INTO factory.capacity_claims (issue_id, repo, urgent, account, taken_at)
        VALUES (${claim.issue}, ${claim.repo}, ${claim.urgent}, ${claim.account}, ${claim.takenAt})
        ON CONFLICT (issue_id) DO NOTHING`
    },

    async releaseClaims(issues) {
      if (issues.length === 0) return []
      const rows: unknown[] = await tx`
        DELETE FROM factory.capacity_claims WHERE issue_id IN ${tx([...issues])} RETURNING issue_id`
      return rows.map((raw) => idOf(z.object({ issue_id: z.string() }).parse(raw).issue_id))
    },

    async assign(assignment) {
      await tx`
        INSERT INTO factory.capacity_assignments (issue_id, attempt, account, repo, assigned_at)
        VALUES (${assignment.issue}, ${assignment.attempt}, ${assignment.account}, ${assignment.repo}, ${assignment.assignedAt})
        ON CONFLICT (issue_id, attempt) DO NOTHING`
    },

    async reassign(issue, attempt, account, at) {
      const rows: unknown[] = await tx`
        UPDATE factory.capacity_assignments SET account = ${account}, assigned_at = ${at}
        WHERE issue_id = ${issue} AND attempt = ${attempt} RETURNING issue_id`
      if (rows.length === 0) return false
      await tx`UPDATE factory.capacity_claims SET account = ${account} WHERE issue_id = ${issue}`
      return true
    },

    async recentAssignments() {
      const rows: unknown[] = await tx`SELECT * FROM factory.capacity_assignments ORDER BY assigned_at DESC LIMIT 200`
      return rows.map(assignmentOf)
    },

    async assignmentOf(issue, attempt) {
      const [row] = await tx`
        SELECT * FROM factory.capacity_assignments WHERE issue_id = ${issue} AND attempt = ${attempt}`
      return row ? assignmentOf(row) : null
    },

    async latestAssignment(issue) {
      const [row] = await tx`
        SELECT * FROM factory.capacity_assignments WHERE issue_id = ${issue} ORDER BY attempt DESC LIMIT 1`
      return row ? assignmentOf(row) : null
    },

    async latestAssignments(issues) {
      if (issues.length === 0) return []
      const rows: unknown[] = await tx`
        SELECT DISTINCT ON (issue_id) * FROM factory.capacity_assignments
        WHERE issue_id IN ${tx([...issues])} ORDER BY issue_id, attempt DESC`
      return rows.map(assignmentOf)
    },

    async queueStates() {
      const rows: unknown[] = await tx`SELECT project, state FROM factory.capacity_queue_states`
      const parsed = rows.map((raw) => z.object({ project: z.string(), state: z.enum(QUEUE_STATES) }).parse(raw))
      const states: QueueStates = {
        global: parsed.find((r) => r.project === GLOBAL)?.state ?? 'run',
        projects: new Map(parsed.filter((r) => r.project !== GLOBAL).map((r) => [r.project, r.state])),
      }
      return states
    },

    async setQueueState(project, state, at) {
      await tx`
        INSERT INTO factory.capacity_queue_states (project, state, set_at) VALUES (${project ?? GLOBAL}, ${state}, ${at})
        ON CONFLICT (project) DO UPDATE SET state = EXCLUDED.state, set_at = EXCLUDED.set_at`
    },

    async removeQueueState(project) {
      await tx`DELETE FROM factory.capacity_queue_states WHERE project = ${project} AND project <> ${GLOBAL}`
    },

    async slots() {
      const rows: unknown[] = await tx`SELECT * FROM factory.capacity_slots`
      return rows.map((raw): SlotRow => {
        const r = SlotDbRow.parse(raw)
        return {
          id: r.id,
          name: r.name,
          requestedAt: r.requested_at,
          seenAt: r.seen_at,
          slot: r.slot,
          leasedUntil: r.leased_until,
          grantedAt: r.granted_at,
          runMs: r.run_ms,
          rssMib: r.rss_mib,
          peakRssMib: r.peak_rss_mib,
          why: r.why,
          cwd: r.cwd,
          passedAt: r.passed_at,
          passedBy: r.passed_by,
          whyKind: r.why_kind,
          waitSplit: r.wait_split,
          host: r.host,
        }
      })
    },

    async saveSlots(rows) {
      // The table holds a handful of rows, all rewritten under the capacity lock.
      await tx`DELETE FROM factory.capacity_slots`
      for (const r of rows) {
        await tx`
          INSERT INTO factory.capacity_slots (id, name, requested_at, seen_at, slot, leased_until, granted_at, run_ms, rss_mib,
             peak_rss_mib, why, cwd, passed_at, passed_by, why_kind, wait_split, host)
          VALUES (${r.id}, ${r.name}, ${r.requestedAt}, ${r.seenAt}, ${r.slot}, ${r.leasedUntil}, ${r.grantedAt}, ${r.runMs},
                  ${r.rssMib}, ${r.peakRssMib}, ${r.why}, ${r.cwd}, ${r.passedAt}, ${r.passedBy}, ${r.whyKind},
                  ${JSON.stringify(r.waitSplit)}::text::jsonb, ${r.host})`
      }
    },

    async recordSlotWait(w) {
      await tx`
        INSERT INTO factory.slot_waits (at, name, repo, cwd, outcome, wait_ms, split, host)
        VALUES (${w.at}, ${w.name}, ${w.repo}, ${w.cwd}, ${w.outcome}, ${Math.round(w.waitMs)}, ${JSON.stringify(w.split)}::text::jsonb,
                ${w.host ?? null})`
    },

    async recordStepCost(c) {
      const [row] = await tx`
        INSERT INTO factory.step_costs (at, name, repo, peak_rss_mib, cpu_seconds, duration_ms, wait_ms, exit_code,
           vcs_ref_head_revision, dirty, cwd, host, tree, disagreed, disagreement)
        VALUES (${c.at}, ${c.name}, ${c.repo}, ${c.peakRssMib}, ${c.cpuSeconds}, ${c.durationMs}, ${c.waitMs}, ${c.exitCode},
           ${c.commit ?? null}, ${c.dirty ?? null}, ${c.cwd}, ${c.host ?? null}, ${c.tree ?? null}, ${c.disagreed ?? null},
           ${c.disagreement === undefined ? null : JSON.stringify(c.disagreement)}::text::jsonb)
        RETURNING id`
      const tests = c.tests ?? []
      if (tests.length === 0) return
      const { id } = z.object({ id: z.coerce.number() }).parse(row)
      // One statement for the whole list: the arrays are unnested into rows.
      await tx`
        INSERT INTO factory.test_results (step_cost_id, at, repo, vcs_ref_head_revision, dirty, test_suite_name,
           test_case_name, test_case_result_status, duration_ms)
        SELECT ${id}::bigint, ${c.at}::timestamptz, ${c.repo}::text, ${c.commit ?? null}::text, ${c.dirty ?? null}::boolean,
               u.suite, u.name, u.status, u.duration
        FROM unnest(
          ${tx.array(
            tests.map((t) => t.suite),
            'TEXT',
          )},
          ${tx.array(
            tests.map((t) => t.name),
            'TEXT',
          )},
          ${tx.array(
            tests.map((t) => t.status),
            'TEXT',
          )},
          ${tx.array(
            tests.map((t) => t.durationMs),
            'INTEGER',
          )}
        ) AS u(suite, name, status, duration)`
    },

    async recordMergeWindow(w) {
      await tx`
        INSERT INTO factory.merge_windows (project, cwd, requested_at, acquired_at, released_at, exit_code)
        VALUES (${w.project}, ${w.cwd}, ${w.requestedAt}, ${w.acquiredAt}, ${w.releasedAt}, ${w.exitCode})`
    },

    async recentRuns(name, limit, swapoutCeilingMb, legacy) {
      // A run that ended while the host was under pressure (level above normal, or swapout above the ceiling in a sample
      // within 90 s of its end) measured a thrashing host, not the step.
      // `limit` newest runs per host, so the VPS's few runs are not crowded out by the mini's many. The mini's pressure
      // samples say nothing of a run on the VPS, so they filter only the mini's runs.
      const rows: unknown[] = await tx`
        SELECT peak_rss_mib, cpu_seconds, duration_ms, host FROM (
          SELECT c.*, row_number() OVER (PARTITION BY coalesce(c.host, 'mini') ORDER BY c.at DESC, c.id DESC) AS rn
          FROM factory.step_costs c
          WHERE (name = ${name}
              OR (${legacy?.repo ?? null}::text IS NOT NULL AND repo = ${legacy?.repo ?? null} AND name ~ '^factory-[0-9]+-[0-9]+ '
                  AND substr(name, strpos(name, ' ')) = ${legacy?.words ?? null}))
            AND (coalesce(c.host, 'mini') <> 'mini' OR NOT EXISTS (
              SELECT 1 FROM factory.host_samples h
              WHERE h.at BETWEEN c.at - interval '90 seconds' AND c.at + interval '90 seconds'
                AND (h.pressure_level > 1 OR h.swapout_mb_per_300s > ${swapoutCeilingMb})))
        ) runs WHERE rn <= ${limit}
        ORDER BY at DESC, id DESC`
      return rows.map((raw) => {
        const row = RunRow.parse(raw)
        return {
          peakRssMib: row.peak_rss_mib,
          cores: row.cpu_seconds === null || row.duration_ms <= 0 ? null : row.cpu_seconds / (row.duration_ms / 1000),
          durationMs: row.duration_ms,
          host: row.host ?? 'mini',
        }
      })
    },

    async benchEvents(name, since) {
      const rows = await tx`
        SELECT at, coalesce(disagreed, false) AS disagreed FROM factory.step_costs
        WHERE name = ${name} AND at >= ${since} AND (disagreed OR (host = 'vps' AND exit_code = 0))`
      return rows.map((raw: unknown) => {
        const r = z.object({ at: z.date(), disagreed: z.boolean() }).parse(raw)
        return { at: r.at, kind: r.disagreed ? ('disagreed' as const) : ('green' as const) }
      })
    },

    async disagreementsOfTest(name, test) {
      const [raw] = await tx`
        SELECT count(*) AS n FROM factory.step_costs
        WHERE name = ${name} AND disagreed AND disagreement->'tests' @> ${JSON.stringify([{ name: test }])}::text::jsonb`
      return z.object({ n: z.coerce.number() }).parse(raw).n
    },

    async recordRemoteSample(sample) {
      await tx`
        INSERT INTO factory.remote_samples (at, memory_pressure, io_pressure, steps_running)
        VALUES (${sample.at}, ${sample.memoryPressure}, ${sample.ioPressure}, ${sample.stepsRunning})
        ON CONFLICT (at) DO NOTHING`
    },

    async pressureBaseline(now) {
      const since = new Date(now.getTime() - BASELINE_WINDOW_MS)
      await tx`DELETE FROM factory.remote_samples WHERE at < ${since}`
      const [raw] = await tx`
        SELECT count(*) AS n, extract(epoch FROM max(at) - min(at)) * 1000 AS span_ms,
          percentile_cont(0.99) WITHIN GROUP (ORDER BY memory_pressure)::float8 AS memory_p99,
          percentile_cont(0.99) WITHIN GROUP (ORDER BY io_pressure)::float8 AS io_p99
        FROM factory.remote_samples
        WHERE steps_running = 0 AND memory_pressure IS NOT NULL AND io_pressure IS NOT NULL AND at >= ${since}`
      const r = z
        .object({
          n: z.coerce.number(),
          span_ms: z.coerce.number().nullable(),
          memory_p99: z.number().nullable(),
          io_p99: z.number().nullable(),
        })
        .parse(raw)
      if (r.n === 0 || r.span_ms === null || r.memory_p99 === null || r.io_p99 === null) return null
      return { samples: r.n, spanMs: Math.round(r.span_ms), memoryP99: r.memory_p99, ioP99: r.io_p99 }
    },

    async recordPlacement(p) {
      await tx`
        INSERT INTO factory.step_placements (at, name, host, reason) VALUES (${p.at}, ${p.name}, ${p.host}, ${p.reason})`
    },

    async stepMedianMs(since) {
      const [raw] = await tx`
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::float8 AS ms FROM factory.step_costs WHERE at >= ${since}`
      const ms = z.object({ ms: z.number().nullable() }).parse(raw ?? { ms: null }).ms
      return ms === null ? null : Math.round(ms)
    },

    async projectPeaks(repo, project, since, limit, swapoutCeilingMb) {
      const rows: unknown[] = await tx`
        SELECT step, peak_rss_mib FROM (
          SELECT regexp_replace(c.name, '^factory-[0-9]+-[0-9]+ ', ${`${project} `}) AS step, c.peak_rss_mib,
                 row_number() OVER (PARTITION BY regexp_replace(c.name, '^factory-[0-9]+-[0-9]+ ', ${`${project} `})
                                    ORDER BY c.at DESC, c.id DESC) AS rn
          FROM factory.step_costs c
          WHERE c.repo = ${repo} AND c.at >= ${since}
            AND NOT EXISTS (
              SELECT 1 FROM factory.host_samples h
              WHERE h.at BETWEEN c.at - interval '90 seconds' AND c.at + interval '90 seconds'
                AND (h.pressure_level > 1 OR h.swapout_mb_per_300s > ${swapoutCeilingMb}))
        ) newest WHERE rn <= ${limit}`
      const peaks = new Map<string, (number | null)[]>()
      for (const raw of rows) {
        const row = ProjectPeakRow.parse(raw)
        peaks.set(row.step, [...(peaks.get(row.step) ?? []), row.peak_rss_mib])
      }
      return peaks
    },

    async latestHostSample() {
      const [raw] =
        await tx`SELECT at, memory_used_pct, kernel_free_pct FROM factory.host_samples ORDER BY at DESC LIMIT 1`
      if (!raw) return null
      const row = HostSampleRow.parse(raw)
      return { at: row.at, memoryUsedPct: row.memory_used_pct, kernelFreePct: row.kernel_free_pct }
    },

    async recentHostSamples(limit) {
      const rows: unknown[] = await tx`
        SELECT at, load, memory_used_pct, swap_used_pct, swapout_mb_per_300s, processes, pressure_level, kernel_free_pct FROM factory.host_samples ORDER BY at DESC LIMIT ${limit}`
      return rows.map((raw): HostSampleFact => {
        const row = HostFactRow.parse(raw)
        return {
          at: row.at,
          load: row.load,
          memoryUsedPct: row.memory_used_pct,
          swapUsedPct: row.swap_used_pct,
          swapoutMbPer300s: row.swapout_mb_per_300s,
          processes: row.processes,
          pressureLevel: row.pressure_level,
          kernelFreePct: row.kernel_free_pct,
        }
      })
    },

    async slotAim() {
      const [raw] = await tx`SELECT target, quiet_since FROM factory.slot_aim WHERE id = 1`
      if (!raw) return null
      const row = AimRow.parse(raw)
      return { target: row.target, quietSince: row.quiet_since } satisfies AimState
    },

    async saveSlotAim(state, at) {
      await tx`
        INSERT INTO factory.slot_aim (id, target, quiet_since, changed_at) VALUES (1, ${state.target}, ${state.quietSince}, ${at})
        ON CONFLICT (id) DO UPDATE SET target = EXCLUDED.target, quiet_since = EXCLUDED.quiet_since,
          changed_at = CASE WHEN factory.slot_aim.target = EXCLUDED.target THEN factory.slot_aim.changed_at ELSE EXCLUDED.changed_at END`
    },

    async leadAim() {
      const [raw] = await tx`SELECT lead_target, lead_since FROM factory.slot_aim WHERE id = 1`
      if (!raw) return null
      const row = LeadAimRow.parse(raw)
      return row.lead_target === null ? null : ({ target: row.lead_target, since: row.lead_since } satisfies LeadAim)
    },

    async saveLeadAim(state) {
      // the slot aim's row holds it; the slot pass has stored the row by the time this runs, and a missing row stores nothing
      await tx`UPDATE factory.slot_aim SET lead_target = ${state.target}, lead_since = ${state.since} WHERE id = 1`
    },

    async recordSlotShadow(r) {
      await tx`
        INSERT INTO factory.slot_shadow (at, live_slots, live_max, aim_slots, holders, waiters, pressure_level, swap_used_pct,
          swapout_mb_per_300s, swap_growing, load, reason, lead_aim, leads_running)
        VALUES (${r.at}, ${r.liveSlots}, ${r.liveMax}, ${r.aimSlots}, ${r.holders}, ${r.waiters}, ${r.pressureLevel},
          ${r.swapUsedPct}, ${r.swapoutMbPer300s}, ${r.swapGrowing}, ${r.load}, ${r.reason}, ${r.leadAim}, ${r.leadsRunning})
        ON CONFLICT (at) DO NOTHING`
    },

    async pruneSlotShadow(before) {
      const rows: unknown[] = await tx`DELETE FROM factory.slot_shadow WHERE at < ${before} RETURNING at`
      return rows.length
    },

    async leadPeaks(now) {
      // An attempt's peak is its worktree's largest sample of the six hours before its last one, from the relearn point
      // on: a long-lived worktree does not carry a step it no longer runs. Settled: ended (no sample for ten minutes) or run for 30.
      const rows: unknown[] = await tx`
        WITH counted AS (
          SELECT s.repo, s.worktree, s.at, s.rss_mib FROM factory.lead_samples s
          LEFT JOIN factory.lead_relearn r ON r.repo = s.repo
          WHERE s.outside_slots AND (r.at IS NULL OR s.at >= r.at)
        ), lasts AS (
          SELECT repo, worktree, max(at) AS last_at FROM counted GROUP BY repo, worktree
        ), peaks AS (
          SELECT c.repo, c.worktree, max(c.rss_mib) AS peak, l.last_at, min(c.at) AS first_at
          FROM counted c JOIN lasts l ON l.repo = c.repo AND l.worktree = c.worktree
          WHERE c.at >= l.last_at - ${LEARN_WINDOW_MS / 1000} * interval '1 second'
          GROUP BY c.repo, c.worktree, l.last_at
        ), ranked AS (
          SELECT repo, peak, last_at, first_at, row_number() OVER (PARTITION BY repo ORDER BY last_at DESC, worktree) AS newest,
            count(*) OVER (PARTITION BY repo) AS n
          FROM peaks
        )
        SELECT repo, peak, n,
          (last_at <= ${new Date(now.getTime() - ENDED_AFTER_MS)} OR last_at - first_at >= ${SETTLED_RUN_MS / 1000} * interval '1 second') AS settled
        FROM ranked WHERE newest <= ${PEAKS_FETCHED} ORDER BY repo, newest`
      const byRepo = new Map<string, LeadPeaks>()
      for (const raw of rows) {
        const row = PeakFactRow.parse(raw)
        const found = byRepo.get(row.repo) ?? { repo: row.repo, attempts: row.n, peaksNewestFirst: [] }
        found.peaksNewestFirst.push({ peakMib: row.peak, settled: row.settled })
        byRepo.set(row.repo, found)
      }
      return [...byRepo.values()]
    },

    async worktreeSizes() {
      const rows: unknown[] = await tx`
        WITH ranked AS (
          SELECT repo, mib, row_number() OVER (PARTITION BY repo ORDER BY measured_at DESC, worktree) AS newest,
            count(*) OVER (PARTITION BY repo) AS n
          FROM factory.worktree_sizes
        )
        SELECT repo, mib, n FROM ranked WHERE newest <= 20 ORDER BY repo, newest`
      const byRepo = new Map<string, WorktreeSizes>()
      for (const raw of rows) {
        const row = SizeRow.parse(raw)
        const found = byRepo.get(row.repo) ?? { repo: row.repo, attempts: row.n, sizesMibNewestFirst: [] }
        found.sizesMibNewestFirst.push(row.mib)
        byRepo.set(row.repo, found)
      }
      return [...byRepo.values()]
    },

    async relearns() {
      const rows: unknown[] = await tx`SELECT repo, at, set_at, set_by FROM factory.lead_relearn ORDER BY repo`
      return rows.map((raw) => {
        const row = RelearnRow.parse(raw)
        return { repo: row.repo, at: row.at, setAt: row.set_at, setBy: row.set_by }
      })
    },

    async setRelearn(r) {
      await tx`
        INSERT INTO factory.lead_relearn (repo, at, set_at, set_by) VALUES (${r.repo}, ${r.at}, ${r.setAt}, ${r.setBy})
        ON CONFLICT (repo) DO UPDATE SET at = EXCLUDED.at, set_at = EXCLUDED.set_at, set_by = EXCLUDED.set_by`
    },

    async openWaits() {
      const rows: unknown[] = await tx`SELECT id, issue_id, kind FROM factory.queue_intervals WHERE to_at IS NULL`
      return rows.map((raw) => {
        const row = z.object({ id: z.coerce.number().int(), issue_id: z.string(), kind: z.string() }).parse(raw)
        return { id: row.id, issue: row.issue_id, kind: row.kind }
      })
    },

    async applyWaits(at, plan, keepSince) {
      if (plan.close.length > 0) {
        await tx`UPDATE factory.queue_intervals SET to_at = ${at} WHERE id IN ${tx([...plan.close])}`
      }
      for (const w of plan.start) {
        await tx`
          INSERT INTO factory.queue_intervals (issue_id, project, kind, message, from_at)
          VALUES (${w.issue}, ${w.project}, ${w.kind}, ${w.message}, ${at})`
      }
      await tx`DELETE FROM factory.queue_intervals WHERE to_at IS NOT NULL AND to_at < ${keepSince}`
    },

    async leadRssSince(since) {
      const rows: unknown[] = await tx`
        SELECT DISTINCT ON (issue) issue, rss_mib FROM factory.lead_samples
        WHERE at >= ${since} AND issue IS NOT NULL ORDER BY issue, at DESC`
      return new Map(
        rows.map((raw) => {
          const row = RssRow.parse(raw)
          return [row.issue, row.rss_mib]
        }),
      )
    },
  }
}
