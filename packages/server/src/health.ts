import type { Health, HealthKind, Heartbeat } from '@software-factory/contract'
import type { SQL } from 'bun'
import type { Clock } from './clock.ts'
import { leadsOnBackgroundWork } from './issues/lead-activity.ts'
import { MAX_REGRESSIONS } from './issues/lifecycle.ts'
import { planLines } from './projects/plan-status.ts'

/** Unhealthy once no pass has succeeded for this many intervals. */
export const STALE_INTERVALS = 3

/**
 * What the ticker tells `/health`: when a pass last succeeded and what last went wrong. A pass that runs a start can
 * legitimately outlast three intervals, so while one is in flight only `passLimitMs` counts; between passes the age
 * of the last success does. A server that has not yet had a successful pass is unhealthy once no pass is running, so a
 * deploy whose ticker is broken never counts as up.
 */
export class TickMonitor {
  private lastSuccess: Date | null = null
  private lastError: { at: Date; message: string } | null = null
  private passStartedAt: Date | null = null

  constructor(
    private readonly clock: Clock,
    private readonly intervalMs: number,
    private readonly passLimitMs: number,
  ) {}

  passStarted(): void {
    this.passStartedAt = this.clock.now()
  }

  passSucceeded(): void {
    this.lastSuccess = this.clock.now()
    this.passStartedAt = null
  }

  /** A pass that threw. */
  passFailed(message: string): void {
    this.noteError(message)
    this.passStartedAt = null
  }

  /** A failure inside a pass that otherwise completed (a result that could not be recorded). */
  noteError(message: string): void {
    this.lastError = { at: this.clock.now(), message }
  }

  snapshot(): Pick<Health, 'status' | 'reason' | 'tick'> {
    const now = this.clock.now().getTime()
    const tick = {
      lastSuccessAt: this.lastSuccess?.toISOString() ?? null,
      lastError: this.lastError && { at: this.lastError.at.toISOString(), message: this.lastError.message },
    }
    const reason = this.staleReason(now)
    return { status: reason ? 'unhealthy' : 'ok', reason, tick }
  }

  private staleReason(now: number): string | null {
    if (this.passStartedAt) {
      const running = now - this.passStartedAt.getTime()
      return running > this.passLimitMs
        ? `a tick pass has run for ${Math.round(running / 1000)}s (limit ${Math.round(this.passLimitMs / 1000)}s)`
        : null
    }
    if (!this.lastSuccess) return 'no tick has succeeded yet'
    const limit = STALE_INTERVALS * this.intervalMs
    const age = now - this.lastSuccess.getTime()
    if (age <= limit) return null
    return `no successful tick for ${Math.round(age / 1000)}s (limit ${Math.round(limit / 1000)}s)`
  }
}

// --- the heartbeat (`GET /health` `heartbeat`, polled by the dotfiles pusher for Uptime Kuma) ---------------------------

/** The heartbeat fails when the last successful tick is older than this, or a spawn has been due this long with no change of status. */
export const HEARTBEAT_STALE_MS = 30 * 60_000
/** `queueMovedAt` looks at the spawns of this window, and at every spawn still pending. */
const QUEUE_WINDOW_MS = 7 * 86_400_000

const minutes = (ms: number): number => Math.floor(ms / 60_000)

/**
 * "The tick advanced and the queue moved within 30 minutes", with the field names the pusher reads (`ok`, `reason`, `tickAt`,
 * `queueMovedAt`). A spawn's status change has no column of its own: the newest of `created_at`, `assigned_at` and `claimed_at` stands for it
 * (a claim is the tick moving the spawn). A spawn is due when it is `queued` with no hold, or `waiting` with its `resume_at` past; one
 * bounded query, no new table.
 */
export async function heartbeat(sql: SQL, now: Date, tickAt: string | null): Promise<Heartbeat> {
  const [row]: { moved: Date | null; due_key: string | null; due_since: Date | null }[] = await sql`
    WITH s AS (
      SELECT key, status, hold, resume_at, GREATEST(created_at, assigned_at, claimed_at) AS changed FROM factory.spawns
      WHERE status IN ('queued', 'waiting', 'starting') OR created_at > ${new Date(now.getTime() - QUEUE_WINDOW_MS)}
    ), due AS (
      SELECT key, CASE WHEN status = 'waiting' THEN GREATEST(resume_at, changed) ELSE changed END AS since FROM s
      WHERE (status = 'queued' AND hold IS NULL) OR (status = 'waiting' AND resume_at IS NOT NULL AND resume_at <= ${now})
    )
    SELECT (SELECT max(changed) FROM s) AS moved,
      (SELECT key FROM due ORDER BY since, key LIMIT 1) AS due_key,
      (SELECT since FROM due ORDER BY since, key LIMIT 1) AS due_since`
  const reasons: string[] = []
  if (!tickAt) reasons.push('no tick has succeeded yet')
  else if (now.getTime() - Date.parse(tickAt) >= HEARTBEAT_STALE_MS) {
    reasons.push(`no successful tick for ${minutes(now.getTime() - Date.parse(tickAt))} min`)
  }
  if (row?.due_since && now.getTime() - row.due_since.getTime() >= HEARTBEAT_STALE_MS) {
    reasons.push(
      `spawn ${row.due_key} due for ${minutes(now.getTime() - row.due_since.getTime())} min without a change of status`,
    )
  }
  return {
    ok: reasons.length === 0,
    reason: reasons.length === 0 ? null : reasons.join('; '),
    tickAt,
    queueMovedAt: row?.moved?.toISOString() ?? null,
  }
}

/**
 * A health line about something that has finished (a failed spawn, a failed note, an undelivered notification, a kept worktree)
 * ends this long after it finished; a line about something ongoing (a park, a silent lead, a live wall) stays while it is true.
 * The one constant: every source of a finished line reads it, so `factory status` and `/fleet` agree.
 */
export const FINISHED_HEALTH_MS = 72 * 3_600_000

// --- the health line (design v3 §6) ---------------------------------------------------------------------------------------

/** An Issue `working` whose lead has stored no event for this long. */
export const SILENT_AFTER_MS = 20 * 60_000
/** How long an Issue may stay `working` by its size (Classify's `s|m|l`); no size counts as `m`. */
export const BUDGET_HOURS = { s: 2, m: 6, l: 24 } as const
export const DEFAULT_SIZE = 'm'

const hoursOf = (ms: number): number => Math.round(ms / 360_000) / 10

/**
 * The health lines facts alone make, derived when read: a silent lead, an Issue over its size's budget, and an open Issue on its
 * last regression before the park (the third parks it, and that is a park line). `lead-<id>-<attempt>` is the lead's session name
 * (`issues/names.ts`); its last event is any kind in `factory.events`.
 */
export async function healthLines(sql: SQL, now: Date): Promise<string[]> {
  const lines: string[] = []

  const working: {
    id: number
    size: string | null
    since: Date
    last_event: Date | null
  }[] = await sql`
    SELECT i.id, i.size,
      COALESCE((SELECT max(e.at) FROM factory.issue_events e WHERE e.issue_id = i.id AND e.to_state = 'working'), i.updated_at) AS since,
      (SELECT max(v.at) FROM factory.events v WHERE v.session = 'lead-' || i.id || '-' || i.attempt) AS last_event
    FROM factory.issues i WHERE i.state = 'working' ORDER BY i.id`
  const onBackground = await leadsOnBackgroundWork(sql)
  for (const issue of working) {
    // A lead that has stored nothing yet is silent from the moment the Issue began working; one waiting on background work is not silent.
    const quiet = now.getTime() - (issue.last_event ?? issue.since).getTime()
    if (quiet >= SILENT_AFTER_MS && !onBackground.has(issue.id))
      lines.push(`Issue ${issue.id}: no hook event for ${minutes(quiet)} min`)
    const size = issue.size && issue.size in BUDGET_HOURS ? (issue.size as keyof typeof BUDGET_HOURS) : DEFAULT_SIZE
    const budget = BUDGET_HOURS[size]
    const spent = now.getTime() - issue.since.getTime()
    if (spent > budget * 3_600_000) {
      lines.push(`Issue ${issue.id}: working ${hoursOf(spent)} h, budget ${budget} h (size ${issue.size ?? 'unknown'})`)
    }
  }

  const regressing: { id: number }[] = await sql`
    SELECT i.id FROM factory.issues i
    WHERE i.state <> 'closed' AND i.reason IS DISTINCT FROM 'parked'
      AND (SELECT count(*)::int FROM factory.issue_events e WHERE e.issue_id = i.id AND e.kind = 'regression' AND e.to_state IS NOT NULL) = ${MAX_REGRESSIONS}
    ORDER BY i.id`
  for (const issue of regressing) {
    lines.push(`Issue ${issue.id}: ${MAX_REGRESSIONS} regressions, the next one parks it`)
  }
  lines.push(...(await unsentBriefLines(sql, now)))
  lines.push(...(await checkoutLines(sql)))
  lines.push(...(await loadHoldLines(sql)))
  lines.push(...(await planLines(sql, now)))
  return lines
}

/** How long a started spawn may go without its first turn before the line says its brief may sit unsent. */
export const NO_FIRST_TURN_MS = 3 * 60_000

/** A started spawn with no `turn_started` since it started and no end: derived on read, gone once the turn exists. */
async function unsentBriefLines(sql: SQL, now: Date): Promise<string[]> {
  const rows: { key: string; issue_id: number | null; assigned_at: Date }[] = await sql`
    SELECT s.key, s.issue_id, s.assigned_at FROM factory.spawns s
    WHERE s.status = 'started' AND s.assigned_at <= ${new Date(now.getTime() - NO_FIRST_TURN_MS)}
      AND NOT EXISTS (SELECT 1 FROM factory.events e WHERE e.session = s.key AND e.at >= s.assigned_at
                      AND e.kind IN ('turn_started', 'session_ended', 'pane_gone'))
    ORDER BY s.assigned_at, s.key`
  return rows.map(
    (row) =>
      `${row.issue_id === null ? `spawn ${row.key}` : `Issue ${row.issue_id}`}: no first turn ${minutes(now.getTime() - row.assigned_at.getTime())} min after its start, its brief may sit unsent`,
  )
}

/** A watching Issue whose hold cannot verify because its repo's checkout is not the owner's to move (`issues/hold.ts`): there while it is true. */
async function checkoutLines(sql: SQL): Promise<string[]> {
  const rows: { issue_id: number; detail: string }[] = await sql`
    SELECT e.issue_id, e.payload->'blocked'->>'detail' AS detail
    FROM factory.issue_effects e JOIN factory.issues i ON i.id = e.issue_id AND i.state = 'watching'
    WHERE e.kind = 'verify' AND e.done_at IS NULL AND e.cancelled_at IS NULL AND e.payload->'blocked' IS NOT NULL
    ORDER BY e.issue_id, e.id`
  return rows.map((row) => `Issue ${row.issue_id}: the hold cannot verify, ${row.detail}; it checks again every 5 min`)
}

/**
 * `held by load: Issue N (and K more) wait for the machine`: Issue leads admission holds because the 1-minute load average is above
 * `FACTORY_LOAD_CEILING`. A held spawn is looked at again every `HOLD_RECHECK_MS`, so the line is there while the hold is and gone at the
 * first look under the ceiling.
 */
async function loadHoldLines(sql: SQL): Promise<string[]> {
  const rows: { issue_id: number }[] = await sql`
    SELECT issue_id FROM factory.spawns
    WHERE status = 'queued' AND hold = 'load' AND issue_id IS NOT NULL ORDER BY issue_id`
  const [first, ...rest] = rows.map((row) => row.issue_id)
  if (first === undefined) return []
  const more = rest.length > 0 ? ` (and ${rest.length} more)` : ''
  return [
    `held by load: Issue ${first}${more} waits for the machine, new leads start when its load is under the ceiling`,
  ]
}

/** Which kind of health line a line is (the one place that decides; `/fleet` carries it). */
export function healthKind(line: string): HealthKind {
  if (/^Issue \d+ parked/.test(line)) return 'park'
  if (/^Issue \d+: no hook event/.test(line) || /^(Issue \d+|spawn \S+): no first turn /.test(line)) return 'silent'
  if (/^Issue \d+: working .* budget /.test(line)) return 'over_budget'
  if (/^Issue \d+: \d+ regressions/.test(line)) return 'regressions'
  return 'machine'
}
