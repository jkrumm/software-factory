import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { apiForward, consoleHandler } from '../src/api/console.ts'
import { loadConsoleSettings } from '../src/console-settings.ts'

const INDEX = '<!doctype html><title>console</title>'
const BIG_JS = `export const rows = ${JSON.stringify(Array.from({ length: 200 }, (_, i) => `row number ${i}`))}\n`
const BIG_JSON = JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => `row number ${i}`) })

let dir = ''
let forwarded: Request[] = []
let handle: (request: Request) => Promise<Response>

const call = (path: string, init: RequestInit = {}): Promise<Response> =>
  handle(new Request(`http://console.test${path}`, init))

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-console-')
  await mkdir(join(dir, 'build', 'assets'), { recursive: true })
  await writeFile(join(dir, 'build', 'index.html'), INDEX)
  await mkdir(join(dir, 'build', 'frame'), { recursive: true })
  await writeFile(join(dir, 'build', 'frame.html'), '<!doctype html><title>frame</title>')
  await writeFile(join(dir, 'build', 'frame', 'frame.js'), '/* frame */')
  await writeFile(join(dir, 'build', 'sw.js'), 'self.skipWaiting()')
  await writeFile(join(dir, 'build', 'manifest.webmanifest'), '{}')
  await writeFile(join(dir, 'build', 'assets', 'app.js'), 'export {}')
  await writeFile(join(dir, 'build', 'assets', 'font.woff2'), 'x')
  await writeFile(join(dir, 'build', 'assets', 'big.js'), BIG_JS)
  await writeFile(join(dir, 'secret.txt'), 'outside the build')
  handle = consoleHandler({
    dir: join(dir, 'build'),
    forward: async (request) => {
      forwarded.push(request)
      const path = new URL(request.url).pathname
      if (path === '/v1/big') return Response.json(JSON.parse(BIG_JSON))
      if (path === '/v1/stream-big') {
        return new Response(`event: hello\ndata: ${'x'.repeat(2000)}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return new Response('api', { status: 200 })
    },
  })
})

afterAll(() => rm(dir, { recursive: true, force: true }))

describe('the listener', () => {
  test('GET / serves index.html with the CSP and the safe headers', async () => {
    const response = await call('/')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(INDEX)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  })

  test('the artifact frame has its own policy, and the page does not get it', async () => {
    const page = (await call('/')).headers.get('content-security-policy') ?? ''
    expect(page).toContain("script-src 'self';")
    expect(page).toContain("frame-src 'self'")
    expect(page).not.toContain("script-src 'self' 'unsafe-inline'")
    expect(page).not.toContain('sandbox')

    for (const path of ['/frame.html', '/frame/frame.js']) {
      const response = await call(path)
      expect(response.status).toBe(200)
      const frame = response.headers.get('content-security-policy') ?? ''
      expect(frame).toContain("default-src 'none'")
      expect(frame).toContain("script-src 'self' 'unsafe-inline'")
      expect(frame).toContain("connect-src 'none'")
      expect(frame).toContain("frame-src 'none'")
      expect(frame).toContain("form-action 'none'")
      expect(frame).toContain("base-uri 'none'")
      expect(frame).toContain('img-src data:')
      expect(frame).toContain('sandbox allow-scripts')
      expect(frame).not.toContain("default-src 'self'")
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    }
    expect((await call('/frame.html')).headers.get('cache-control')).toBe('no-cache')
    expect((await call('/index.html')).headers.get('content-security-policy')).toBe(page)
  })

  test('an extension-less unknown path falls back to index.html', async () => {
    const response = await call('/issues/42')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(INDEX)
  })

  test('an unknown file with an extension is 404', async () => {
    expect((await call('/assets/missing.js')).status).toBe(404)
    expect((await call('/nope.js')).status).toBe(404)
  })

  test('assets are immutable, the service worker and manifest are not cached, types are right', async () => {
    const asset = await call('/assets/app.js')
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(asset.headers.get('content-type')).toContain('javascript')
    expect(asset.headers.get('content-security-policy')).toBeNull()
    expect((await call('/assets/font.woff2')).headers.get('content-type')).toBe('font/woff2')
    expect((await call('/sw.js')).headers.get('cache-control')).toBe('no-cache')
    const manifest = await call('/manifest.webmanifest')
    expect(manifest.headers.get('cache-control')).toBe('no-cache')
    expect(manifest.headers.get('content-type')).toBe('application/manifest+json')
  })

  test('HEAD answers the headers without a body', async () => {
    const response = await call('/', { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
  })

  test('a path that leaves the build is 404', async () => {
    for (const path of [
      '/..%2fsecret.txt',
      '/%2e%2e%2fsecret.txt',
      '/assets%2f..%2f..%2fsecret.txt',
      '/%2e%2e/secret.txt',
      '/..%5csecret.txt',
      '/a%00b.js',
      '/%zz',
    ]) {
      const response = await call(path)
      expect([path, response.status]).toEqual([path, 404])
      expect(await response.text()).not.toContain('outside the build')
    }
  })

  test('serves without any identity header', async () => {
    expect((await call('/')).status).toBe(200)
    expect((await call('/health')).status).toBe(200)
  })

  test('every write method is 405, whatever the path', async () => {
    forwarded = []
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      for (const path of ['/v1/issues', '/signals', '/slots/x', '/']) {
        const response = await call(path, { method })
        expect([method, path, response.status]).toEqual([method, path, 405])
      }
    }
    expect(forwarded).toEqual([])
  })

  test('/health and /v1/* are forwarded; the client credentials are the forward closure’s business', async () => {
    forwarded = []
    const response = await call('/v1/stream?since=3', { headers: { authorization: 'Bearer client-token' } })
    expect(await response.text()).toBe('api')
    expect(forwarded).toHaveLength(1)
    expect(new URL(forwarded[0]?.url ?? '').pathname + new URL(forwarded[0]?.url ?? '').search).toBe(
      '/v1/stream?since=3',
    )
    expect((await call('/health')).status).toBe(200)
    expect(forwarded).toHaveLength(2)
  })

  test('the forward receives the request’s abort signal', async () => {
    const aborted = new AbortController()
    forwarded = []
    await call('/v1/stream', { signal: aborted.signal })
    const seen = forwarded[0]?.signal
    expect(seen?.aborted).toBe(false)
    aborted.abort()
    expect(seen?.aborted).toBe(true)
  })

  test('nothing outside /health and /v1 is forwarded', async () => {
    forwarded = []
    expect((await call('/signals')).status).toBe(200) // the SPA fallback
    expect((await call('/issues/1/ship')).status).toBe(200)
    expect((await call('/openapi/json')).status).toBe(200) // an extension-less path is the app's
    expect((await call('/v10/needs')).status).toBe(200)
    expect((await call('/healthz.json')).status).toBe(404)
    expect(forwarded).toEqual([])
  })

  test('a build that is not there is 503', async () => {
    const missing = consoleHandler({ dir: join(dir, 'nope'), forward: async () => new Response() })
    const response = await missing(new Request('http://console.test/'))
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: 'the Console is not built' })
  })
})

describe('compression', () => {
  const asset = (encoding?: string, init: RequestInit = {}) =>
    call('/assets/big.js', { ...init, headers: encoding ? { 'accept-encoding': encoding } : {} })

  test('brotli and gzip round-trip a static asset, and keep its headers', async () => {
    const br = await asset('gzip, deflate, br')
    expect(br.headers.get('content-encoding')).toBe('br')
    expect(br.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(br.headers.get('x-content-type-options')).toBe('nosniff')
    const brBytes = new Uint8Array(await br.arrayBuffer())
    expect(brBytes.byteLength).toBeLessThan(BIG_JS.length)
    expect(br.headers.get('content-length')).toBe(String(brBytes.byteLength))
    expect(brotliDecompressSync(brBytes).toString()).toBe(BIG_JS)

    const gz = await asset('gzip;q=0.8')
    expect(gz.headers.get('content-encoding')).toBe('gzip')
    expect(gunzipSync(new Uint8Array(await gz.arrayBuffer())).toString()).toBe(BIG_JS)

    // the second answer comes from the cache and is the same bytes
    expect(new Uint8Array(await (await asset('br')).arrayBuffer())).toEqual(brBytes)
  })

  test('nothing without a usable accept-encoding, and vary says so', async () => {
    for (const encoding of [undefined, 'identity', 'br;q=0, gzip;q=0']) {
      const response = await asset(encoding)
      expect(response.headers.get('content-encoding')).toBeNull()
      expect(response.headers.get('vary')).toContain('accept-encoding')
      expect(await response.text()).toBe(BIG_JS)
    }
    const gz = await asset('br;q=0, gzip')
    expect(gz.headers.get('content-encoding')).toBe('gzip')
    expect(gz.headers.get('vary')).toContain('accept-encoding')
  })

  test('HEAD is untouched', async () => {
    const response = await asset('br, gzip', { method: 'HEAD' })
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(BIG_JS)))
  })

  test('a body under 1 KiB is untouched', async () => {
    const small = await call('/assets/app.js', { headers: { 'accept-encoding': 'br, gzip' } })
    expect(small.headers.get('content-encoding')).toBeNull()
    expect(await small.text()).toBe('export {}')
    const api = await call('/health', { headers: { 'accept-encoding': 'gzip' } })
    expect(api.headers.get('content-encoding')).toBeNull()
    expect(await api.text()).toBe('api')
  })

  test('a forwarded JSON body over 1 KiB is gzipped', async () => {
    const response = await call('/v1/big', { headers: { 'accept-encoding': 'gzip' } })
    expect(response.headers.get('content-encoding')).toBe('gzip')
    expect(response.headers.get('vary')).toContain('accept-encoding')
    expect(gunzipSync(new Uint8Array(await response.arrayBuffer())).toString()).toBe(BIG_JSON)
  })

  test('an event stream passes through untouched', async () => {
    const response = await call('/v1/stream-big', { headers: { 'accept-encoding': 'br, gzip' } })
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('vary')).toBeNull()
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(await response.text()).toContain('event: hello')
  })
})

describe('the API forward', () => {
  test('drops the client credentials, sets the owner token, keeps path, query and signal', async () => {
    let seen: Request | undefined
    const forward = apiForward({
      handle: async (request) => {
        seen = request
        return new Response('ok')
      },
      origin: 'http://127.0.0.1:1',
      ownerToken: 'owner-token',
    })
    const client = new AbortController()
    await forward(
      new Request('http://console.test/v1/stream?since=3', {
        headers: {
          authorization: 'Bearer client-token',
          cookie: 'a=b',
          'tailscale-user-login': 'someone@example.com',
          'tailscale-user-name': 'Owner',
          accept: 'text/event-stream',
        },
        signal: client.signal,
      }),
    )
    expect(seen?.url).toBe('http://127.0.0.1:1/v1/stream?since=3')
    expect(seen?.headers.get('authorization')).toBe('Bearer owner-token')
    expect(seen?.headers.get('cookie')).toBeNull()
    expect([...(seen?.headers.keys() ?? [])].filter((name) => name.startsWith('tailscale-'))).toEqual([])
    expect(seen?.headers.get('accept')).toBe('text/event-stream')
    expect(seen?.signal.aborted).toBe(false)
    client.abort()
    expect(seen?.signal.aborted).toBe(true)
  })
})

describe('console settings', () => {
  test('the port defaults to 7795 and the dir to apps/console/dist', () => {
    const settings = loadConsoleSettings({})
    expect(settings.port).toBe(7795)
    expect(settings.dir).toMatch(/apps\/console\/dist$/)
  })

  test('the two keys are read', () => {
    expect(loadConsoleSettings({ FACTORY_CONSOLE_PORT: '9000', FACTORY_CONSOLE_DIR: '/tmp/x' })).toEqual({
      port: 9000,
      dir: '/tmp/x',
    })
  })

  test('a bad port refuses', () => {
    expect(() => loadConsoleSettings({ FACTORY_CONSOLE_PORT: 'abc' })).toThrow(/FACTORY_CONSOLE_PORT/)
  })
})
