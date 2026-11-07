/** One server-sent event: `id:`, `event:` (`message` when absent) and the `data:` lines joined by newlines. */
export interface SseEvent {
  id: string | null
  event: string
  data: string
}

export interface StreamCall {
  /** the server's base URL, e.g. `http://127.0.0.1:7793` */
  base: string
  /** the path, without a query: `/v1/stream` */
  path: string
  /** sent as `Authorization: Bearer <token>` */
  token?: string
  /** the cursor to resume after: sent as `?since=` and as `Last-Event-ID` */
  since?: string
  /** more query parameters, e.g. `{ issue: 'issue_12' }` */
  query?: Record<string, string>
  /** ends the stream: the iterable then finishes without an error */
  signal?: AbortSignal
}

/**
 * Why a stream did not deliver: `unreachable` (the connection could not be made), `refused` (a non-2xx answer; `status`
 * and `body` hold it) or `dropped` (it was open and broke). A stream the server closes cleanly just ends.
 */
export class StreamError extends Error {
  constructor(
    readonly reason: 'unreachable' | 'refused' | 'dropped',
    message: string,
    readonly status: number | null = null,
    readonly body: unknown = null,
  ) {
    super(message)
    this.name = 'StreamError'
  }
}

/** The event a block of lines holds, or nothing for a block of comments (keepalives) or one without data. */
function parseBlock(block: string): SseEvent | null {
  let event = 'message'
  let id: string | null = null
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'id') id = value
    else if (field === 'data') data.push(value)
  }
  return data.length ? { id, event, data: data.join('\n') } : null
}

const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Opens an event stream and yields its events as they arrive; comment lines are ignored. Throws a `StreamError` for a
 * connection that cannot be made, a refusal and a break; ends quietly when the server closes it or `signal` aborts.
 */
export async function* streamEvents(call: StreamCall): AsyncGenerator<SseEvent> {
  const url = new URL(`${call.base.replace(/\/+$/, '')}${call.path}`)
  for (const [key, value] of Object.entries(call.query ?? {})) url.searchParams.set(key, value)
  if (call.since !== undefined) url.searchParams.set('since', call.since)
  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        accept: 'text/event-stream',
        ...(call.token ? { authorization: `Bearer ${call.token}` } : {}),
        ...(call.since !== undefined ? { 'last-event-id': call.since } : {}),
      },
      signal: call.signal,
    })
  } catch (error) {
    if (call.signal?.aborted) return
    throw new StreamError('unreachable', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new StreamError('refused', `HTTP ${response.status}`, response.status, jsonOf(text))
  }
  if (!response.body) return
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n')
      for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
        const event = parseBlock(buffer.slice(0, end))
        buffer = buffer.slice(end + 2)
        if (event) yield event
      }
    }
  } catch (error) {
    if (call.signal?.aborted) return
    throw new StreamError('dropped', error instanceof Error ? error.message : String(error))
  }
}
