import type { SQL } from 'bun'
import * as z from 'zod'
import type { AccountReading } from '../../domains/capacity/accounts.ts'
import type { Claim } from '../../domains/capacity/claims.ts'
import type { Assignment, CapacityStore } from '../../domains/capacity/ports.ts'
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
})

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
      const rows: unknown[] = await tx`
        SELECT DISTINCT ON (account) account, read_at, sampled_at, enabled, auth_ok, five_hour_used, weekly_used,
          five_hour_resets_at, weekly_resets_at, exhausted_until
        FROM factory.capacity_readings ORDER BY account, id DESC`
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
        }
      })
    },

    async saveSlots(rows) {
      // The table holds a handful of rows, all rewritten under the capacity lock.
      await tx`DELETE FROM factory.capacity_slots`
      for (const r of rows) {
        await tx`
          INSERT INTO factory.capacity_slots (id, name, requested_at, seen_at, slot, leased_until, granted_at, run_ms)
          VALUES (${r.id}, ${r.name}, ${r.requestedAt}, ${r.seenAt}, ${r.slot}, ${r.leasedUntil}, ${r.grantedAt}, ${r.runMs})`
      }
    },
  }
}
