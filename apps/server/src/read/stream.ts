import type { ChangeKind, ReadChange } from '@software-factory/contract'
import { CHANGE_KINDS, READ_API_VERSION } from '@software-factory/contract'
import type { SQL } from 'bun'

/**
 * The change stream: `factory.changes` rows (written by triggers, `0800_changes.sql`) read in the order of a cursor.
 *
 * **The cursor is `<txid>.<seq>`**, both decimal and opaque to clients. A row's `txid` is the id of the transaction that
 * wrote it (`xid8`), its `seq` an identity number, and the order is (txid, seq).
 *
 * **Why resume loses nothing and doubles nothing.** `seq` is drawn when a row is inserted, not when its transaction
 * commits, so a transaction that started early can commit its rows after a later one: ordering by `seq` alone would show a
 * reader the later rows first and the late ones behind a cursor already past them. So a reader emits only rows whose
 * `txid < pg_snapshot_xmin(pg_current_snapshot())`: every transaction with a lower id has finished, committed or rolled
 * back. A row that appears after that moment belongs to a transaction whose id is not below that horizon, so it sorts after
 * everything emitted; a row below it is already visible. Rows of one transaction commit together and so appear together,
 * and ordered by `seq` within it. The cursor after a batch is its last row, and the next read is strictly after it:
 * no row is sent twice, and none is skipped, whatever the batch size, the reconnect or the commit order.
 * The price: one long open transaction anywhere in the cluster holds the stream at its id until it ends (the server's own
 * transactions are short, and the advisory process lock is a session lock, not a transaction).
 *
 * A cursor that does not parse, or lies beyond every stored row (`seq` past the largest, `txid` past the next transaction
 * id: another database, a reset), is `CursorGone`: the client starts again from `GET /v1/changes` without `since`.
 */

export interface Cursor {
  txid: bigint
  seq: bigint
}

const CURSOR = /^(\d{1,20})\.(\d{1,19})$/
const MAX_TXID = 2n ** 64n - 1n
const MAX_SEQ = 2n ** 63n - 1n

/** The cursor a text names, or null when it is not one. */
export function parseCursor(text: string): Cursor | null {
  const match = CURSOR.exec(text)
  if (!match?.[1] || !match[2]) return null
  const txid = BigInt(match[1])
  const seq = BigInt(match[2])
  return txid > MAX_TXID || seq > MAX_SEQ ? null : { txid, seq }
}

export const formatCursor = (cursor: Cursor): string => `${cursor.txid}.${cursor.seq}`

/** A cursor the stream cannot resume from; the route answers 410 `cursor_gone`. */
export class CursorGone extends Error {
  constructor(readonly cursor: string) {
    super(`the cursor ${JSON.stringify(cursor.slice(0, 64))} is not one this server can resume from`)
    this.name = 'CursorGone'
  }
}

/** The text columns are named apart from `seq` and `txid`: an ORDER BY of the plain name would sort the text ("10" before "8"). */
interface ChangeRow {
  seq_text: string
  txid_text: string
  at: Date
  kind: string
  issue_id: string | null
  subject: string | null
  detail: unknown
}

const isKind = (kind: string): kind is ChangeKind => (CHANGE_KINDS as readonly string[]).includes(kind)

const issueNumber = (id: string | null): number | null => {
  const match = id ? /^issue_([1-9][0-9]*)$/.exec(id) : null
  return match?.[1] ? Number(match[1]) : null
}

function toChange(row: ChangeRow): ReadChange {
  const detail = typeof row.detail === 'string' ? (JSON.parse(row.detail) as unknown) : row.detail
  return {
    cursor: formatCursor({ txid: BigInt(row.txid_text), seq: BigInt(row.seq_text) }),
    kind: isKind(row.kind) ? row.kind : 'issue',
    issue: issueNumber(row.issue_id),
    ref: row.issue_id,
    subject: row.subject,
    detail:
      typeof detail === 'object' && detail !== null && !Array.isArray(detail)
        ? (detail as Record<string, unknown>)
        : {},
    at: row.at.toISOString(),
  }
}

/** The cursor of the newest row a reader may emit now: where a stream with no `since` begins. `0.0` while there is none. */
export async function nowCursor(sql: SQL): Promise<Cursor> {
  const rows: { seq_text: string; txid_text: string }[] = await sql`
    SELECT seq::text AS seq_text, txid::text AS txid_text FROM factory.changes
    WHERE txid < pg_snapshot_xmin(pg_current_snapshot())
    ORDER BY txid DESC, seq DESC LIMIT 1`
  const row = rows[0]
  return row ? { txid: BigInt(row.txid_text), seq: BigInt(row.seq_text) } : { txid: 0n, seq: 0n }
}

export async function assertResumable(sql: SQL, cursor: Cursor): Promise<void> {
  if (cursor.txid === 0n && cursor.seq === 0n) return
  const rows: { max_seq: string; next_txid: string }[] = await sql`
    SELECT coalesce(max(seq), 0)::text AS max_seq, pg_snapshot_xmax(pg_current_snapshot())::text AS next_txid
    FROM factory.changes`
  const row = rows[0]
  if (!row) return
  if (cursor.seq > BigInt(row.max_seq) || cursor.txid > BigInt(row.next_txid))
    throw new CursorGone(formatCursor(cursor))
}

/** Where a request resumes: the cursor it sent, else now. Throws `CursorGone` for one that does not parse or lies beyond the stored rows. */
export async function resolveCursor(sql: SQL, since: string | null | undefined): Promise<Cursor> {
  if (!since) return nowCursor(sql)
  const cursor = parseCursor(since)
  if (!cursor) throw new CursorGone(since)
  await assertResumable(sql, cursor)
  return cursor
}

/**
 * The changes strictly after `cursor`, in (txid, seq) order, at most `limit`, only those a reader may emit (see the
 * header), optionally one Issue's (`issue` is `issue_<n>`). `next` is the cursor to ask with next: the last change's, or
 * `cursor` itself when there is none. Throws `CursorGone` for a cursor beyond the stored rows.
 */
export async function changesAfter(
  sql: SQL,
  input: { cursor: Cursor; issue?: string | null; limit: number },
): Promise<{ changes: ReadChange[]; next: Cursor }> {
  const { cursor, limit } = input
  await assertResumable(sql, cursor)
  const only = input.issue ? sql`AND issue_id = ${input.issue}` : sql``
  const rows: ChangeRow[] = await sql`
    SELECT seq::text AS seq_text, txid::text AS txid_text, at, kind, issue_id, subject, detail FROM factory.changes
    WHERE (txid, seq) > (${cursor.txid.toString()}::xid8, ${cursor.seq.toString()}::bigint)
      AND txid < pg_snapshot_xmin(pg_current_snapshot())
      ${only}
    ORDER BY txid, seq LIMIT ${limit}`
  const changes = rows.map(toChange)
  const last = changes.at(-1)
  return { changes, next: (last && parseCursor(last.cursor)) || cursor }
}

// --- the frames ----------------------------------------------------------------------------------------------------------

/** One frame of the stream, before it is text. */
export type StreamEvent =
  | { type: 'hello'; cursor: string }
  | { type: 'change'; change: ReadChange }
  | { type: 'keepalive' }

/** A frame as SSE text. A change's `data:` carries no cursor of its own: the `id:` line is the cursor. */
export function encodeFrame(event: StreamEvent): string {
  switch (event.type) {
    case 'keepalive':
      return ': keepalive\n\n'
    case 'hello':
      return `id: ${event.cursor}\nevent: hello\ndata: ${JSON.stringify({ version: READ_API_VERSION, cursor: event.cursor })}\n\n`
    case 'change': {
      const { cursor, kind, issue, ref, subject, detail, at } = event.change
      return `id: ${cursor}\nevent: ${kind}\ndata: ${JSON.stringify({ kind, issue, ref, subject, detail, at })}\n\n`
    }
  }
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done)
  })

export const KEEPALIVE_MS = 15_000
const BATCH = 200

/**
 * The stream from `cursor` until `signal` aborts: `hello` with the cursor it starts from, then every change after it, polled
 * every `pollMs`, and a keepalive after `keepaliveMs` with nothing sent. A reader that fell behind drains without sleeping.
 */
export async function* follow(
  sql: SQL,
  input: {
    cursor: Cursor
    issue?: string | null
    pollMs: number
    signal: AbortSignal
    keepaliveMs?: number
    batch?: number
  },
): AsyncGenerator<StreamEvent> {
  const { signal, pollMs, issue } = input
  const keepaliveMs = input.keepaliveMs ?? KEEPALIVE_MS
  const batch = input.batch ?? BATCH
  let cursor = input.cursor
  yield { type: 'hello', cursor: formatCursor(cursor) }
  let lastSentAt = Date.now()
  while (!signal.aborted) {
    const { changes, next } = await changesAfter(sql, { cursor, issue, limit: batch })
    for (const change of changes) yield { type: 'change', change }
    cursor = next
    if (changes.length > 0) lastSentAt = Date.now()
    if (changes.length === batch) continue
    if (Date.now() - lastSentAt >= keepaliveMs) {
      yield { type: 'keepalive' }
      lastSentAt = Date.now()
    }
    await sleep(Math.min(pollMs, keepaliveMs), signal)
  }
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
} as const

/** The SSE response of a followed stream; closing the connection aborts the follow. */
export function streamResponse(events: AsyncGenerator<StreamEvent>, abort: AbortController): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await events.next().catch((error: unknown) => {
        controller.error(error)
        return null
      })
      if (!next) return
      if (next.done) return controller.close()
      controller.enqueue(encoder.encode(encodeFrame(next.value)))
    },
    cancel() {
      abort.abort()
      void events.return(undefined)
    },
  })
  return new Response(body, { headers: SSE_HEADERS })
}
