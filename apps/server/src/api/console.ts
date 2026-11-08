import { createHash, timingSafeEqual } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { ErrorBody } from '@software-factory/contract'

export interface ConsoleHandlerOptions {
  /** the owner's tailnet login: the only caller the listener answers */
  ownerLogin: string
  /** the Console build */
  dir: string
  /** answers `/health` and `/v1/*` from the API; the caller decides what credentials it carries */
  forward: (request: Request) => Promise<Response>
}

const LOGIN_HEADER = 'tailscale-user-login'

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

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

const NO_CACHE = /^(index\.html|sw\.js|registerSW\.js|manifest\.webmanifest|workbox-.*\.js)$/

const digest = (text: string): Buffer => createHash('sha256').update(text.toLowerCase()).digest()

const errorResponse = (status: number, error: string, code: string, headers?: Record<string, string>): Response =>
  Response.json(ErrorBody.parse({ error, code }), { status, headers })

const isFile = async (path: string): Promise<boolean> => (await stat(path).catch(() => null))?.isFile() ?? false

/**
 * The `forward` of the Console listener: a fresh request to the same path and query on the API, carrying the owner's token
 * and none of the client's credentials (`authorization`, `cookie`, every `tailscale-*` header). The client's signal rides
 * along, so a stream is cancelled when the client leaves.
 */
export function apiForward(options: {
  handle: (request: Request) => Promise<Response>
  origin: string
  ownerToken: string
}): (request: Request) => Promise<Response> {
  return (request) => {
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
        signal: request.signal,
      }),
    )
  }
}

const forwarded = (path: string): boolean => path === '/health' || path === '/v1' || path.startsWith('/v1/')

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
 * The Console listener's handler. Three gates in a fixed order, for every path: the owner's login, a read method, then
 * either the API's read slice (`/health`, `/v1/*`) or a static file. Nothing that can write or start a session passes.
 */
export function consoleHandler(options: ConsoleHandlerOptions): (request: Request) => Promise<Response> {
  const owner = digest(options.ownerLogin)
  const indexFile = join(resolve(options.dir), 'index.html')

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
    if (name.endsWith('.html')) headers.set('content-security-policy', CSP)
    if (NO_CACHE.test(name)) headers.set('cache-control', 'no-cache')
    else if (rawPath.startsWith('/assets/')) headers.set('cache-control', 'public, max-age=31536000, immutable')
    if (request.method === 'HEAD') {
      headers.set('content-length', String(Bun.file(served).size))
      return new Response(null, { headers })
    }
    return new Response(Bun.file(served), { headers })
  }

  return async (request) => {
    const login = request.headers.get(LOGIN_HEADER)
    if (login === null || !timingSafeEqual(digest(login), owner)) {
      return errorResponse(403, 'this listener answers its owner only', 'forbidden')
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return errorResponse(405, 'the Console listener only reads', 'method_not_allowed', { allow: 'GET, HEAD' })
    }
    const rawPath = new URL(request.url).pathname
    if (forwarded(rawPath)) return options.forward(request)
    return staticResponse(request, rawPath)
  }
}
