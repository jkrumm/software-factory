import { parseArgs } from 'node:util'
import { type SseEvent, StreamError, streamEvents } from '@software-factory/client'
import { ErrorBody, ReadChange, StreamHello } from '@software-factory/contract'
import { EXIT, FactoryError, kindForStatus, usage } from './exit.ts'
import { DEFAULT_URL, type Io, tokenOf } from './operation.ts'
import type { Format } from './output.ts'

const BIN = 'factory'
const USAGE = 'usage: follow [--issue <id>] [--since <cursor>] [--until-closed] [--format json|plain]'

export const BACKOFF_FIRST_MS = 1_000
export const BACKOFF_MAX_MS = 15_000

export interface Backoff {
  firstMs: number
  maxMs: number
}

export interface FollowInput {
  /** only this Issue's changes (`issue_12` or `12`) */
  issue?: string
  /** resume after this cursor; none, the stream starts at the server's current one */
  since?: string
  /** return once a change of `issue` shows it closed */
  untilClosed: boolean
  format: Format
}

/** The `data:` of a change frame; the cursor is the frame's `id:`. */
const ChangeData = ReadChange.omit({ cursor: true })

const clock = (iso: string | null): string =>
  (iso && /T(\d\d:\d\d:\d\d)/.exec(iso)?.[1]) || new Date().toISOString().slice(11, 19)

interface Shown {
  value: unknown
  /** the time column, the id column and the words */
  plain: [at: string, who: string, text: string]
  closed: boolean
}

function parseData(frame: SseEvent): unknown {
  try {
    return JSON.parse(frame.data)
  } catch {
    throw new FactoryError('contract_mismatch', `a ${frame.event} frame did not carry JSON`)
  }
}

function mismatch(frame: SseEvent, message: string): FactoryError {
  return new FactoryError('contract_mismatch', `a ${frame.event} frame did not match the expected shape: ${message}`, {
    hint: 'the server and the CLI are from different releases',
  })
}

function show(frame: SseEvent): Shown {
  const raw = parseData(frame)
  if (frame.event === 'hello') {
    const hello = StreamHello.safeParse(raw)
    if (!hello.success) throw mismatch(frame, hello.error.issues[0]?.message ?? 'unparseable')
    return { value: hello.data, plain: [clock(null), '-', `following from ${hello.data.cursor}`], closed: false }
  }
  const change = ChangeData.safeParse(raw)
  // An event this CLI does not know is a newer server's addition: shown as it came.
  if (!change.success) return { value: raw, plain: [clock(null), '-', frame.event], closed: false }
  const { kind, ref, subject, detail, at } = change.data
  const to = typeof detail.to === 'string' ? ` -> ${detail.to}` : ''
  return {
    value: change.data,
    plain: [clock(at), ref ?? '-', `${kind}${subject ? ` ${subject}` : ''}${to}`],
    closed: kind === 'issue' && detail.to === 'closed',
  }
}

/** A refusal of the stream as the failure it is: 410 says to read again, 401/403 are auth as everywhere. */
function refusal(error: StreamError): FactoryError {
  const body = ErrorBody.safeParse(error.body)
  const status = error.status ?? 0
  return new FactoryError(kindForStatus(status), body.success ? body.data.error : `HTTP ${status}`, {
    code: body.success ? body.data.code : null,
    hint:
      status === 410
        ? `the cursor is unknown to the server: read the resources again (${BIN} read overview) and follow without --since`
        : status === 401
          ? 'set FACTORY_TOKEN (FACTORY_READ_TOKEN reads only)'
          : '',
    details: { status },
  })
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done)
  })

/**
 * The change stream, one line per frame, until `signal` aborts (returns), the Issue closes under `untilClosed` (returns)
 * or a failure (throws). A connection that drops is reopened after the last cursor with a backoff from 1 s to 15 s; a
 * refusal (401, 403, 410, 4xx) is a failure, a 5xx or an unreachable server is waited for once the stream has been open.
 */
export async function follow(
  input: FollowInput,
  io: Io,
  signal: AbortSignal,
  backoff: Backoff = { firstMs: BACKOFF_FIRST_MS, maxMs: BACKOFF_MAX_MS },
): Promise<void> {
  if (input.untilClosed && input.issue === undefined) throw usage('--until-closed needs --issue <id>', USAGE)
  const base = io.env.FACTORY_URL || DEFAULT_URL
  let cursor = input.since
  let wait = backoff.firstMs
  let connected = false
  while (!signal.aborted) {
    try {
      const events = streamEvents({
        base,
        path: '/v1/stream',
        token: tokenOf(io.env),
        since: cursor,
        query: input.issue === undefined ? undefined : { issue: input.issue },
        signal,
      })
      for await (const frame of events) {
        connected = true
        wait = backoff.firstMs
        if (frame.id !== null) cursor = frame.id
        const shown = show(frame)
        io.out(
          input.format === 'json'
            ? `${JSON.stringify({ event: frame.event, id: frame.id, data: shown.value })}\n`
            : `${shown.plain.join('\t')}\n`,
        )
        if (input.untilClosed && shown.closed) return
      }
    } catch (error) {
      if (!(error instanceof StreamError)) throw error
      if (error.reason === 'refused' && !(connected && (error.status ?? 0) >= 500)) throw refusal(error)
      if (error.reason === 'unreachable' && !connected) {
        throw new FactoryError('network', `server unreachable at ${base}: ${error.message}`, {
          hint: `is the server up? ${BIN} version works offline`,
        })
      }
    }
    await sleep(wait, signal)
    wait = Math.min(wait * 2, backoff.maxMs)
  }
}

/** `factory follow [--issue <id>] [--since <cursor>] [--until-closed]`: SIGINT and SIGTERM end it with exit 0. */
export async function followVerb(argv: readonly string[], io: Io): Promise<number> {
  let parsed: ReturnType<typeof parseFollow>
  try {
    parsed = parseFollow(argv)
  } catch (error) {
    throw usage(`follow: ${error instanceof Error ? error.message : String(error)}`, USAGE)
  }
  const { values, positionals } = parsed
  if (values.help) {
    io.out(
      `${USAGE}\n\nOne line per change of the stream (--format json: {"event","id","data"}); Ctrl-C ends it with exit 0.\n--until-closed ends it once --issue shows closed. A dropped connection resumes after the last cursor.\n`,
    )
    return EXIT.ok
  }
  if (positionals.length) throw usage(`follow takes no argument, got: ${positionals.join(' ')}`, USAGE)
  const format = values.format ?? 'json'
  if (format !== 'json' && format !== 'plain') throw usage(`--format must be json or plain, got: ${format}`)
  const stop = new AbortController()
  const onSignal = () => stop.abort()
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  try {
    await follow(
      { issue: values.issue, since: values.since, untilClosed: values['until-closed'] === true, format },
      io,
      stop.signal,
    )
    return EXIT.ok
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    stop.abort()
  }
}

function parseFollow(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    options: {
      issue: { type: 'string' },
      since: { type: 'string' },
      'until-closed': { type: 'boolean' },
      format: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: true,
  })
}
