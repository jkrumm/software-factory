import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { HookEventBody, StopCheckBody, type HookEventAnswer, type StopCheck } from '@software-factory/contract'
import type { PortError, Result } from '../../kernel/result.ts'

/** What the hook socket does for the two calls a session's hooks make. */
export interface HookHandlers {
  event(body: HookEventBody): Promise<Result<HookEventAnswer, PortError>>
  stopCheck(session: string, body: StopCheckBody): Promise<Result<StopCheck, PortError>>
}

export interface SocketListener {
  path: string
  stop(): Promise<void>
}

/** No hook line is anywhere near this: a body larger than it is refused unread. */
const MAX_BODY_BYTES = 64 * 1024

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const failure = (status: number, error: string, code: string): Response => json(status, { error, code })

/** Whether something answers on the unix socket at `path`. */
async function answers(path: string): Promise<boolean> {
  try {
    const socket = await Bun.connect({ unix: path, socket: { data() {}, open() {}, close() {}, error() {} } })
    socket.end()
    return true
  } catch {
    return false
  }
}

/**
 * The hook socket: a plain `Bun.serve` unix listener, mode 0600, the hook's credential (hooks carry no token). It serves
 * `POST /events` and `POST /sessions/:id/stop-check` and nothing else. A socket file nothing answers on is a leftover and
 * is replaced; one that answers belongs to another running server and is never taken over.
 */
export async function listenOnSocket(path: string, handlers: HookHandlers): Promise<SocketListener> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (existsSync(path)) {
    if (await answers(path)) throw new Error(`another process answers on the hook socket ${path}; not taking it over`)
    unlinkSync(path)
  }
  // Bound under umask 0177 so the socket is never visible with a wider mode, and set again after in case it was.
  const previous = process.umask(0o177)
  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      unix: path,
      async fetch(request) {
        const url = new URL(request.url)
        if (request.method !== 'POST') return failure(404, 'no such route', 'not_found')
        const length = Number(request.headers.get('content-length') ?? 0)
        if (length > MAX_BODY_BYTES) return failure(413, 'the body is too large', 'invalid_request')
        let raw: unknown
        try {
          raw = await request.json()
        } catch {
          return failure(400, 'the body is not valid JSON', 'unparseable')
        }
        if (url.pathname === '/events') {
          const body = HookEventBody.safeParse(raw)
          if (!body.success) return failure(400, 'the body does not match the contract', 'invalid_request')
          const result = await handlers.event(body.data)
          return result.ok ? json(200, result.value) : failure(503, result.error.detail, 'unavailable')
        }
        const stop = /^\/sessions\/([^/]+)\/stop-check$/.exec(url.pathname)
        if (stop?.[1]) {
          const body = StopCheckBody.safeParse(raw)
          if (!body.success) return failure(400, 'the body does not match the contract', 'invalid_request')
          const result = await handlers.stopCheck(decodeURIComponent(stop[1]), body.data)
          return result.ok ? json(200, result.value) : failure(503, result.error.detail, 'unavailable')
        }
        return failure(404, 'no such route', 'not_found')
      },
      error(error) {
        console.error(`hook socket: ${error.message}`)
        return failure(500, 'internal error', 'internal')
      },
    })
  } finally {
    process.umask(previous)
  }
  chmodSync(path, 0o600)
  return {
    path,
    stop: async () => {
      await server.stop(true)
      try {
        unlinkSync(path)
      } catch {
        // already gone
      }
    },
  }
}
