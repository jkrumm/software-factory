import type { SQL } from 'bun'
import * as z from 'zod'
import type { ClassIssue } from '../domains/loops/classes.ts'
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

const QueueRowSchema = z.object({
  id: z.string(),
  repo: z.string(),
  state: z.string(),
  title: z.string(),
  kind: z.string(),
  filed_at: z.date(),
  summary: z.string(),
  prio: z.number().int(),
  blockers: z.string(),
})

const Holder = z.object({ id: z.string(), state: z.enum(['working', 'watching']), blockers: z.array(z.string()) })

const Blocked = z.object({
  issue_id: z.string(),
  watch: z.number().int(),
  attempt: z.number().int(),
  checks: z.number().int(),
  since: z.date(),
  detail: z.string().nullable(),
})

const ClassRow = z.object({
  loop: z.enum(['friction', 'hygiene']),
  repo: z.string(),
  class: z.string(),
  issue: z.string(),
  filed_at: z.date(),
  closed_at: z.date().nullable(),
  outcome: z.enum(['done', 'healed', 'dropped', 'cancelled']).nullable(),
})

const classRows = (rows: unknown[]) =>
  rows.map((raw) => {
    const row = ClassRow.parse(raw)
    const issue: ClassIssue = {
      issue: row.issue,
      filedAt: row.filed_at,
      closedAt: row.closed_at,
      outcome: row.outcome,
    }
    return { loop: row.loop, repo: row.repo, class: row.class, issue }
  })

/**
 * What the loops read across the work, intake and quality tables: which Issues stall, which still settle, what is open
 * beside an Issue, and whose watch has a checkout that stays blocked. Read-only SQL on the caller's transaction.
 */
export function loopReads(tx: SQL): LoopReads {
  // A finding's Issues: filed at its `filed` event, closed at the applied event that moved it to `closed`.
  const classes = async (filter: { loop: string; repo: string } | null) => {
    const rows: unknown[] = await tx`
      SELECT lf.loop, lf.repo, lf.class, i.id AS issue, f.at AS filed_at, i.outcome,
        (SELECT c.at FROM factory.issue_events c WHERE c.issue_id = i.id AND c.result = 'applied' AND c.to_state = 'closed' ORDER BY c.version DESC LIMIT 1) AS closed_at
      FROM factory.loop_findings lf
      JOIN factory.issues i ON i.id = lf.issue_id
      JOIN factory.issue_events f ON f.issue_id = i.id AND f.kind = 'filed' AND f.version = 1
      WHERE ${filter === null ? tx`TRUE` : tx`lf.loop = ${filter.loop} AND lf.repo = ${filter.repo}`}
      ORDER BY lf.loop, lf.repo, lf.class, i.id`
    return classRows(rows)
  }

  return {
    async stalled(limit) {
      const rows: { id: string }[] = await tx`
        SELECT id FROM factory.issues
        WHERE state = 'waiting' AND wait_reason IN ${tx(STALL_REASONS)}
        ORDER BY id LIMIT ${limit}`
      return rows.map((row) => row.id as IssueId)
    },

    async working(limit) {
      const rows: { id: string }[] = await tx`
        SELECT id FROM factory.issues WHERE state = 'working' ORDER BY id LIMIT ${limit}`
      return rows.map((row) => row.id as IssueId)
    },

    async settling(limit) {
      const rows: unknown[] = await tx`
        SELECT i.id, i.repo,
          f.payload->>'title' AS title, COALESCE((SELECT s.payload->>'kind' FROM factory.issue_events s WHERE s.issue_id = i.id AND s.kind = 'settled' AND s.result = 'applied' ORDER BY s.version DESC LIMIT 1), f.payload->>'kind') AS kind, f.payload->>'origin' AS origin, f.at AS filed_at,
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
        SELECT i.id, i.state, e.payload->>'title' AS title, COALESCE((SELECT s.payload->>'kind' FROM factory.issue_events s WHERE s.issue_id = i.id AND s.kind = 'settled' AND s.result = 'applied' ORDER BY s.version DESC LIMIT 1), e.payload->>'kind') AS kind
        FROM factory.issues i
        JOIN factory.issue_events e ON e.issue_id = i.id AND e.kind = 'filed' AND e.version = 1
        WHERE i.repo = ${repo} AND i.state <> 'closed' AND i.id <> ${excluding}
        ORDER BY i.id DESC LIMIT ${limit}`
      return rows.map((raw) => Candidate.parse(raw)).map((row) => ({ ...row, id: row.id as IssueId }))
    },

    async queueIssues() {
      const rows: unknown[] = await tx`
        SELECT i.id, i.repo, i.state, f.payload->>'title' AS title, COALESCE((SELECT s.payload->>'kind' FROM factory.issue_events s WHERE s.issue_id = i.id AND s.kind = 'settled' AND s.result = 'applied' ORDER BY s.version DESC LIMIT 1), f.payload->>'kind') AS kind, f.at AS filed_at,
          COALESCE((SELECT s.text FROM factory.intake_signals s WHERE s.issue_id = i.id ORDER BY s.received_at LIMIT 1), '') AS summary,
          COALESCE((SELECT p.value FROM factory.planning_prios p WHERE p.issue_id = i.id ORDER BY p.at DESC, p.id DESC LIMIT 1), 0) AS prio,
          COALESCE((SELECT string_agg(e.after_issue, ',' ORDER BY e.after_issue) FROM factory.planning_edges e JOIN factory.issues b ON b.id = e.after_issue WHERE e.issue_id = i.id AND e.satisfied_at IS NULL AND b.state <> 'closed'), '') AS blockers
        FROM factory.issues i
        JOIN factory.issue_events f ON f.issue_id = i.id AND f.kind = 'filed' AND f.version = 1
        WHERE i.state IN ('queued', 'working', 'waiting', 'watching')
        ORDER BY i.repo, i.id`
      return rows.map((raw) => {
        const row = QueueRowSchema.parse(raw)
        return {
          id: row.id as IssueId,
          repo: row.repo,
          title: row.title,
          kind: row.kind,
          state: row.state,
          prio: row.prio,
          filedAt: row.filed_at,
          summary: row.summary,
          blockers: row.blockers === '' ? [] : (row.blockers.split(',') as IssueId[]),
        }
      })
    },

    async claimHolders(queued, limit) {
      if (queued.length === 0) return []
      // Only the open planning edges: a holder that waits on a queued Issue of its own repo, by structure and never by text.
      const rows: unknown[] = await tx`
        SELECT h.id, h.state, array_agg(b.id ORDER BY b.id) AS blockers
        FROM factory.planning_edges e
        JOIN factory.issues h ON h.id = e.issue_id AND h.state IN ('working', 'watching')
        JOIN factory.issues b ON b.id = e.after_issue AND b.state = 'queued' AND b.repo = h.repo
        WHERE e.satisfied_at IS NULL AND b.id IN ${tx([...queued])}
        GROUP BY h.id, h.state
        ORDER BY h.id LIMIT ${limit}`
      return rows.map((raw) => {
        const row = Holder.parse(raw)
        return { issue: row.id as IssueId, state: row.state, blockers: row.blockers as IssueId[] }
      })
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

    async classIssues(loop, repo) {
      const out: Record<string, ClassIssue[]> = {}
      for (const row of await classes({ loop, repo })) (out[row.class] ??= []).push(row.issue)
      return out
    },

    async allClassIssues() {
      const groups = new Map<
        string,
        { loop: 'friction' | 'hygiene'; repo: string; class: string; issues: ClassIssue[] }
      >()
      for (const row of await classes(null)) {
        const id = `${row.loop}\u0000${row.repo}\u0000${row.class}`
        const group = groups.get(id) ?? { loop: row.loop, repo: row.repo, class: row.class, issues: [] }
        group.issues.push(row.issue)
        groups.set(id, group)
      }
      return [...groups.values()]
    },
  }
}
