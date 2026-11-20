import type { SQL } from 'bun'
import * as z from 'zod'
import type { ClassIssue, FindingLoop } from '../domains/loops/classes.ts'
import type { ClosedFinding } from '../domains/loops/ledger.ts'
import type { DigestIssue } from '../kernel/digest-scope.ts'
import type { FindingIssue } from '../domains/loops/hygiene-lifecycle.ts'
import type { LoopReads } from '../domains/loops/ports.ts'
import { readEdgeNeed, readHeldEdges, readRemovedEdges } from './edge-need.ts'
import { readSpecPrecedents } from './spec-screen.ts'
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
  stated_edges: z.boolean(),
  text: z.string(),
  prio: z.number().int(),
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
  size: z.enum(['small', 'medium', 'large']).nullable(),
})

const Holder = z.object({ id: z.string(), state: z.enum(['working', 'watching']), blockers: z.array(z.string()) })

const DigestRow = z.object({
  id: z.string(),
  repo: z.string(),
  state: z.enum(['settling', 'queued', 'working', 'waiting', 'watching', 'closed']),
  title: z.string(),
  kind: z.string().nullable(),
  wait_reason: z.string().nullable(),
  outcome: z.string().nullable(),
  at: z.date(),
  after: z.array(z.string()),
})

const Refusal = z.object({ id: z.string(), repo: z.string(), since: z.date(), refusals: z.number().int() })

const Blocked = z.object({
  issue_id: z.string(),
  watch: z.number().int(),
  attempt: z.number().int(),
  checks: z.number().int(),
  since: z.date(),
  detail: z.string().nullable(),
})

const ClassRow = z.object({
  loop: z.enum(['friction', 'hygiene', 'selfwatch']),
  repo: z.string(),
  class: z.string(),
  issue: z.string(),
  filed_at: z.date(),
  closed_at: z.date().nullable(),
  outcome: z.enum(['done', 'healed', 'dropped', 'cancelled']).nullable(),
})

const ProcessMinuteRow = z.object({
  at: z.date(),
  pid: z.number().int(),
  name: z.string(),
  class: z.string(),
  repo: z.string().nullable(),
  issue: z.number().int().nullable(),
  footprint_mib: z.number().int(),
})

const HostMinuteRow = z.object({
  at: z.date(),
  swap_used_pct: z.number().nullable(),
  processes: z.number().int().nullable(),
})

const CapacityMinuteRow = z.object({
  at: z.date(),
  load: z.number().nullable(),
  load_ceiling: z.number().nullable(),
  leads: z.number().int().nullable(),
  seats: z.number().int().nullable(),
  memory_used_pct: z.number().nullable(),
  swap_used_pct: z.number().nullable(),
  swapout_mb_per_300s: z.number().nullable(),
  compressor_mib: z.number().int().nullable(),
  pressure_level: z.number().int().nullable(),
})

const AdmissionRow = z.object({ at: z.date(), issue_id: z.string(), load: z.coerce.number().nullable() })

const SlotMinuteRow = z.object({
  at: z.date(),
  live_slots: z.number().int(),
  aim_slots: z.number().int(),
  holders: z.number().int(),
  waiters: z.number().int(),
})

const ClassCpuRow = z.object({
  class: z.string(),
  repo: z.string().nullable(),
  cpu_ms: z.coerce.number(),
  minutes: z.coerce.number().int(),
})

const HostCpuSplitRow = z.object({
  samples: z.coerce.number().int(),
  idle: z.coerce.number().nullable(),
  usr: z.coerce.number().nullable(),
  sys: z.coerce.number().nullable(),
})

const QueueReasonRow = z.object({ kind: z.string(), count: z.coerce.number().int(), since: z.date() })

const WaitRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  reason: z.enum(['timer', 'dependency']),
  wait: z.object({
    since: z.number().int(),
    until: z.string().optional(),
    after: z.array(z.string()).optional(),
  }),
  since_at: z.date().nullable(),
})

const ClosedRow = z.object({
  issue: z.string(),
  loop: z.enum(['friction', 'hygiene', 'selfwatch', 'throughput']),
  repo: z.string(),
  key: z.string(),
  figure: z.coerce.number().nullable(),
  verdict: z.enum(['moved', 'flat', 'worse', 'unmeasured']).nullable(),
  outcome: z.enum(['done', 'healed', 'dropped', 'cancelled']),
  filed_at: z.date(),
  closed_at: z.date(),
})

const FindingIssueRow = z.object({
  key: z.string(),
  issue: z.string(),
  state: z.enum(['settling', 'queued', 'working', 'waiting', 'watching', 'closed']),
  outcome: z.enum(['done', 'healed', 'dropped', 'cancelled']).nullable(),
  closed_at: z.date().nullable(),
  reopens: z.number().int(),
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
    return { loop: row.loop, class: row.class, issue }
  })

/**
 * What the loops read across the work, intake and quality tables: which Issues stall, which still settle, what is open
 * beside an Issue, and whose watch has a checkout that stays blocked. Read-only SQL on the caller's transaction.
 */
export function loopReads(tx: SQL): LoopReads {
  // A finding's Issues: filed at its `filed` event, closed at the applied event that moved it to `closed`.
  const classes = async (filter: { loop: string } | null) => {
    const rows: unknown[] = await tx`
      SELECT lf.loop, lf.repo, lf.class, i.id AS issue, f.at AS filed_at, i.outcome,
        (SELECT c.at FROM factory.issue_events c WHERE c.issue_id = i.id AND c.result = 'applied' AND c.to_state = 'closed' ORDER BY c.version DESC LIMIT 1) AS closed_at
      FROM factory.loop_findings lf
      JOIN factory.issues i ON i.id = lf.issue_id
      JOIN factory.issue_events f ON f.issue_id = i.id AND f.kind = 'filed' AND f.version = 1
      WHERE ${filter === null ? tx`lf.loop IN ('friction', 'hygiene', 'selfwatch')` : tx`lf.loop = ${filter.loop}`}
      ORDER BY lf.loop, lf.class, i.id`
    return classRows(rows)
  }

  return {
    async digestIssues(since) {
      // an open Issue's `at` is when it entered its state, a closed one's when it closed; the kind is the settled one, else the filed one
      const rows: unknown[] = await tx`
        SELECT i.id, i.repo, i.state, f.payload->>'title' AS title, i.wait_reason, i.outcome,
          COALESCE((SELECT k.payload->>'kind' FROM factory.issue_events k WHERE k.issue_id = i.id AND k.kind = 'settled' AND k.result = 'applied' ORDER BY k.version DESC LIMIT 1), f.payload->>'kind') AS kind,
          COALESCE(s.at, f.at) AS at,
          COALESCE((SELECT array_agg(e.after_issue ORDER BY e.after_issue) FROM factory.planning_edges e WHERE e.issue_id = i.id AND e.satisfied_at IS NULL), '{}') AS after
        FROM factory.issues i
        JOIN factory.issue_events f ON f.issue_id = i.id AND f.kind = 'filed' AND f.version = 1
        LEFT JOIN LATERAL (
          SELECT x.at FROM factory.issue_events x
          WHERE x.issue_id = i.id AND x.result = 'applied' AND x.to_state IS DISTINCT FROM x.from_state
          ORDER BY x.version DESC LIMIT 1
        ) s ON true
        WHERE i.state <> 'closed' OR COALESCE(s.at, f.at) >= ${since}
        ORDER BY i.id`
      return rows.map((raw): DigestIssue => {
        const row = DigestRow.parse(raw)
        return {
          id: row.id as IssueId,
          repo: row.repo,
          state: row.state,
          title: row.title,
          kind: row.kind ?? 'chore',
          waitReason: row.state === 'waiting' ? row.wait_reason : null,
          outcome: row.outcome,
          at: row.at,
          after: row.after as IssueId[],
        }
      })
    },

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

    // The words an Issue was filed with are the first signal's text, else its first note: `issue new` and a plan row file theirs as one.
    async settling(limit) {
      const rows: unknown[] = await tx`
        SELECT i.id, i.repo,
          f.payload->>'title' AS title, COALESCE((SELECT s.payload->>'kind' FROM factory.issue_events s WHERE s.issue_id = i.id AND s.kind = 'settled' AND s.result = 'applied' ORDER BY s.version DESC LIMIT 1), f.payload->>'kind') AS kind, f.payload->>'origin' AS origin, f.at AS filed_at,
          EXISTS (SELECT 1 FROM factory.intake_signals s WHERE s.issue_id = i.id AND s.alert IS NOT NULL) AS from_alert,
          COALESCE(f.payload->>'edges' = 'stated', false) AS stated_edges,
          COALESCE((SELECT s.text FROM factory.intake_signals s WHERE s.issue_id = i.id ORDER BY s.received_at LIMIT 1), (SELECT n.payload->>'text' FROM factory.issue_events n WHERE n.issue_id = i.id AND n.kind = 'noted' AND n.result = 'applied' ORDER BY n.version LIMIT 1), '') AS text,
          COALESCE((SELECT p.value FROM factory.planning_prios p WHERE p.issue_id = i.id ORDER BY p.at DESC, p.id DESC LIMIT 1), 0) AS prio
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
          statedEdges: row.stated_edges,
          text: row.text,
          prio: row.prio,
        }
      })
    },

    async openIssueIds(repo) {
      const rows: { id: string }[] =
        await tx`SELECT i.id FROM factory.issues i WHERE i.repo = ${repo} AND i.state <> 'closed' ORDER BY i.id`
      return rows.map((row) => row.id as IssueId)
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
          (SELECT z.payload->>'size' FROM factory.issue_events z WHERE z.issue_id = i.id AND z.kind = 'settled' AND z.result = 'applied' AND z.payload->>'size' IS NOT NULL ORDER BY z.version DESC LIMIT 1) AS size,
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
          size: row.size,
          filedAt: row.filed_at,
          summary: row.summary,
          blockers: row.blockers === '' ? [] : (row.blockers.split(',') as IssueId[]),
        }
      })
    },

    heldEdges: () => readHeldEdges(tx),
    removedEdges: () => readRemovedEdges(tx),
    edgeNeed: (window) => readEdgeNeed(tx, window),

    async liveRepos(limit) {
      const rows: { repo: string; issues: string[] }[] = await tx`
        SELECT repo, array_agg(id ORDER BY id) AS issues
        FROM factory.issues
        WHERE state IN ('working', 'watching')
        GROUP BY repo
        ORDER BY repo LIMIT ${limit}`
      return rows.map((row) => ({ repo: row.repo, issues: row.issues as IssueId[] }))
    },

    async claimRefusals(limit) {
      // An open note's unbroken run of claim refusals up to its newest run: a run of another kind (the lead was mid-turn)
      // ends the run, and a success would have closed the effect.
      const rows: unknown[] = await tx`
        SELECT i.id, i.repo, min(r.at) AS since, count(*)::int AS refusals
        FROM factory.issue_effects e
        JOIN factory.issues i ON i.id = e.issue_id AND i.state <> 'closed'
        JOIN factory.issue_effect_runs r ON r.effect_key = e.key AND NOT r.ok AND r.detail LIKE '%waits for a claim in %'
          AND r.id > COALESCE((
            SELECT max(o.id) FROM factory.issue_effect_runs o
            WHERE o.effect_key = e.key AND (o.ok OR o.detail IS NULL OR o.detail NOT LIKE '%waits for a claim in %')), 0)
        WHERE e.kind = 'note_lead' AND e.done_at IS NULL AND e.cancelled_at IS NULL
        GROUP BY i.id, i.repo
        ORDER BY min(r.at), i.id LIMIT ${limit}`
      return rows.map((raw) => {
        const row = Refusal.parse(raw)
        return { issue: row.id as IssueId, repo: row.repo, since: row.since, refusals: row.refusals }
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
      // The open watch of a watching Issue, with its newest `streak` checks all blocked, and a failing `checkout` check on the newest run (proof writes it only when the checkout is blocked): a CI wait has none.
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
          AND EXISTS (
            SELECT 1 FROM factory.quality_checks c
            CROSS JOIN LATERAL jsonb_array_elements(c.checks) AS e
            WHERE c.watch_key = w.key
              AND c.n = (SELECT max(m.n) FROM factory.quality_checks m WHERE m.watch_key = w.key)
              AND e->>'name' = 'checkout' AND e->>'ok' = 'false'
          )
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

    async openWaits(repo) {
      // The wait is what the Issue's last applied event made (as planning reads it); the Issues it is after, with their close.
      const rows: unknown[] = await tx`
        SELECT i.id, f.payload->>'title' AS title, i.wait_reason AS reason, e.wait,
          (SELECT s.at FROM factory.issue_events s WHERE s.issue_id = i.id AND s.result = 'applied' AND s.version = (e.wait->>'since')::int LIMIT 1) AS since_at
        FROM factory.issues i
        JOIN factory.issue_events f ON f.issue_id = i.id AND f.kind = 'filed' AND f.version = 1
        JOIN LATERAL (
          SELECT wait FROM factory.issue_events x
          WHERE x.issue_id = i.id AND x.result = 'applied' ORDER BY x.version DESC LIMIT 1
        ) e ON true
        WHERE i.state = 'waiting' AND i.wait_reason IN ('timer', 'dependency') AND i.repo = ${repo}
        ORDER BY i.id`
      const waits = rows.map((raw) => WaitRowSchema.parse(raw))
      const afters = [...new Set(waits.flatMap((w) => w.wait.after ?? []))]
      const closed = new Map<string, Date>()
      if (afters.length > 0) {
        const closes: { id: string; closed_at: Date | null }[] = await tx`
          SELECT i.id,
            (SELECT c.at FROM factory.issue_events c WHERE c.issue_id = i.id AND c.result = 'applied' AND c.to_state = 'closed' ORDER BY c.version DESC LIMIT 1) AS closed_at
          FROM factory.issues i WHERE i.state = 'closed' AND i.id IN ${tx(afters)}`
        for (const row of closes) if (row.closed_at) closed.set(row.id, row.closed_at)
      }
      return waits.map((w) => ({
        issue: w.id,
        title: w.title,
        reason: w.reason,
        since: w.wait.since,
        sinceAt: w.since_at ?? new Date(0),
        until: w.wait.until ?? null,
        after: (w.wait.after ?? []).map((id) => ({ issue: id, closedAt: closed.get(id) ?? null })),
      }))
    },

    async processMinutes(since) {
      const rows: unknown[] = await tx`
        SELECT at, pid, name, class, repo, issue, footprint_mib FROM factory.host_process_samples WHERE at >= ${since} ORDER BY at, pid`
      return rows.map((raw) => {
        const row = ProcessMinuteRow.parse(raw)
        return {
          at: row.at,
          pid: row.pid,
          name: row.name,
          class: row.class,
          repo: row.repo,
          issue: row.issue,
          footprintMib: row.footprint_mib,
        }
      })
    },

    async hostMinutes(since) {
      const rows: unknown[] = await tx`
        SELECT at, swap_used_pct, processes FROM factory.host_samples WHERE at >= ${since} ORDER BY at`
      return rows.map((raw) => {
        const row = HostMinuteRow.parse(raw)
        return { at: row.at, swapUsedPct: row.swap_used_pct, processes: row.processes }
      })
    },

    async capacityMinutes(since) {
      const rows: unknown[] = await tx`
        SELECT at, load, load_ceiling, leads, seats, memory_used_pct, swap_used_pct, swapout_mb_per_300s, compressor_mib, pressure_level
        FROM factory.host_samples WHERE at >= ${since} ORDER BY at`
      return rows.map((raw) => {
        const row = CapacityMinuteRow.parse(raw)
        return {
          at: row.at,
          load: row.load,
          loadCeiling: row.load_ceiling,
          leads: row.leads,
          seats: row.seats,
          memoryUsedPct: row.memory_used_pct,
          swapUsedPct: row.swap_used_pct,
          swapoutMbPer300s: row.swapout_mb_per_300s,
          compressorMib: row.compressor_mib,
          pressureLevel: row.pressure_level,
        }
      })
    },

    async admissions(since) {
      const rows: unknown[] = await tx`
        SELECT at, issue_id, payload->>'load' AS load FROM factory.issue_events WHERE kind = 'admitted' AND result = 'applied' AND at >= ${since} ORDER BY at`
      return rows.map((raw) => {
        const row = AdmissionRow.parse(raw)
        return { at: row.at, issue: row.issue_id, load: row.load }
      })
    },

    async slotMinutes(since) {
      const rows: unknown[] = await tx`
        SELECT at, live_slots, aim_slots, holders, waiters FROM factory.slot_shadow WHERE at >= ${since} ORDER BY at`
      return rows.map((raw) => {
        const row = SlotMinuteRow.parse(raw)
        return {
          at: row.at,
          liveSlots: row.live_slots,
          aimSlots: row.aim_slots,
          holders: row.holders,
          waiters: row.waiters,
        }
      })
    },

    async queueReasons() {
      const rows: unknown[] = await tx`
        SELECT kind, count(*) AS count, min(from_at) AS since FROM factory.queue_intervals WHERE to_at IS NULL
        GROUP BY kind ORDER BY count(*) DESC, kind`
      return rows.map((raw) => QueueReasonRow.parse(raw))
    },

    async classCpu(since) {
      const rows: unknown[] = await tx`
        SELECT class, repo, sum(cpu_ms) AS cpu_ms, (SELECT count(DISTINCT at) FROM factory.host_class_samples WHERE at >= ${since}) AS minutes
        FROM factory.host_class_samples WHERE at >= ${since} AND cpu_ms IS NOT NULL
        GROUP BY class, repo ORDER BY sum(cpu_ms) DESC`
      const parsed = rows.map((raw) => ClassCpuRow.parse(raw))
      const split: unknown[] = await tx`
        SELECT count(*) AS samples, avg(cpu_idle_pct) AS idle, avg(cpu_user_pct) AS usr, avg(cpu_sys_pct) AS sys
        FROM factory.host_samples WHERE at >= ${since} AND cpu_idle_pct IS NOT NULL AND cpu_user_pct IS NOT NULL AND cpu_sys_pct IS NOT NULL`
      const header = HostCpuSplitRow.parse(split[0])
      return {
        minutes: parsed[0]?.minutes ?? 0,
        rows: parsed.map((row) => ({ class: row.class, repo: row.repo, cpuMs: row.cpu_ms })),
        host:
          header.samples === 0 || header.idle === null || header.usr === null || header.sys === null
            ? null
            : { samples: header.samples, idlePct: header.idle, userPct: header.usr, sysPct: header.sys },
      }
    },

    specPrecedents: (limit) => readSpecPrecedents(tx, limit),

    async findingIssues(repo) {
      // the newest Issue of each key (by when it was filed), its state, how it closed and how often it was reopened
      const rows: unknown[] = await tx`
        SELECT DISTINCT ON (lf.key) lf.key, i.id AS issue, i.state, i.outcome,
          (SELECT c.at FROM factory.issue_events c WHERE c.issue_id = i.id AND c.result = 'applied' AND c.to_state = 'closed' ORDER BY c.version DESC LIMIT 1) AS closed_at,
          (SELECT count(*) FROM factory.issue_events r WHERE r.issue_id = i.id AND r.result = 'applied' AND r.kind = 'reopened')::int AS reopens
        FROM factory.loop_findings lf
        JOIN factory.issues i ON i.id = lf.issue_id
        JOIN factory.issue_events f ON f.issue_id = i.id AND f.kind = 'filed' AND f.version = 1
        WHERE lf.loop = 'hygiene' AND lf.repo = ${repo}
        ORDER BY lf.key, f.at DESC, i.id DESC`
      return rows.map((raw): FindingIssue => {
        const row = FindingIssueRow.parse(raw)
        return {
          key: row.key,
          issue: row.issue,
          state: row.state,
          outcome: row.outcome,
          closedAt: row.state === 'closed' ? row.closed_at : null,
          reopens: row.reopens,
        }
      })
    },

    async closedFindings(loop, repo) {
      // a closed Issue's closing is its applied event into `closed`; the newest closed Issue of each key is what a signal says "last time" of
      const rows: unknown[] = await tx`
        WITH closed AS (
          SELECT lf.issue_id AS issue, lf.loop, lf.repo, lf.key, lf.figure, lf.verdict, i.outcome, lf.filed_at,
            (SELECT c.at FROM factory.issue_events c WHERE c.issue_id = i.id AND c.result = 'applied' AND c.to_state = 'closed'
              ORDER BY c.version DESC LIMIT 1) AS closed_at
          FROM factory.loop_findings lf JOIN factory.issues i ON i.id = lf.issue_id
          WHERE lf.loop = ${loop} AND i.state = 'closed' AND (${repo ?? null}::text IS NULL OR lf.repo = ${repo ?? null}))
        SELECT * FROM closed
        WHERE closed_at IS NOT NULL AND (verdict IS NULL OR issue IN (
          SELECT DISTINCT ON (key) issue FROM closed ORDER BY key, filed_at DESC, issue DESC))
        ORDER BY filed_at, issue`
      return rows.map((raw): ClosedFinding => {
        const row = ClosedRow.parse(raw)
        return {
          issue: row.issue,
          loop: row.loop,
          repo: row.repo,
          key: row.key,
          figure: row.figure,
          verdict: row.verdict,
          outcome: row.outcome,
          filedAt: row.filed_at,
          closedAt: row.closed_at,
        }
      })
    },

    async classIssues(loop) {
      const out: Record<string, ClassIssue[]> = {}
      for (const row of await classes({ loop })) (out[row.class] ??= []).push(row.issue)
      return out
    },

    async allClassIssues() {
      const groups = new Map<string, { loop: FindingLoop; class: string; issues: ClassIssue[] }>()
      for (const row of await classes(null)) {
        const id = `${row.loop}\u0000${row.class}`
        const group = groups.get(id) ?? { loop: row.loop, class: row.class, issues: [] }
        group.issues.push(row.issue)
        groups.set(id, group)
      }
      return [...groups.values()]
    },
  }
}
