import type { SQL } from 'bun'
import { digestDue, loadDigest, renderDigest } from './digest.ts'
import { record } from './outbox.ts'
import { askMessage, failedMessage, type IssueRef, parkedMessage, quote, regressionMessage } from './text.ts'

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
  if (issue.state === 'waiting' && (kind === 'unreported' || kind === 'lead_gone')) {
    const detail = typeof payload?.detail === 'string' ? payload.detail : null
    await record(tx, parkedMessage({ issue, revision: issue.revision, reason: kind, detail }), now)
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
 * effects that keep failing.
 */
export async function notifyFailures(sql: SQL, now: Date): Promise<void> {
  const spawns: { key: string; error: string | null; issue_id: number; repo: string }[] = await sql`
    SELECT s.key, s.error, i.id AS issue_id, i.repo FROM factory.spawns s JOIN factory.issues i ON i.id = s.issue_id
    WHERE s.status = 'failed' AND s.role = 'lead' AND i.state <> 'closed'
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
 * The digest, once per local day from `at` until noon: the key is the date, so a second tick, a restart and a second process
 * are one message. The text is built only when the day has none.
 */
export async function notifyDigest(sql: SQL, input: { now: Date; at: string | null; timeZone: string }): Promise<void> {
  if (input.at === null) return
  const date = digestDue(input.now, { at: input.at, timeZone: input.timeZone })
  if (date === null) return
  const key = `notify:digest:${date}`
  const [known] = await sql`SELECT 1 FROM factory.notifications WHERE key = ${key}`
  if (known) return
  const text = renderDigest(await loadDigest(sql, input.now, date))
  await record(sql, { key, kind: 'digest', issueId: null, text }, input.now)
}
