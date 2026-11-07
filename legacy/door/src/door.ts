import { createHash, timingSafeEqual } from 'node:crypto'
import { type DoorReport, IntakeAck, type IntakeInput, MAX_INTAKE_FACTS_BYTES } from '@software-factory/contract'
import { type Parser, PARSERS, PayloadError } from './parsers.ts'
import type { Tokens } from './tokens.ts'

/** Largest body the door reads; the cap is enforced on the bytes as they arrive, not on what the sender claims. */
export const MAX_BODY_BYTES = 64 * 1024

/** What the server answered: its status and, for a success, which of the outcomes it was. */
export type Filed = { status: number; body: unknown }

export interface DoorOptions {
  /** one token per source */
  tokens: Tokens
  /** files one alert with the server (the unix socket); throws when it cannot be reached */
  file: (input: IntakeInput) => Promise<Filed>
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
const digest = (value: string) => createHash('sha256').update(value).digest()
/** What an unknown source is compared with, so it costs the same as a known one. */
const NO_TOKEN = digest('no such source')

/** The facts the server takes, or a marker that there were more: an alert is never lost to the size of its detail. */
const fitFacts = (facts: Record<string, unknown>): Record<string, unknown> =>
  Buffer.byteLength(JSON.stringify(facts)) <= MAX_INTAKE_FACTS_BYTES ? facts : { truncated: true }

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
 * The door: `POST /alert/<source>` and nothing else. A request passes, in this order: the route and method, the bearer token of
 * that source (401 with no body, an unknown source the same), `application/json`, the size, the source's parser. A real alert
 * is filed with the server and the server's status passed on (200, 201, 202); a server that cannot be reached is 503.
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

  async function handle(req: Request, source: string): Promise<Response> {
    const parse = own(parsers, source)
    // A token with no parser behind it: authorized, and then nothing to do with the body.
    if (!parse) return reply(404, { error: 'no such source' })
    const type = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    if (type !== 'application/json') return reply(415, { error: 'content-type must be application/json' })

    let text: string
    try {
      text = await readBody(req)
    } catch (error) {
      if (error instanceof TooLarge) return reply(413, { error: `body is larger than ${MAX_BODY_BYTES} bytes` })
      throw error
    }
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      return reply(400, { error: 'body is not valid JSON' })
    }

    let parsed: ReturnType<Parser>
    try {
      parsed = parse(payload)
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
    if (filed.status >= 200 && filed.status < 300) {
      const ack = IntakeAck.safeParse(filed.body)
      return ack.success ? reply(filed.status, ack.data) : reply(502, { error: 'the factory answered another shape' })
    }
    // Its reason can name a path: the door says only that the alert was refused.
    if (filed.status === 422) return reply(422, { error: 'the alert was refused' })
    return reply(filed.status >= 500 ? 503 : 502, { error: 'the factory did not take the alert' })
  }

  return async (req) => {
    const started = performance.now()
    const match = ROUTE.exec(new URL(req.url).pathname)
    const source = match?.[1]
    let label = '-'
    let response: Response
    try {
      if (!source) response = reply(404)
      else if (req.method !== 'POST') response = reply(405, undefined, { allow: 'POST' })
      else if (!authorized(req, own(options.tokens, source))) {
        response = reply(401, undefined, { 'www-authenticate': 'Bearer' })
        if (req.headers.get(PROBE_HEADER) === '1') label = `probe ${source}`
        else {
          label = `refused ${source}`
          if (own(options.tokens, source) !== undefined) report({ kind: 'refused', source })
        }
      } else {
        label = source
        response = await handle(req, source)
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

/** Reports to the server over its unix socket. */
export function reportViaSocket(socket: string): NonNullable<DoorOptions['report']> {
  return async (report) => {
    const response = await fetch('http://localhost/intake/report', {
      unix: socket,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`report answered ${response.status}`)
  }
}

/** Files an alert over the server's unix socket: the door's only way to the factory. */
export function fileViaSocket(socket: string): DoorOptions['file'] {
  return async (input) => {
    const response = await fetch('http://localhost/intake', {
      unix: socket,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(10_000),
    })
    const body: unknown = await response.json().catch(() => null)
    return { status: response.status, body }
  }
}
