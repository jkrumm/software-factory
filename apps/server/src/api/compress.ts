import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'

const brotli = promisify(brotliCompress)
const deflate = promisify(gzip)

type Encoding = 'br' | 'gzip'

const MIN_BYTES = 1024
const COMPRESSIBLE = /^text\/(?!event-stream)|javascript|json|svg\+xml|webmanifest/i

/** A static file whose compressed bytes are kept: compressed once per file version, not per request. */
export interface StaticSource {
  file: string
  size: number
  /** the file's mtime in ms */
  modified: number
}

const staticCache = new Map<string, { stamp: string; bytes: Uint8Array }>()

/** `br` if the client lists it, else `gzip`, else null; a coding with `q=0` is refused. */
function accepted(header: string | null): Encoding | null {
  if (!header) return null
  const offered = new Set<string>()
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    if (!name) continue
    const q = params.map((param) => /^\s*q\s*=\s*([\d.]+)\s*$/.exec(param)?.[1]).find((value) => value !== undefined)
    if (q !== undefined && !(Number(q) > 0)) continue
    offered.add(name.trim())
  }
  if (offered.has('br')) return 'br'
  return offered.has('gzip') ? 'gzip' : null
}

const run = (encoding: Encoding, body: Uint8Array, quality: { br: number; gzip: number }): Promise<Uint8Array> =>
  encoding === 'br'
    ? brotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: quality.br } })
    : deflate(body, { level: quality.gzip })

/**
 * Compresses a text response when the client accepts it. Only a 200 answer to a GET with a body of at least 1 KiB, no
 * content-encoding yet and a text type is touched (never `text/event-stream`: a stream passes through unbuffered). A response
 * that could have been compressed always carries `vary: accept-encoding`. A static file is compressed once (brotli 9); a
 * dynamic body is compressed per request, cheaply.
 */
export async function compressResponse(request: Request, response: Response, source?: StaticSource): Promise<Response> {
  if (request.method !== 'GET' || response.status !== 200 || !response.body) return response
  if (response.headers.has('content-encoding')) return response
  if (!COMPRESSIBLE.test(response.headers.get('content-type') ?? '')) return response

  const headers = new Headers(response.headers)
  headers.append('vary', 'accept-encoding')
  const encoding = accepted(request.headers.get('accept-encoding'))
  if (!encoding || (source && source.size < MIN_BYTES)) {
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }

  let original: Uint8Array | null = null
  if (!source) {
    original = new Uint8Array(await response.arrayBuffer())
    if (original.byteLength < MIN_BYTES) {
      return new Response(original, { status: response.status, statusText: response.statusText, headers })
    }
  }

  let bytes: Uint8Array
  if (source) {
    const key = `${source.file}|${encoding}`
    const stamp = `${source.size}|${source.modified}`
    const hit = staticCache.get(key)
    if (hit?.stamp === stamp) bytes = hit.bytes
    else {
      bytes = await run(encoding, new Uint8Array(await response.arrayBuffer()), { br: 9, gzip: 9 })
      staticCache.set(key, { stamp, bytes })
    }
  } else {
    bytes = await run(encoding, original as Uint8Array, { br: 4, gzip: 6 })
  }

  headers.set('content-encoding', encoding)
  headers.set('content-length', String(bytes.byteLength))
  return new Response(bytes, { status: response.status, statusText: response.statusText, headers })
}
