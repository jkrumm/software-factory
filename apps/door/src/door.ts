import { createHash, timingSafeEqual } from 'node:crypto'
import {
  type AlertRequest,
  type DoorReport,
  type FeedbackRequest,
  feedbackTokenKey,
  MAX_FACTS_BYTES,
  SignalAck,
} from '@software-factory/contract'
import { parseFeedback, type Parser, PARSERS, PayloadError } from './parsers.ts'
import type { Tokens } from './tokens.ts'

/** Largest body the door reads; the cap is enforced on the bytes as they arrive, not on what the sender claims. */
export const MAX_BODY_BYTES = 64 * 1024

/** What the server answered: its status and its body, unparsed. */
export type Filed = { status: number; body: unknown }

export interface DoorOptions {
  /** one token per source */
  tokens: Tokens
  /** files one alert with the server's API; throws when it cannot be reached */
  file: (input: AlertRequest) => Promise<Filed>
  /** files one app's feedback with the server's API; throws when it cannot be reached. Without it `/feedback/<app>` is 404. */
  feedback?: (input: FeedbackRequest) => Promise<Filed>
  parsers?: Readonly<Record<string, Parser>>
  /** one line per request: the time, the status and the source, never a body or a token */
  log?: (line: string) => void
  /** tells the server a refusal or an accepted message; best effort, never awaited by the response, its errors are swallowed */
  report?: (report: DoorReport) => Promise<void>
  /** the clock of the log lines */
  now?: () => Date
}

/** A request with this header is the factory's own health probe: logged as `probe`, never reported as a refusal. */
export const PROBE_HEADER = 'x-factory-probe'

const ROUTE = /^\/alert\/([a-z][a-z0-9-]{0,31})$/
const FEEDBACK_ROUTE = /^\/feedback\/([a-z][a-z0-9-]{0,22})$/
const digest = (value: string) => createHash('sha256').update(value).digest()
/** What an unknown source is compared with, so it costs the same as a known one. */
const NO_TOKEN = digest('no such source')

/** The facts the server takes, or a marker that there were more: an alert is never lost to the size of its detail. */
const fitFacts = (facts: Record<string, unknown>): Record<string, unknown> =>
  Buffer.byteLength(JSON.stringify(facts)) <= MAX_FACTS_BYTES ? facts : { truncated: true }

const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined

const reply = (status: number, body?: unknown, headers?: Record<string, string>): Response =>
  body === undefined ? new Response(null, { status, headers }) : Response.json(body, { status, headers })

/** The bearer token against the source's, in constant time: equal-length digests whatever the sender sent. */
function authorized(req: Request, token: string | undefined): boolean {
  const presented = /^Bearer (.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]
  const expected = token === undefined ? NO_TOKEN : digest(token)
  const matches = timingSafeEqual(digest(presented ?? ''), expected)
  return matches && token !== undefined && presented !== undefined
}

class TooLarge extends Error {}

async function readBody(req: Request): Promise<string> {
  const chunks: Uint8Array[] = []
  let size = 0
  if (req.body) {
    for await (const chunk of req.body) {
      size += chunk.byteLength
      if (size > MAX_BODY_BYTES) throw new TooLarge()
      chunks.push(chunk)
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The door: `POST /alert/<source>` and `POST /feedback/<app>` and nothing else (an app's token is `feedback-<app>`). A request passes, in this order: the route and method, the bearer token of
 * that source (401 with no body, an unknown source the same), `application/json`, the size, the source's parser. A real alert
 * is filed with the server and its ack passed on (200); a server that cannot be reached, or answers 5xx, is 503.
 */
export function createDoor(options: DoorOptions): (req: Request) => Promise<Response> {
  const parsers = options.parsers ?? PARSERS
  const write = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  const now = options.now ?? (() => new Date())
  const log = (line: string) => write(`${now().toISOString()} ${line}`)
  const report = (body: DoorReport) => {
    if (!options.report) return
    try {
      options.report(body).catch(() => undefined)
    } catch {
      // best effort: a report never fails the response
    }
  }

  /** The body of a request as JSON, or the response that refuses it: content type, size, syntax, in that order. */
  async function payloadOf(req: Request): Promise<{ payload: unknown } | { refusal: Response }> {
    const type = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    if (type !== 'application/json') return { refusal: reply(415, { error: 'content-type must be application/json' }) }
    let text: string
    try {
      text = await readBody(req)
    } catch (error) {
      if (error instanceof TooLarge) {
        return { refusal: reply(413, { error: `body is larger than ${MAX_BODY_BYTES} bytes` }) }
      }
      throw error
    }
    try {
      return { payload: JSON.parse(text) }
    } catch {
      return { refusal: reply(400, { error: 'body is not valid JSON' }) }
    }
  }

  /** What the server answered, as the door answers: its ack, or a refusal that names no reason. */
  function answerOf(filed: Filed, what: string): Response {
    if (filed.status === 200) {
      const ack = SignalAck.safeParse(filed.body)
      return ack.success ? reply(200, ack.data) : reply(502, { error: 'the factory answered another shape' })
    }
    // Its reason can name a path: the door says only that it was refused.
    if (filed.status === 422) return reply(422, { error: `the ${what} was refused` })
    return reply(filed.status >= 500 ? 503 : 502, { error: `the factory did not take the ${what}` })
  }

  async function handle(req: Request, source: string): Promise<Response> {
    const parse = own(parsers, source)
    // A token with no parser behind it: authorized, and then nothing to do with the body.
    if (!parse) return reply(404, { error: 'no such source' })
    const read = await payloadOf(req)
    if ('refusal' in read) return read.refusal

    let parsed: ReturnType<Parser>
    try {
      parsed = parse(read.payload)
    } catch (error) {
      if (error instanceof PayloadError) return reply(400, { error: `not a ${source} payload: ${error.message}` })
      throw error
    }
    if (parsed.kind === 'ignore') {
      report({ kind: 'accepted', source })
      return reply(200, { outcome: 'ignored' })
    }

    let filed: Filed
    try {
      filed = await options.file({ source, ...parsed.alert, facts: fitFacts(parsed.alert.facts) })
    } catch {
      return reply(503, { error: 'the factory is not reachable' })
    }
    return answerOf(filed, 'alert')
  }

  async function handleFeedback(req: Request, app: string): Promise<Response> {
    if (!options.feedback) return reply(404, { error: 'no such source' })
    const read = await payloadOf(req)
    if ('refusal' in read) return read.refusal

    let input: FeedbackRequest
    try {
      input = parseFeedback(app, read.payload)
    } catch (error) {
      if (error instanceof PayloadError) return reply(400, { error: `not a feedback payload: ${error.message}` })
      throw error
    }
    let filed: Filed
    try {
      filed = await options.feedback(input)
    } catch {
      return reply(503, { error: 'the factory is not reachable' })
    }
    return answerOf(filed, 'feedback')
  }

  /** The log label of a 401. A probe is the factory's own health check; a refusal on a source with a token is reported. */
  function refused(req: Request, source: string): string {
    if (req.headers.get(PROBE_HEADER) === '1') return `probe ${source}`
    if (own(options.tokens, source) !== undefined) report({ kind: 'refused', source })
    return `refused ${source}`
  }

  return async (req) => {
    const started = performance.now()
    const pathname = new URL(req.url).pathname
    const app = FEEDBACK_ROUTE.exec(pathname)?.[1]
    // One token table: an app's feedback token is `feedback-<app>`, and that is also its label in logs and reports.
    const source = app ? feedbackTokenKey(app) : ROUTE.exec(pathname)?.[1]
    let label = '-'
    let response: Response
    try {
      if (!source) response = reply(404)
      else if (req.method !== 'POST') response = reply(405, undefined, { allow: 'POST' })
      else if (!authorized(req, own(options.tokens, source))) {
        response = reply(401, undefined, { 'www-authenticate': 'Bearer' })
        label = refused(req, source)
      } else {
        label = source
        response = app ? await handleFeedback(req, app) : await handle(req, source)
      }
    } catch (error) {
      log(`error ${error instanceof Error ? error.name : 'unknown'}`)
      response = reply(500, { error: 'internal error' })
    }
    const method = /^[A-Z]{1,8}$/.test(req.method) ? req.method : '-'
    log(`${method} ${label} ${response.status} ${Math.round(performance.now() - started)}ms`)
    return response
  }
}

/** The server's API on loopback: the door's only way to the factory. */
export const DEFAULT_FACTORY_URL = 'http://127.0.0.1:7793'

/** The door's own bearer token for the factory (`FACTORY_DOOR_TOKEN`); the door does not start without it. */
export function doorTokenFrom(env: Record<string, string | undefined>): string {
  const token = env.FACTORY_DOOR_TOKEN
  if (!token) throw new Error('FACTORY_DOOR_TOKEN is required: the factory answers the door with 401 without it')
  return token
}

const post = (base: string, token: string, path: string, body: unknown) =>
  fetch(new URL(path, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })

/** Reports to the server's API (`POST /door/reports`). */
export function reportViaHttp(base: string, token: string): NonNullable<DoorOptions['report']> {
  return async (report) => {
    const response = await post(base, token, '/door/reports', report)
    if (!response.ok) throw new Error(`report answered ${response.status}`)
  }
}

/** Files an app's feedback with the server's API (`POST /signals/feedback`). */
export function feedbackViaHttp(base: string, token: string): NonNullable<DoorOptions['feedback']> {
  return async (input) => {
    const response = await post(base, token, '/signals/feedback', input)
    const body: unknown = await response.json().catch(() => null)
    return { status: response.status, body }
  }
}

/** Files an alert with the server's API (`POST /signals/alerts`). */
export function fileViaHttp(base: string, token: string): DoorOptions['file'] {
  return async (input) => {
    const response = await post(base, token, '/signals/alerts', input)
    const body: unknown = await response.json().catch(() => null)
    return { status: response.status, body }
  }
}
