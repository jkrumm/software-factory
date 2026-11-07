import type { Notification, NotificationKind } from '@software-factory/contract'
import type { SQL } from 'bun'
import { FINISHED_HEALTH_MS } from '../health.ts'
import type { Notifier } from './port.ts'
import type { Message } from './text.ts'

/** Most messages one tick sends. */
export const BATCH = 5
/** Sends before a message is `failed`. */
export const MAX_ATTEMPTS = 5
/** Delay after a failed send: base, 2*base, ... up to cap. */
export const BACKOFF = { baseMs: 30_000, capMs: 300_000 }
export const backoffMs = (attempt: number): number => Math.min(BACKOFF.capMs, BACKOFF.baseMs * 2 ** (attempt - 1))
/** A claim not recorded within this long was a crashed send's: the row is due again (at-least-once). */
export const LEASE_MS = 120_000

/**
 * The away rule: why a message is folded instead of sent, or `null` when it goes out. The owner is always treated as away: a decision
 * (`notify:ask:*`), the steward's spent retries (`notify:steward:*`), a finished plan (`notify:plan:*`: what next is the owner's), an alert nobody
 * solved in time (`notify:alert:*`: the net under factory-first paging), the morning reading
 * and a test go out; every other message is folded.
 */
export function foldReason(key: string): string | null {
  if (key.startsWith('notify:digest:') || key.startsWith('notify:test:')) return null
  if (key.startsWith('notify:ask:') || key.startsWith('notify:steward:') || key.startsWith('notify:plan:')) return null
  if (key.startsWith('notify:alert:')) return null
  return 'the owner is away and this is not a decision: its facts are in the morning reading and on the fleet view'
}

/**
 * Records a message under its key; a key seen before changes nothing. Takes the transaction that decided it, or the pool. True when
 * this call made the row.
 */
export async function record(sql: SQL, message: Message, now: Date): Promise<boolean> {
  const rows = await sql`
    INSERT INTO factory.notifications (key, kind, issue_id, text, created_at, next_at)
    VALUES (${message.key}, ${message.kind}, ${message.issueId}, ${message.text}, ${now}, ${now})
    ON CONFLICT (key) DO NOTHING
    RETURNING key`
  return rows.length > 0
}

interface Claimed {
  key: string
  text: string
  attempts: number
}

/**
 * Phase 1, in one short transaction: rows whose attempts ran out while a send was in flight are `failed`; the due rows (at most
 * `limit`) are either folded by the away rule (a reason, `folded_at`, never due again) or counted as tried and leased. Nothing is sent here.
 */
export async function claim(sql: SQL, now: Date, limit: number): Promise<Claimed[]> {
  return sql.begin(async (tx) => {
    await tx`
      UPDATE factory.notifications SET failed_at = ${now}, error = COALESCE(error, 'the send did not report back')
      WHERE sent_at IS NULL AND failed_at IS NULL AND attempts >= ${MAX_ATTEMPTS} AND next_at <= ${now}`
    const due: { key: string; text: string; attempts: number }[] = await tx`
      SELECT key, text, attempts FROM factory.notifications
      WHERE sent_at IS NULL AND failed_at IS NULL AND folded_at IS NULL AND next_at <= ${now}
      ORDER BY created_at, key LIMIT ${limit}
      FOR UPDATE SKIP LOCKED`
    const claimed: Claimed[] = []
    for (const row of due) {
      const folded = foldReason(row.key)
      if (folded !== null) {
        // Never sent later; 'infinity' keeps a release that does not know the column from finding the row due.
        await tx`
          UPDATE factory.notifications SET folded_at = ${now}, folded_reason = ${folded}, next_at = 'infinity'
          WHERE key = ${row.key}`
        console.log('notify: folded', row.key, folded)
        continue
      }
      const attempts = row.attempts + 1
      await tx`
        UPDATE factory.notifications SET attempts = ${attempts}, next_at = ${new Date(now.getTime() + LEASE_MS)}
        WHERE key = ${row.key}`
      claimed.push({ key: row.key, text: row.text, attempts })
    }
    return claimed
  })
}

/**
 * Phase 3: the result, in a statement of its own. A delivery is always recorded (unless the message was given up on), and it undoes a
 * fold made while the send was in flight; a failure only for the attempt it belongs to, so a send that outlived its lease cannot undo
 * a newer attempt's result.
 */
async function recordResult(
  sql: SQL,
  row: Claimed,
  result: Awaited<ReturnType<Notifier['send']>>,
  now: Date,
  note: string | null,
): Promise<void> {
  if (result.ok) {
    await sql`
      UPDATE factory.notifications SET sent_at = ${now}, error = ${note}, failed_at = NULL, folded_at = NULL, folded_reason = NULL
      WHERE key = ${row.key} AND sent_at IS NULL`
    return
  }
  const spent = row.attempts >= MAX_ATTEMPTS
  await sql`
    UPDATE factory.notifications
    SET error = ${result.error}, next_at = ${new Date(now.getTime() + backoffMs(row.attempts))}, failed_at = ${spent ? now : null}
    WHERE key = ${row.key} AND attempts = ${row.attempts} AND sent_at IS NULL AND failed_at IS NULL AND folded_at IS NULL`
}

export interface SendOptions {
  notifier: Notifier
  now: () => Date
  /** why a row counts as sent without a delivery (the notifier is off) */
  note?: string | null
}

/** One claimed row through the notifier and into its record; says whether it arrived and why not. */
async function deliver(sql: SQL, row: Claimed, options: SendOptions): Promise<string | null> {
  let result: Awaited<ReturnType<Notifier['send']>>
  try {
    result = await options.notifier.send(row.text)
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  try {
    await recordResult(sql, row, result, options.now(), options.note ?? null)
  } catch (error) {
    // The message went out and the record did not: the lease runs out and it is sent again (at-least-once).
    return `${row.key}: could not record the result: ${error instanceof Error ? error.message : String(error)}`
  }
  return result.ok ? null : `${row.key}: ${result.error}`
}

/**
 * Sends what is due: claim and commit, call the notifier outside any transaction (every call has a process timeout, and the
 * calls of one pass run side by side, so an ntfy that is down costs one timeout, not five), record each result. Returns the keys
 * sent and the errors of those that were not. Safe beside a second caller: a claimed row is not due to anyone else.
 */
export async function sendDue(
  sql: SQL,
  options: SendOptions & { limit?: number },
): Promise<{ sent: string[]; errors: string[] }> {
  const rows = await claim(sql, options.now(), options.limit ?? BATCH)
  const sent: string[] = []
  const errors: string[] = []
  await Promise.all(
    rows.map(async (row) => {
      const error = await deliver(sql, row, options)
      if (error === null) sent.push(row.key)
      else errors.push(error)
    }),
  )
  return { sent, errors }
}

/**
 * A message sent now, on the caller's wait: the row is made already claimed (a try counted, leased), so the tick cannot send it
 * beside the caller. `factory notify test` goes this way and learns whether it arrived. `created` is false when the key was there already.
 */
export async function sendNow(
  sql: SQL,
  message: Message,
  options: SendOptions,
): Promise<{ created: boolean; error: string | null }> {
  const now = options.now()
  const rows = await sql`
    INSERT INTO factory.notifications (key, kind, issue_id, text, created_at, next_at, attempts)
    VALUES (${message.key}, ${message.kind}, ${message.issueId}, ${message.text}, ${now}, ${new Date(now.getTime() + LEASE_MS)}, 1)
    ON CONFLICT (key) DO NOTHING
    RETURNING key`
  if (rows.length === 0) return { created: false, error: null }
  const error = await deliver(sql, { key: message.key, text: message.text, attempts: 1 }, options)
  return { created: true, error }
}

interface Row {
  key: string
  kind: NotificationKind
  issue_id: number | null
  text: string
  created_at: Date
  sent_at: Date | null
  attempts: number
  error: string | null
  failed_at: Date | null
  folded_at: Date | null
  folded_reason: string | null
}

const toNotification = (row: Row): Notification => ({
  key: row.key,
  kind: row.kind,
  issueId: row.issue_id,
  text: row.text,
  status: row.sent_at ? 'sent' : row.failed_at ? 'failed' : row.folded_at ? 'folded' : 'pending',
  createdAt: row.created_at.toISOString(),
  sentAt: row.sent_at?.toISOString() ?? null,
  attempts: row.attempts,
  error: row.error,
  foldedReason: row.folded_reason,
})

/** Newest first; `pending` leaves out what was sent. */
export async function listNotifications(
  sql: SQL,
  options: { pending?: boolean; limit?: number } = {},
): Promise<Notification[]> {
  const rows: Row[] = await sql`
    SELECT key, kind, issue_id, text, created_at, sent_at, attempts, error, failed_at, folded_at, folded_reason FROM factory.notifications
    WHERE (${options.pending ?? false}::boolean = false OR (sent_at IS NULL AND folded_at IS NULL))
    ORDER BY created_at DESC, key DESC LIMIT ${options.limit ?? 100}`
  return rows.map(toNotification)
}

export async function getNotification(sql: SQL, key: string): Promise<Notification | undefined> {
  const [row]: Row[] = await sql`
    SELECT key, kind, issue_id, text, created_at, sent_at, attempts, error, failed_at, folded_at, folded_reason FROM factory.notifications WHERE key = ${key}`
  return row && toNotification(row)
}

/** A line in `factory status` for each message that spent its attempts. */
export async function notificationAttention(sql: SQL, now: Date): Promise<string[]> {
  const rows: { key: string; error: string | null }[] = await sql`
    SELECT key, error FROM factory.notifications
    WHERE failed_at IS NOT NULL AND failed_at > ${new Date(now.getTime() - FINISHED_HEALTH_MS)}
    ORDER BY created_at DESC LIMIT 10`
  return rows.map((row) => `notification ${row.key} was not delivered: ${row.error ?? 'unknown'}`)
}
