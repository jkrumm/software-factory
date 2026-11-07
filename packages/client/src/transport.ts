/** What one call to the server came back with, before any schema has looked at it. */
export type Answer = { reached: true; status: number; json: unknown; text: string } | { reached: false; reason: string }

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
    return { reached: false, reason: error instanceof Error ? error.message : String(error) }
  }
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // Not JSON: the caller's schema refuses it and the text says what came instead.
  }
  return { reached: true, status: response.status, json, text }
}
