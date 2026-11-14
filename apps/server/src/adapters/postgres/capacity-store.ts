import type { SQL } from 'bun'
import * as z from 'zod'
import type { AccountReading } from '../../domains/capacity/accounts.ts'
import type { Claim } from '../../domains/capacity/claims.ts'
import type { Assignment, CapacityStore, HostSampleFact, LeadPeaks } from '../../domains/capacity/ports.ts'
import type { AimState } from '../../domains/capacity/slot-aim.ts'
import { QUEUE_STATES, type QueueStates } from '../../domains/capacity/queue-state.ts'
import type { SlotRow } from '../../domains/capacity/slots.ts'
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
})

const RankDbRow = z.object({
  lane: z.string(),
  read_at: z.date(),
  picked_at: z.date(),
  // the driver hands jsonb back as text
  ordering: z.preprocess(
    (v) => (typeof v === 'string' ? JSON.parse(v) : v),
    z.array(z.object({ account: z.string(), reason: z.string(), weight: z.number().nullable() })),
  ),
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
})

const PeakRow = z.object({ peak_rss_mib: z.number().int().nullable() })
const HostSampleRow = z.object({ at: z.date(), memory_used_pct: z.number().nullable() })

const HostFactRow = z.object({
  at: z.date(),
  load: z.number().nullable(),
  memory_used_pct: z.number().nullable(),
  swap_used_pct: z.number().nullable(),
  swapout_mb_per_300s: z.number().nullable(),
  processes: z.number().int().nullable(),
  pressure_level: z.number().int().nullable(),
})
const AimRow = z.object({ target: z.number().int(), quiet_since: z.date().nullable() })
const PeakFactRow = z.object({ repo: z.string(), peak: z.number().int(), n: z.coerce.number().int() })
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
             weekly_resets_at, exhausted_until)
          VALUES (${r.account}, ${r.readAt}, ${r.sampledAt}, ${r.enabled}, ${r.authOk}, ${r.fiveHourUsed}, ${r.weeklyUsed},
                  ${r.fiveHourResetsAt}, ${r.weeklyResetsAt}, ${r.exhaustedUntil})`
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
      // the owner's login Errand closes: `auth_ok` is what stops new admissions on it (`standing`).
      const rows: unknown[] = await tx`
        SELECT DISTINCT ON (r.account) r.account, r.read_at, r.sampled_at, r.enabled,
          (r.auth_ok AND NOT EXISTS (
            SELECT 1 FROM factory.account_auth_marks m WHERE m.account = r.account AND m.cleared_at IS NULL
          )) AS auth_ok,
          r.five_hour_used, r.weekly_used, r.five_hour_resets_at, r.weekly_resets_at, r.exhausted_until
        FROM factory.capacity_readings r ORDER BY r.account, r.id DESC`
      return rows.map((raw): AccountReading => {
        const r = ReadingRow.parse(raw)
        return {
          account: r.account,
          readAt: r.read_at,
          sampledAt: r.sampled_at,
          enabled: r.enabled,
          authOk: r.auth_ok,
          fiveHourUsed: r.five_hour_used,
          weeklyUsed: r.weekly_used,
          fiveHourResetsAt: r.five_hour_resets_at,
          weeklyResetsAt: r.weekly_resets_at,
          exhaustedUntil: r.exhausted_until,
        }
      })
    },

    async recordRank(rank) {
      await tx`
        INSERT INTO factory.capacity_ranks (lane, read_at, picked_at, ordering)
        VALUES (${rank.lane}, ${rank.readAt}, ${rank.at}, ${JSON.stringify(rank.order)}::jsonb)
        ON CONFLICT (lane) DO UPDATE
          SET read_at = EXCLUDED.read_at, picked_at = EXCLUDED.picked_at, ordering = EXCLUDED.ordering`
    },

    async latestRank(lane) {
      const [raw] = await tx`SELECT lane, read_at, picked_at, ordering FROM factory.capacity_ranks WHERE lane = ${lane}`
      if (!raw) return null
      const row = RankDbRow.parse(raw)
      return { lane: row.lane, order: row.ordering, at: row.picked_at, readAt: row.read_at }
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
        }
      })
    },

    async saveSlots(rows) {
      // The table holds a handful of rows, all rewritten under the capacity lock.
      await tx`DELETE FROM factory.capacity_slots`
      for (const r of rows) {
        await tx`
          INSERT INTO factory.capacity_slots (id, name, requested_at, seen_at, slot, leased_until, granted_at, run_ms, rss_mib,
             peak_rss_mib, why, cwd)
          VALUES (${r.id}, ${r.name}, ${r.requestedAt}, ${r.seenAt}, ${r.slot}, ${r.leasedUntil}, ${r.grantedAt}, ${r.runMs},
                  ${r.rssMib}, ${r.peakRssMib}, ${r.why}, ${r.cwd})`
      }
    },

    async recordStepCost(c) {
      const [row] = await tx`
        INSERT INTO factory.step_costs (at, name, repo, peak_rss_mib, cpu_seconds, duration_ms, wait_ms, exit_code,
           vcs_ref_head_revision, dirty)
        VALUES (${c.at}, ${c.name}, ${c.repo}, ${c.peakRssMib}, ${c.cpuSeconds}, ${c.durationMs}, ${c.waitMs}, ${c.exitCode},
           ${c.commit ?? null}, ${c.dirty ?? null})
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

    async recentPeaks(name, limit) {
      const rows: unknown[] = await tx`
        SELECT peak_rss_mib FROM factory.step_costs WHERE name = ${name} ORDER BY at DESC, id DESC LIMIT ${limit}`
      return rows.map((raw) => PeakRow.parse(raw).peak_rss_mib)
    },

    async latestHostSample() {
      const [raw] = await tx`SELECT at, memory_used_pct FROM factory.host_samples ORDER BY at DESC LIMIT 1`
      if (!raw) return null
      const row = HostSampleRow.parse(raw)
      return { at: row.at, memoryUsedPct: row.memory_used_pct }
    },

    async recentHostSamples(limit) {
      const rows: unknown[] = await tx`
        SELECT at, load, memory_used_pct, swap_used_pct, swapout_mb_per_300s, processes, pressure_level FROM factory.host_samples ORDER BY at DESC LIMIT ${limit}`
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

    async recordSlotShadow(r) {
      await tx`
        INSERT INTO factory.slot_shadow (at, live_slots, live_max, aim_slots, holders, waiters, pressure_level, swap_used_pct,
          swapout_mb_per_300s, swap_growing, load, reason)
        VALUES (${r.at}, ${r.liveSlots}, ${r.liveMax}, ${r.aimSlots}, ${r.holders}, ${r.waiters}, ${r.pressureLevel},
          ${r.swapUsedPct}, ${r.swapoutMbPer300s}, ${r.swapGrowing}, ${r.load}, ${r.reason})
        ON CONFLICT (at) DO NOTHING`
    },

    async pruneSlotShadow(before) {
      const rows: unknown[] = await tx`DELETE FROM factory.slot_shadow WHERE at < ${before} RETURNING at`
      return rows.length
    },

    async leadPeaks() {
      const rows: unknown[] = await tx`
        WITH peaks AS (
          SELECT repo, worktree, max(rss_mib) AS peak, max(at) AS last_at
          FROM factory.lead_samples GROUP BY repo, worktree
        ), ranked AS (
          SELECT repo, peak, last_at, row_number() OVER (PARTITION BY repo ORDER BY last_at DESC, worktree) AS newest,
            count(*) OVER (PARTITION BY repo) AS n
          FROM peaks
        )
        SELECT repo, peak, n FROM ranked WHERE newest <= 10 ORDER BY repo, newest`
      const byRepo = new Map<string, LeadPeaks>()
      for (const raw of rows) {
        const row = PeakFactRow.parse(raw)
        const found = byRepo.get(row.repo) ?? { repo: row.repo, attempts: row.n, peaksNewestFirst: [] }
        found.peaksNewestFirst.push(row.peak)
        byRepo.set(row.repo, found)
      }
      return [...byRepo.values()]
    },

    async recordShadow(d, keepSince) {
      await tx`
        INSERT INTO factory.admission_shadow (at, candidates, live_admits, shadow_admits, live_refusal, shadow_refusal,
          shadow_message, load, load_ceiling, shadow_load_ceiling, processes, process_cap)
        VALUES (${d.at}, ${d.candidates}, ${d.liveAdmits}, ${d.shadowAdmits}, ${d.liveRefusal}, ${d.shadowRefusal},
          ${d.shadowMessage}, ${d.load}, ${d.loadCeiling}, ${d.shadowLoadCeiling}, ${d.processes}, ${d.processCap})
        ON CONFLICT (at) DO NOTHING`
      await tx`DELETE FROM factory.admission_shadow WHERE at < ${keepSince}`
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
