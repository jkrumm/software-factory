import type { SQL } from 'bun'
import { digestDue, loadMorning } from './digest.ts'
import { record } from './outbox.ts'
import {
  alertMessage,
  askMessage,
  failedMessage,
  type IssueRef,
  parkedMessage,
  quote,
  regressionMessage,
} from './text.ts'

/**
 * The rules of the owner's line. The ones tied to a transition (`ask`, parked, the hold) are called inside the transaction that
 * decides it, so a rolled-back decision says nothing and a committed one always does. The ones that read state (`failures`,
 * the digest) run once a tick, each as statements of their own whose keys make a replay a no-op.
 */

/** An `ask` that stored a new question. */
export async function notifyAsk(
  tx: SQL,
  input: {
    issue: IssueRef
    decision: number
    question: string
    options?: readonly string[]
    default?: string | null
    now: Date
  },
): Promise<void> {
  await record(tx, askMessage(input), input.now)
}

/** After an event moved an Issue: parked by the factory's own verdicts, and a regression sent back to a lead. */
export async function notifyMove(
  tx: SQL,
  input: {
    /** the Issue as the move left it */
    issue: IssueRef & { revision: number; hold: number; state: string }
    kind: string
    payload: Record<string, unknown> | null
    now: Date
  },
): Promise<void> {
  const { issue, kind, payload, now } = input
  if (issue.state === 'waiting' && (kind === 'unreported' || kind === 'lead_gone' || kind === 'regression')) {
    const detail = typeof payload?.detail === 'string' ? payload.detail : null
    const reason = kind === 'regression' ? 'regressed' : kind
    await record(tx, parkedMessage({ issue, revision: issue.revision, reason, detail }), now)
  } else if (kind === 'regression') {
    const title = typeof payload?.title === 'string' ? payload.title : null
    await record(tx, regressionMessage({ issue, hold: issue.hold, title }), now)
  }
}

/** An effect that has failed this often is stuck, not unlucky. */
export const STUCK_AFTER_ATTEMPTS = 3
const EFFECT_WHAT: Record<string, string> = { start_lead: 'its lead did not start', finalize: 'its finalize failed' }

/**
 * Lead spawns that failed for good while their Issue is open (a spawn has no time of its failure, and a closed Issue's is history), and
 * effects that keep failing. A failed lead that `lead_gone` restarts (the Issue is `queued` for its next attempt, or already on a later one) is no failure for good, and the park that ends the restarts sends its own message, so neither is told here.
 */
export async function notifyFailures(sql: SQL, now: Date): Promise<void> {
  const spawns: { key: string; error: string | null; issue_id: number; repo: string }[] = await sql`
    SELECT s.key, s.error, i.id AS issue_id, i.repo FROM factory.spawns s JOIN factory.issues i ON i.id = s.issue_id
    WHERE s.status = 'failed' AND s.role = 'lead' AND i.state <> 'closed'
      AND i.state <> 'queued' AND NOT (i.state = 'waiting' AND i.reason = 'lead_gone')
      AND substring(s.key from '[0-9]+$')::int >= i.attempt
      AND NOT EXISTS (SELECT 1 FROM factory.notifications n WHERE n.key = 'notify:failed:spawn:' || s.key)
    ORDER BY s.created_at, s.key LIMIT 20`
  for (const spawn of spawns) {
    await record(
      sql,
      failedMessage({
        issue: { id: spawn.issue_id, repo: spawn.repo },
        kind: 'spawn',
        id: spawn.key,
        what: 'its lead spawn failed for good',
        detail: spawn.error,
      }),
      now,
    )
  }
  const effects: { key: string; kind: string; error: string | null; issue_id: number; repo: string }[] = await sql`
    SELECT e.key, e.kind, e.error, i.id AS issue_id, i.repo FROM factory.issue_effects e JOIN factory.issues i ON i.id = e.issue_id
    WHERE e.kind IN ('start_lead', 'finalize') AND e.done_at IS NULL AND e.cancelled_at IS NULL
      AND e.error IS NOT NULL AND e.attempts >= ${STUCK_AFTER_ATTEMPTS}
      AND NOT EXISTS (SELECT 1 FROM factory.notifications n WHERE n.key = 'notify:failed:' || e.kind || ':' || e.key)
    ORDER BY e.id LIMIT 20`
  for (const effect of effects) {
    await record(
      sql,
      failedMessage({
        issue: { id: effect.issue_id, repo: effect.repo },
        kind: effect.kind,
        id: effect.key,
        what: EFFECT_WHAT[effect.kind] ?? `${effect.kind} failed`,
        detail: effect.error,
      }),
      now,
    )
  }
}

/** An alert Issue older than the window plus this is history (a server that was down for a day, a first deploy): it pages nobody. */
export const ALERT_PAGE_LOOKBACK_MS = 24 * 60 * 60_000

/** What the Issue's lead is doing, in the words of the message. */
function leadDoing(row: { state: string; reason: string | null; phase: string | null }): string {
  if (row.state === 'queued') return 'no lead has started on it'
  if (row.state === 'waiting') return `it is parked${row.reason ? ` (${row.reason})` : ''}`
  return row.phase ? `its lead is working, in phase ${row.phase}` : 'its lead is working, no phase reported yet'
}

/**
 * The safety net of factory-first paging: an Issue filed from the door's alerts that is still unsolved (not closed, not `watching` a
 * shipped fix) `afterMs` after it was filed sends one message, keyed by the Issue. A tick after a restart finds the key and does nothing;
 * an Issue that closed inside the window is never read. `null` switches the rule off.
 */
export async function notifyUnsolvedAlerts(sql: SQL, now: Date, afterMs: number | null): Promise<void> {
  if (afterMs === null) return
  const due = new Date(now.getTime() - afterMs)
  const floor = new Date(due.getTime() - ALERT_PAGE_LOOKBACK_MS)
  const rows: {
    id: number
    repo: string
    title: string
    state: string
    reason: string | null
    source: string | null
    monitor: string | null
    phase: string | null
  }[] = await sql`
    SELECT i.id, i.repo, i.title, i.state, i.reason, i.facts->>'source' AS source, i.facts->>'monitor' AS monitor,
      (SELECT e.payload->>'phase' FROM factory.issue_events e
       WHERE e.issue_id = i.id AND e.kind = 'phase' AND e.payload->>'attempt' = i.attempt::text ORDER BY e.id DESC LIMIT 1) AS phase
    FROM factory.issues i
    WHERE i.source = 'alert' AND i.state IN ('settling', 'queued', 'working', 'waiting')
      AND i.created_at <= ${due} AND i.created_at > ${floor}
      AND NOT EXISTS (SELECT 1 FROM factory.notifications n WHERE n.key = 'notify:alert:' || i.id)
    ORDER BY i.id LIMIT 20`
  for (const row of rows) {
    await record(
      sql,
      alertMessage({
        issue: { id: row.id, repo: row.repo },
        source: row.source,
        monitor: row.monitor,
        title: row.title,
        afterMs,
        doing: leadDoing(row),
      }),
      now,
    )
  }
}

/** An alert the door could not file. At most one message per monitor per day: a flapping monitor must not flood the channel. */
export async function notifyDoorRefused(
  sql: SQL,
  input: { source: string; monitor: string; reason: string; now: Date },
): Promise<void> {
  const day = input.now.toISOString().slice(0, 10)
  await record(
    sql,
    failedMessage({
      issue: null,
      kind: 'door',
      id: `${input.source}:${input.monitor.replace(/[%:]/g, (c) => (c === '%' ? '%25' : '%3A'))}:${day}`,
      what: `a ${input.source} alert of monitor ${quote(input.monitor, 80)} was refused, so it files no Issue:`,
      detail: input.reason,
    }),
    input.now,
  )
}

/**
 * The morning reading (the 07:30 digest), once per local day from `at` until noon: the key is the date, so a second tick, a restart and a second process
 * are one message. The text is built only when the day has none.
 */
export async function notifyDigest(
  sql: SQL,
  input: { now: Date; at: string | null; timeZone: string; visible?: () => Promise<(path: string) => boolean> },
): Promise<void> {
  if (input.at === null) return
  const date = digestDue(input.now, { at: input.at, timeZone: input.timeZone })
  if (date === null) return
  const key = `notify:digest:${date}`
  const [known] = await sql`SELECT 1 FROM factory.notifications WHERE key = ${key}`
  if (known) return
  // The morning reading is the since reading's groups (FV Wave 4); an IuRoot item is a count only.
  const text = await loadMorning(sql, {
    now: input.now,
    date,
    // Without a check nothing is told apart, and everything is counted only.
    isVisible: (await input.visible?.()) ?? (() => true),
  })
  await record(sql, { key, kind: 'digest', issueId: null, text }, input.now)
}
