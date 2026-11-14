/** What one call to the server came back with, before any schema has looked at it. */
export type Answer =
  | { reached: true; status: number; json: unknown; text: string }
  /** `nothingSent`: the connection was refused, so no byte of the request reached any server and a retry cannot run it twice */
  | { reached: false; reason: string; nothingSent: boolean }

export interface Call {
  /** the server's base URL, e.g. `http://127.0.0.1:7793` */
  base: string
  method: string
  /** the path with its parameters filled in */
  path: string
  query?: Record<string, string>
  /** sent as JSON */
  body?: unknown
  /** sent as `Authorization: Bearer <token>`; none, nothing is sent and the server answers 401 */
  token?: string
  timeoutMs?: number
}

const TIMEOUT_MS = 10_000

/**
 * Bun's fetch reports a closed port as `code: 'ConnectionRefused'` (Node's as `ECONNREFUSED`, possibly on `cause`), a
 * socket that closed after it was connected as `ECONNRESET` (a reset and a close without an answer look the same, and
 * either may come after the request was read), a deadline as a `TimeoutError`. Only the refused connection proves that
 * nothing was sent.
 */
function refused(error: unknown): boolean {
  const code = (value: unknown): unknown => (value as { code?: unknown } | null)?.code
  return [code(error), code((error as { cause?: unknown } | null)?.cause)].some(
    (c) => c === 'ConnectionRefused' || c === 'ECONNREFUSED',
  )
}

/**
 * The CLI's transport: one HTTP call, JSON decoded when it is JSON. It never throws for the network or the status;
 * the caller decides what each answer means (the CLI maps them to its exit codes).
 */
export async function send(call: Call): Promise<Answer> {
  const url = new URL(`${call.base.replace(/\/+$/, '')}${call.path}`)
  for (const [key, value] of Object.entries(call.query ?? {})) url.searchParams.set(key, value)
  const hasBody = call.body !== undefined
  let response: Response
  let text: string
  try {
    response = await fetch(url, {
      method: call.method,
      headers: {
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        ...(call.token ? { authorization: `Bearer ${call.token}` } : {}),
      },
      body: hasBody ? JSON.stringify(call.body) : undefined,
      signal: AbortSignal.timeout(call.timeoutMs ?? TIMEOUT_MS),
    })
    text = await response.text()
  } catch (error) {
    return {
      reached: false,
      reason: error instanceof Error ? error.message : String(error),
      nothingSent: refused(error),
    }
  }
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // Not JSON: the caller's schema refuses it and the text says what came instead.
  }
  return { reached: true, status: response.status, json, text }
}

/** Waits out a restart: how long, and how the waiting shows. Every function and the clock can be replaced by a test. */
export interface Patience {
  /** how long a call keeps trying, in ms from its first attempt; asked again before every wait, so it can grow (a deploy began) */
  limitMs: () => number
  /** called once, before the first wait */
  onWait?: () => void
  /** the pause before the second attempt and its cap: it doubles in between */
  backoff?: { firstMs: number; maxMs: number }
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export const BACKOFF = { firstMs: 500, maxMs: 5_000 }

const READS: ReadonlySet<string> = new Set(['GET', 'HEAD'])

/**
 * `send`, retried while the server is away. A refused connection is retried for every method (nothing reached the
 * server); any other failure to reach it, a timeout included, only for a read, because a write may have been applied
 * before the answer was lost. The last answer comes back once the limit is spent; a server that answered, whatever the
 * status, is never retried.
 */
export async function sendPatient(call: Call, patience: Patience): Promise<Answer> {
  const now = patience.now ?? Date.now
  const sleep = patience.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const backoff = patience.backoff ?? BACKOFF
  const started = now()
  let pause = backoff.firstMs
  let waited = false
  for (;;) {
    const answer = await send(call)
    if (answer.reached) return answer
    const retriable = answer.nothingSent || READS.has(call.method.toUpperCase())
    if (!retriable || now() - started + pause > patience.limitMs()) return answer
    if (!waited) patience.onWait?.()
    waited = true
    await sleep(pause)
    pause = Math.min(pause * 2, backoff.maxMs)
  }
}
