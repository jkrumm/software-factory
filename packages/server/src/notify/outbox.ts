import type { Notification, NotificationKind } from '@software-factory/contract'
import type { SQL } from 'bun'
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
 * `limit`, or just `key`) are counted as tried and leased. Nothing is sent here.
 */
export async function claim(sql: SQL, now: Date, limit: number, key?: string): Promise<Claimed[]> {
  return sql.begin(async (tx) => {
    await tx`
      UPDATE factory.notifications SET failed_at = ${now}, error = COALESCE(error, 'the send did not report back')
      WHERE sent_at IS NULL AND failed_at IS NULL AND attempts >= ${MAX_ATTEMPTS} AND next_at <= ${now}`
    const due: { key: string; text: string; attempts: number }[] = await tx`
      SELECT key, text, attempts FROM factory.notifications
      WHERE sent_at IS NULL AND failed_at IS NULL AND next_at <= ${now} AND (${key ?? null}::text IS NULL OR key = ${key ?? null}::text)
      ORDER BY created_at, key LIMIT ${limit}
      FOR UPDATE SKIP LOCKED`
    const claimed: Claimed[] = []
    for (const row of due) {
      const attempts = row.attempts + 1
      await tx`
        UPDATE factory.notifications SET attempts = ${attempts}, next_at = ${new Date(now.getTime() + LEASE_MS)}
        WHERE key = ${row.key}`
      claimed.push({ key: row.key, text: row.text, attempts })
    }
    return claimed
  })
}

/** Phase 3: the result, in a statement of its own. */
async function recordResult(
  sql: SQL,
  row: Claimed,
  result: Awaited<ReturnType<Notifier['send']>>,
  now: Date,
  note: string | null,
): Promise<void> {
  if (result.ok) {
    await sql`UPDATE factory.notifications SET sent_at = ${now}, error = ${note} WHERE key = ${row.key}`
    return
  }
  const spent = row.attempts >= MAX_ATTEMPTS
  await sql`
    UPDATE factory.notifications
    SET error = ${result.error}, next_at = ${new Date(now.getTime() + backoffMs(row.attempts))}, failed_at = ${spent ? now : null}
    WHERE key = ${row.key}`
}

export interface SendOptions {
  notifier: Notifier
  now: () => Date
  /** why a row counts as sent without a delivery (the notifier is off) */
  note?: string | null
}

/**
 * Sends what is due: claim and commit, call the notifier outside any transaction (every call has a process timeout, and the
 * calls of one pass run side by side, so a Hermes that is down costs one timeout, not five), record each result. Returns the keys
 * sent and the errors of those that were not. Safe beside a second caller: a claimed row is not due to anyone else.
 */
export async function sendDue(
  sql: SQL,
  options: SendOptions & { limit?: number; key?: string },
): Promise<{ sent: string[]; errors: string[] }> {
  const rows = await claim(sql, options.now(), options.limit ?? BATCH, options.key)
  const sent: string[] = []
  const errors: string[] = []
  await Promise.all(
    rows.map(async (row) => {
      let result: Awaited<ReturnType<Notifier['send']>>
      try {
        result = await options.notifier.send(row.text)
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      try {
        await recordResult(sql, row, result, options.now(), options.note ?? null)
        if (result.ok) sent.push(row.key)
        else errors.push(`${row.key}: ${result.error}`)
      } catch (error) {
        // The message went out and the record did not: the lease runs out and it is sent again (at-least-once).
        errors.push(
          `${row.key}: could not record the result: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }),
  )
  return { sent, errors }
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
}

const toNotification = (row: Row): Notification => ({
  key: row.key,
  kind: row.kind,
  issueId: row.issue_id,
  text: row.text,
  status: row.sent_at ? 'sent' : row.failed_at ? 'failed' : 'pending',
  createdAt: row.created_at.toISOString(),
  sentAt: row.sent_at?.toISOString() ?? null,
  attempts: row.attempts,
  error: row.error,
})

/** Newest first; `pending` leaves out what was sent. */
export async function listNotifications(
  sql: SQL,
  options: { pending?: boolean; limit?: number } = {},
): Promise<Notification[]> {
  const rows: Row[] = await sql`
    SELECT key, kind, issue_id, text, created_at, sent_at, attempts, error, failed_at FROM factory.notifications
    WHERE (${options.pending ?? false}::boolean = false OR sent_at IS NULL)
    ORDER BY created_at DESC, key DESC LIMIT ${options.limit ?? 100}`
  return rows.map(toNotification)
}

export async function getNotification(sql: SQL, key: string): Promise<Notification | undefined> {
  const [row]: Row[] = await sql`
    SELECT key, kind, issue_id, text, created_at, sent_at, attempts, error, failed_at FROM factory.notifications WHERE key = ${key}`
  return row && toNotification(row)
}

/** How long a message that was not delivered stays a line in `factory status`. */
export const FAILED_SHOWN_MS = 7 * 24 * 60 * 60_000

/** A line in `factory status` for each message that spent its attempts. */
export async function notificationAttention(sql: SQL, now: Date): Promise<string[]> {
  const rows: { key: string; error: string | null }[] = await sql`
    SELECT key, error FROM factory.notifications
    WHERE failed_at IS NOT NULL AND failed_at > ${new Date(now.getTime() - FAILED_SHOWN_MS)}
    ORDER BY created_at DESC LIMIT 10`
  return rows.map((row) => `notification ${row.key} was not delivered: ${row.error ?? 'unknown'}`)
}
