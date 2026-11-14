import { stat } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { ErrorBody } from '@software-factory/contract'
import { compressResponse } from './compress.ts'

export interface ConsoleHandlerOptions {
  /** the Console build */
  dir: string
  /** answers `/health`, `/v1/*` and the ten answer verbs (`WRITES`) from the API; the caller decides what credentials it carries */
  forward: (request: Request) => Promise<Response>
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

/**
 * The policy of the artifact frame (`/frame.html` and `/frame/*`, the one document the page frames). A srcdoc, blob or
 * data frame would inherit the page's policy; a frame loaded from a URL has its own, so the artifact's inline script runs
 * while no request leaves the frame, and the page keeps `script-src 'self'`. Sandboxed even when opened on its own.
 */
const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-scripts',
].join('; ')

const isFrame = (path: string): boolean => path === '/frame.html' || path.startsWith('/frame/')

/** Types Bun gets wrong or does not know for a Console build. */
const TYPES: Record<string, string> = {
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json',
  '.map': 'application/json',
}

const NO_CACHE = /^(index\.html|frame\.html|sw\.js|registerSW\.js|manifest\.webmanifest|workbox-.*\.js)$/

const errorResponse = (status: number, error: string, code: string, headers?: Record<string, string>): Response =>
  Response.json(ErrorBody.parse({ error, code }), { status, headers })

const isFile = async (path: string): Promise<boolean> => (await stat(path).catch(() => null))?.isFile() ?? false

/**
 * The `forward` of the Console listener: a fresh request to the same path and query on the API, carrying the owner's token
 * and none of the client's credentials (`authorization`, `cookie`, every `tailscale-*` header), and the body of a write
 * verbatim. The client's signal rides along, so a stream is cancelled when the client leaves.
 */
export function apiForward(options: {
  handle: (request: Request) => Promise<Response>
  origin: string
  ownerToken: string
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const headers = new Headers(request.headers)
    for (const name of [...headers.keys()]) {
      if (name === 'authorization' || name === 'cookie' || name.startsWith('tailscale-')) headers.delete(name)
    }
    headers.set('authorization', `Bearer ${options.ownerToken}`)
    const url = new URL(request.url)
    return options.handle(
      new Request(`${options.origin}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
        signal: request.signal,
      }),
    )
  }
}

const forwarded = (path: string): boolean => path === '/health' || path === '/v1' || path.startsWith('/v1/')

/** The owner's ten answer verbs: the only writes the listener forwards. None starts a session or cancels or reopens an Issue; promote files one only from a held signal, dismiss files nothing. */
const WRITES: { method: string; path: RegExp }[] = [
  { method: 'POST', path: /^\/v1\/decisions\/[^/]+\/answer$/ },
  { method: 'POST', path: /^\/v1\/artifacts\/[^/]+\/verdict$/ },
  { method: 'POST', path: /^\/v1\/artifacts\/[^/]+\/needed$/ },
  { method: 'POST', path: /^\/v1\/artifacts\/[^/]+\/annotations$/ },
  { method: 'PATCH', path: /^\/v1\/artifacts\/[^/]+\/annotations\/[^/]+$/ },
  { method: 'DELETE', path: /^\/v1\/artifacts\/[^/]+\/annotations\/[^/]+$/ },
  { method: 'POST', path: /^\/v1\/errands\/[^/]+\/done$/ },
  { method: 'POST', path: /^\/v1\/errands\/[^/]+\/turn-back$/ },
  { method: 'POST', path: /^\/signals\/[^/]+\/promote$/ },
  { method: 'POST', path: /^\/signals\/[^/]+\/dismiss$/ },
]

const isWrite = (request: Request, path: string): boolean =>
  WRITES.some((route) => route.method === request.method && route.path.test(path))

const MAX_BODY = 64 * 1024

/** The body, or null when it is over the cap (counted as it arrives, whatever `content-length` claims). */
async function boundedBody(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY) return null
  const chunks: Uint8Array[] = []
  let size = 0
  if (request.body) {
    for await (const chunk of request.body) {
      size += chunk.byteLength
      if (size > MAX_BODY) return null
      chunks.push(chunk)
    }
  }
  const body = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    body.set(chunk, at)
    at += chunk.byteLength
  }
  return body
}

/**
 * The listener has no per-request identity, so a page on another site could make the browser send a write: a write must
 * come from the Console itself (a JSON body no form can send, and no cross-site fetch metadata).
 */
function crossSite(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site')
  if (site !== null && site !== 'same-origin') return true
  const origin = request.headers.get('origin')
  if (origin === null) return false
  try {
    return new URL(origin).host !== request.headers.get('host')
  } catch {
    return true
  }
}

/** The file a request path names inside `dir`, or null when it names nothing inside it. */
function fileOf(dir: string, rawPath: string): string | null {
  if (/%2f|%5c/i.test(rawPath)) return null
  let path: string
  try {
    path = decodeURIComponent(rawPath)
  } catch {
    return null
  }
  if (path.includes('\0') || path.includes('\\')) return null
  if (path.split('/').includes('..')) return null
  const root = resolve(dir)
  const file = resolve(join(root, path))
  return file === root || file.startsWith(root + sep) ? file : null
}

/**
 * The Console listener's handler. No per-request identity: the perimeter is the tailnet ACL. Gates in a fixed order, for
 * every path: a read method (or one of the ten answer verbs, `WRITES`, which also need a same-origin JSON body of at most 64 KiB), then either the API's slice
 * (`/health`, `/v1/*`, the verbs) or a static file. Nothing else that writes or starts a session passes. A text answer to a GET is
 * compressed (br or gzip, whatever the client accepts), a static file once; the event stream is never touched.
 */
export function consoleHandler(options: ConsoleHandlerOptions): (request: Request) => Promise<Response> {
  const indexFile = join(resolve(options.dir), 'index.html')

  /** An API answer is never cached by the browser or a proxy; the stream keeps the cache-control it sets. */
  const forward = async (request: Request): Promise<Response> => {
    const response = await options.forward(request)
    if (response.headers.has('cache-control')) return response
    const headers = new Headers(response.headers)
    headers.set('cache-control', 'no-store')
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }

  const staticResponse = async (request: Request, rawPath: string): Promise<Response> => {
    if (!(await isFile(indexFile))) return errorResponse(503, 'the Console is not built', 'unavailable')
    const file = fileOf(options.dir, rawPath)
    if (!file) return errorResponse(404, 'not found', 'not_found')
    let served = file
    if (!(await isFile(file))) {
      // A route of the app (no extension) is the app's; a missing asset is missing.
      if (extname(basename(rawPath)) !== '') return errorResponse(404, 'not found', 'not_found')
      served = indexFile
    }
    const name = basename(served)
    const type = TYPES[extname(name)] ?? Bun.file(served).type
    const headers = new Headers({
      'content-type': type,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    })
    if (isFrame(rawPath)) headers.set('content-security-policy', FRAME_CSP)
    else if (name.endsWith('.html')) headers.set('content-security-policy', CSP)
    if (NO_CACHE.test(name)) headers.set('cache-control', 'no-cache')
    else if (rawPath.startsWith('/assets/')) headers.set('cache-control', 'public, max-age=31536000, immutable')
    if (request.method === 'HEAD') {
      headers.set('content-length', String(Bun.file(served).size))
      return new Response(null, { headers })
    }
    const bun = Bun.file(served)
    return compressResponse(request, new Response(bun, { headers }), {
      file: served,
      size: bun.size,
      modified: bun.lastModified,
    })
  }

  /** One of the ten answer verbs: a same-origin JSON body of at most 64 KiB (a DELETE has none), forwarded verbatim. */
  const write = async (request: Request): Promise<Response> => {
    const json = (request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')
    if (request.method !== 'DELETE' && !json) {
      return errorResponse(415, 'a write sends application/json', 'unsupported_media_type')
    }
    if (crossSite(request)) return errorResponse(403, 'a write comes from the Console itself', 'forbidden')
    const body = await boundedBody(request)
    if (body === null) return errorResponse(413, 'the body is over 64 KiB', 'payload_too_large')
    return forward(
      new Request(request.url, { method: request.method, headers: request.headers, body, signal: request.signal }),
    )
  }

  return async (request) => {
    const rawPath = new URL(request.url).pathname
    if (isWrite(request, rawPath)) return write(request)
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return errorResponse(405, 'the Console listener reads, and takes ten answers', 'method_not_allowed', {
        allow: 'GET, HEAD',
      })
    }
    if (forwarded(rawPath)) return compressResponse(request, await forward(request))
    return staticResponse(request, rawPath)
  }
}
