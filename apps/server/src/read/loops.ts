import type { SQL } from 'bun'
import * as z from 'zod'
import type { LoopReads } from '../domains/loops/ports.ts'
import type { IssueId } from '../kernel/ids.ts'

const KINDS = ['feature', 'bug', 'chore', 'docs', 'incident'] as const

/** `waiting` for these reasons is a stall (`WAITS` in the work domain: `stall: true`). */
const STALL_REASONS = ['wall', 'unreported', 'blocked', 'lead_gone', 'regressed']

const Settling = z.object({
  id: z.string(),
  repo: z.string(),
  title: z.string(),
  kind: z.enum(KINDS),
  origin: z.string(),
  filed_at: z.date(),
  from_alert: z.boolean(),
  text: z.string(),
})

const Candidate = z.object({ id: z.string(), title: z.string(), kind: z.string(), state: z.string() })

const Blocked = z.object({
  issue_id: z.string(),
  watch: z.number().int(),
  attempt: z.number().int(),
  checks: z.number().int(),
  since: z.date(),
  detail: z.string().nullable(),
})

/**
 * What the loops read across the work, intake and quality tables: which Issues stall, which still settle, what is open
 * beside an Issue, and whose watch has a checkout that stays blocked. Read-only SQL on the caller's transaction.
 */
export function loopReads(tx: SQL): LoopReads {
  return {
    async stalled(limit) {
      const rows: { id: string }[] = await tx`
        SELECT id FROM factory.issues
        WHERE state = 'waiting' AND wait_reason IN ${tx(STALL_REASONS)}
        ORDER BY id LIMIT ${limit}`
      return rows.map((row) => row.id as IssueId)
    },

    async settling(limit) {
      const rows: unknown[] = await tx`
        SELECT i.id, i.repo,
          f.payload->>'title' AS title, f.payload->>'kind' AS kind, f.payload->>'origin' AS origin, f.at AS filed_at,
          EXISTS (SELECT 1 FROM factory.intake_signals s WHERE s.issue_id = i.id AND s.alert IS NOT NULL) AS from_alert,
          COALESCE((SELECT s.text FROM factory.intake_signals s WHERE s.issue_id = i.id ORDER BY s.received_at LIMIT 1), '') AS text
        FROM factory.issues i
        JOIN factory.issue_events f ON f.issue_id = i.id AND f.kind = 'filed' AND f.version = 1
        WHERE i.state = 'settling'
        ORDER BY i.id LIMIT ${limit}`
      return rows.map((raw) => {
        const row = Settling.parse(raw)
        return {
          issue: row.id as IssueId,
          repo: row.repo,
          title: row.title,
          kind: row.kind,
          origin: row.origin,
          filedAt: row.filed_at,
          fromAlert: row.from_alert,
          text: row.text,
        }
      })
    },

    async openIssues(repo, excluding, limit) {
      const rows: unknown[] = await tx`
        SELECT i.id, i.state, e.payload->>'title' AS title, e.payload->>'kind' AS kind
        FROM factory.issues i
        JOIN factory.issue_events e ON e.issue_id = i.id AND e.kind = 'filed' AND e.version = 1
        WHERE i.repo = ${repo} AND i.state <> 'closed' AND i.id <> ${excluding}
        ORDER BY i.id DESC LIMIT ${limit}`
      return rows.map((raw) => Candidate.parse(raw)).map((row) => ({ ...row, id: row.id as IssueId }))
    },

    async blockedCheckouts(streak, limit) {
      // The open watch of a watching Issue, with its newest `streak` checks: all of them blocked.
      const rows: unknown[] = await tx`
        SELECT w.issue_id, w.watch, w.attempt, last.checks, last.since,
          (SELECT c.checks::text FROM factory.quality_checks c WHERE c.watch_key = w.key ORDER BY c.n DESC LIMIT 1) AS detail
        FROM factory.quality_watches w
        JOIN factory.issues i ON i.id = w.issue_id AND i.state = 'watching'
        JOIN LATERAL (
          SELECT count(*)::int AS checks, min(at) AS since
          FROM (SELECT outcome, at FROM factory.quality_checks WHERE watch_key = w.key ORDER BY n DESC LIMIT ${streak}) recent
          WHERE outcome = 'blocked'
        ) last ON last.checks >= ${streak}
        WHERE w.answer IS NULL
        ORDER BY w.issue_id LIMIT ${limit}`
      return rows.map((raw) => {
        const row = Blocked.parse(raw)
        return {
          issue: row.issue_id as IssueId,
          watch: row.watch,
          attempt: row.attempt,
          checks: row.checks,
          since: row.since,
          detail: row.detail ?? '',
        }
      })
    },
  }
}
