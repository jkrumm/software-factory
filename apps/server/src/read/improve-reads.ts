import type { SQL } from 'bun'
import * as z from 'zod'
import type { FinderIssue, FindingLoop } from '../domains/improve/finders.ts'
import type { ClosedFinding } from '../domains/improve/ledger.ts'
import type { DigestIssue } from '../kernel/digest-scope.ts'
import type { IssueId } from '../kernel/ids.ts'
import type { ImproveReads } from '../domains/improve/ports.ts'

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
  load_tripped: z.boolean(),
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

const classRows = (rows: unknown[]) =>
  rows.map((raw) => {
    const row = ClassRow.parse(raw)
    const issue: FinderIssue = {
      issue: row.issue,
      filedAt: row.filed_at,
      closedAt: row.closed_at,
      outcome: row.outcome,
    }
    return { loop: row.loop, class: row.class, issue }
  })

/** What the loops that watch the factory read across the work, capacity and host tables. Read-only SQL on the caller's transaction. */
export function improveReads(tx: SQL): ImproveReads {
  // A finding's Issues: filed at its `filed` event, closed at the applied event that moved it to `closed`.
  const classes = async (filter: { loop: string } | null) => {
    const rows: unknown[] = await tx`
      SELECT DISTINCT lf.loop, lf.repo, lf.class, i.id AS issue, f.at AS filed_at, i.outcome,
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
        SELECT at, live_slots, aim_slots, holders, waiters, load_tripped FROM factory.slot_shadow WHERE at >= ${since} ORDER BY at`
      return rows.map((raw) => {
        const row = SlotMinuteRow.parse(raw)
        return {
          at: row.at,
          liveSlots: row.live_slots,
          aimSlots: row.aim_slots,
          holders: row.holders,
          waiters: row.waiters,
          loadTripped: row.load_tripped,
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
      // one minute set for the groups, the divisor and the host split: the minutes with a class CPU figure (none at the first
      // snapshot after a restart) and a parsed `top` header, so the CPU accounting nets one against the other over the same minutes
      const rows: unknown[] = await tx`
        WITH covered AS (
          SELECT h.at, h.cpu_idle_pct, h.cpu_user_pct, h.cpu_sys_pct FROM factory.host_samples h
          WHERE h.at >= ${since} AND h.cpu_idle_pct IS NOT NULL AND h.cpu_user_pct IS NOT NULL AND h.cpu_sys_pct IS NOT NULL
            AND EXISTS (SELECT 1 FROM factory.host_class_samples c WHERE c.at = h.at AND c.cpu_ms IS NOT NULL)
        )
        SELECT c.class, c.repo, sum(c.cpu_ms) AS cpu_ms, (SELECT count(*) FROM covered) AS minutes
        FROM factory.host_class_samples c WHERE c.at IN (SELECT at FROM covered) AND c.cpu_ms IS NOT NULL
        GROUP BY c.class, c.repo ORDER BY sum(c.cpu_ms) DESC`
      const parsed = rows.map((raw) => ClassCpuRow.parse(raw))
      const split: unknown[] = await tx`
        SELECT count(*) AS samples, avg(h.cpu_idle_pct) AS idle, avg(h.cpu_user_pct) AS usr, avg(h.cpu_sys_pct) AS sys
        FROM factory.host_samples h
        WHERE h.at >= ${since} AND h.cpu_idle_pct IS NOT NULL AND h.cpu_user_pct IS NOT NULL AND h.cpu_sys_pct IS NOT NULL
          AND EXISTS (SELECT 1 FROM factory.host_class_samples c WHERE c.at = h.at AND c.cpu_ms IS NOT NULL)`
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
      const out: Record<string, FinderIssue[]> = {}
      for (const row of await classes({ loop })) (out[row.class] ??= []).push(row.issue)
      return out
    },

    async allClassIssues() {
      const groups = new Map<string, { loop: FindingLoop; class: string; issues: FinderIssue[] }>()
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
