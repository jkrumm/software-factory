import { FleetFrame, HelloFrame, IssueFrame, SessionFrame, API_VERSION } from '@software-factory/contract'
import type { SQL } from 'bun'
import type { Clock } from '../clock.ts'
import { getSession } from '../sessions.ts'
import { describeEvent } from './describe.ts'
import type { Reader } from './index.ts'

/** How often both event tables are read: an indexed range read each, no connection held, no transaction across the wait. */
export const POLL_MS = 1_000
/** A comment line when nothing else was written for this long, so a proxy or a client does not call the stream dead. */
export const KEEPALIVE_MS = 15_000
/** Rows one poll takes from a table; a longer backlog is read at once, without waiting. */
const BATCH = 500

export interface Cursor {
  issue: number
  session: number
}

/** `i<issue event id>.s<session event id>`, opaque to a client. */
export const formatCursor = (cursor: Cursor): string => `i${cursor.issue}.s${cursor.session}`

export function parseCursor(raw: string): Cursor | null {
  const match = /^i(\d{1,15})\.s(\d{1,15})$/.exec(raw)
  return match ? { issue: Number(match[1]), session: Number(match[2]) } : null
}

/** A cursor that is malformed, or ahead of anything stored: the client reads the resources again (410). */
export class CursorGone extends Error {}

export interface StreamDeps {
  sql: SQL
  clock: Clock
  /** names the Issue of a session event */
  reader: Pick<Reader, 'issuesOf'>
  pollMs?: number
  keepaliveMs?: number
  /** waits between two polls and ends early when the signal aborts; real timers unless a test brings its own */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

const timerSleep = (ms: number, signal: AbortSignal): Promise<void> =>
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

/** The newest id of each table: "now". */
async function head(sql: SQL): Promise<Cursor> {
  const [row]: { i: string; s: string }[] = await sql`
    SELECT (SELECT COALESCE(max(id), 0) FROM factory.issue_events)::text AS i,
           (SELECT COALESCE(max(id), 0) FROM factory.events)::text AS s`
  return { issue: Number(row?.i ?? 0), session: Number(row?.s ?? 0) }
}

/** Where a stream begins: the cursor a client sent, or now. A malformed cursor or one ahead of the tables is `CursorGone`. */
export async function startCursor(sql: SQL, since: string | null): Promise<Cursor> {
  const now = await head(sql)
  if (since === null || since === '') return now
  const cursor = parseCursor(since)
  if (!cursor || cursor.issue > now.issue || cursor.session > now.session) throw new CursorGone('unknown cursor')
  return cursor
}

const frame = (id: Cursor, event: string, data: unknown): string =>
  `id: ${formatCursor(id)}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`

interface IssueRow {
  id: string
  issue_id: number
  kind: string
  from_state: string | null
  to_state: string | null
  at: Date
  payload: unknown
}

interface SessionRow {
  id: string
  session: string
  kind: string
  at: Date
}

async function fingerprint(sql: SQL): Promise<{ fingerprint: string; builtAt: string } | undefined> {
  const [row]: { fingerprint: string; built_at: Date }[] =
    await sql`SELECT fingerprint, built_at FROM factory.fleet_snapshot WHERE id = 1`
  return row && { fingerprint: row.fingerprint, builtAt: row.built_at.toISOString() }
}

/**
 * The stream as SSE text, until `signal` aborts: `hello`, then every new row of `issue_events` and `events` in time order (each
 * table in id order, so the cursor on a frame is exact: a client that reconnects with it misses and repeats nothing), a `fleet`
 * frame when the snapshot's fingerprint moves, and a keepalive comment when nothing was written for a while. `issue` keeps that
 * Issue's events and the events of its sessions. A frame says what happened and where to read; it is never a resource.
 */
export async function* frames(
  deps: StreamDeps,
  start: Cursor,
  options: { issue?: number; signal: AbortSignal },
): AsyncGenerator<string> {
  const { sql, clock, reader } = deps
  const pollMs = deps.pollMs ?? POLL_MS
  const keepaliveMs = deps.keepaliveMs ?? KEEPALIVE_MS
  const sleep = deps.sleep ?? timerSleep
  const { issue, signal } = options
  const cursor = { ...start }
  let seen = (await fingerprint(sql))?.fingerprint
  let lastWrite = clock.now().getTime()

  yield frame(cursor, 'hello', HelloFrame.parse({ version: API_VERSION, cursor: formatCursor(cursor) }))

  while (!signal.aborted) {
    const issueRows: IssueRow[] =
      issue === undefined
        ? await sql`
            SELECT id, issue_id, kind, from_state, to_state, at, payload FROM factory.issue_events
            WHERE id > ${cursor.issue} ORDER BY id LIMIT ${BATCH}`
        : await sql`
            SELECT id, issue_id, kind, from_state, to_state, at, payload FROM factory.issue_events
            WHERE id > ${cursor.issue} AND issue_id = ${issue} ORDER BY id LIMIT ${BATCH}`
    const sessionRows: SessionRow[] = await sql`
      SELECT id, session, kind, at FROM factory.events
      WHERE id > ${cursor.session} AND session <> '_runner' ORDER BY id LIMIT ${BATCH}`
    const sessionIds = [...new Set(sessionRows.map((r) => r.session))]
    const issues = await reader.issuesOf(sessionIds)
    const states = new Map<string, string | null>()
    for (const id of sessionIds) {
      // Only a session the frame will name is looked up; one outside the `issue` filter is skipped.
      if (issue !== undefined && issues.get(id) !== issue) continue
      states.set(id, (await getSession(sql, id, clock.now()))?.state ?? null)
    }

    let i = 0
    let s = 0
    let wrote = false
    while (i < issueRows.length || s < sessionRows.length) {
      const a = issueRows[i]
      const b = sessionRows[s]
      // Merge by time; each table stays in id order, which is what makes the cursor exact.
      const takeIssue = a !== undefined && (b === undefined || a.at.getTime() <= b.at.getTime())
      if (takeIssue) {
        i++
        cursor.issue = Number(a.id)
        yield frame(
          cursor,
          'issue',
          IssueFrame.parse({
            issue: a.issue_id,
            kind: a.kind,
            from: a.from_state,
            to: a.to_state,
            at: a.at.toISOString(),
            text: describeEvent(a.kind, a.from_state, a.to_state, a.payload),
          }),
        )
        wrote = true
        continue
      }
      if (b === undefined) break
      s++
      cursor.session = Number(b.id)
      if (issue !== undefined && issues.get(b.session) !== issue) continue
      yield frame(
        cursor,
        'session',
        SessionFrame.parse({
          session: b.session,
          issue: issues.get(b.session) ?? null,
          kind: b.kind,
          state: states.get(b.session) ?? null,
          at: b.at.toISOString(),
        }),
      )
      wrote = true
    }
    // Rows filtered out still moved the cursor; the next frame carries it.

    const moved = await fingerprint(sql)
    if (moved && moved.fingerprint !== seen) {
      seen = moved.fingerprint
      yield frame(cursor, 'fleet', FleetFrame.parse(moved))
      wrote = true
    }

    const now = clock.now().getTime()
    if (wrote) lastWrite = now
    else if (now - lastWrite >= keepaliveMs) {
      lastWrite = now
      yield ': keepalive\n\n'
    }
    // A full batch means more is waiting: read it before sleeping.
    if (issueRows.length < BATCH && sessionRows.length < BATCH) await sleep(pollMs, signal)
  }
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  'x-accel-buffering': 'no',
}

/**
 * `GET /v1/stream?since=<cursor>&issue=<id>` (`Last-Event-ID` works the same). The caller has checked the token and the host;
 * `noTimeout` takes the connection out of Bun's idle timer, which would cut a stream that is quiet between keepalives.
 */
export function streamHandler(deps: StreamDeps, noTimeout: (req: Request) => void) {
  const encoder = new TextEncoder()
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const rawIssue = url.searchParams.get('issue')
    const issue = rawIssue === null ? undefined : Number(rawIssue)
    if (issue !== undefined && !(Number.isSafeInteger(issue) && issue > 0)) {
      return Response.json({ error: 'issue must be a positive integer' }, { status: 400 })
    }
    const since = url.searchParams.get('since') ?? req.headers.get('last-event-id')
    let start: Cursor
    try {
      start = await startCursor(deps.sql, since)
    } catch (error) {
      if (!(error instanceof CursorGone)) throw error
      return Response.json(
        { error: 'that cursor is not known: read the resources again', code: 'gone' },
        { status: 410 },
      )
    }
    noTimeout(req)
    const abort = new AbortController()
    req.signal.addEventListener('abort', () => abort.abort())
    const source = frames(deps, start, { ...(issue === undefined ? {} : { issue }), signal: abort.signal })
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await source.next()
        if (next.done) controller.close()
        else controller.enqueue(encoder.encode(next.value))
      },
      async cancel() {
        abort.abort()
        await source.return(undefined)
      },
    })
    return new Response(body, { headers: SSE_HEADERS })
  }
}
