import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { DEFAULT_ROLES_FILE } from '@software-factory/contract'
import { loadConfig } from '../src/config.ts'
import { MAX_BODY_BYTES } from '../src/http.ts'
import { MAX_PAYLOAD_CHARS, MAX_PROMPT_CHARS } from '../src/schemas.ts'
import { startApp, TEST_REPO, TEST_TOKEN, type TestApp } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

let db: TestDb
let app: TestApp

beforeAll(async () => {
  db = await startTestDb()
  app = startApp({ sql: db.sql, clock: new FakeClock() })
})
beforeEach(() => db.reset())
afterAll(async () => {
  await app.stop()
  await db.stop()
})

describe('routing (finding 8)', () => {
  test.each([
    ['GET', '/events', 'POST'],
    ['DELETE', '/spawns/x', 'GET'],
    ['GET', '/quota/accounts/a', 'PUT'],
    ['GET', '/quota/refresh', 'POST'],
    ['POST', '/queue', 'GET, PUT'],
    ['PUT', '/spawns', 'GET, POST'],
    ['POST', '/health', 'GET'],
  ])('%s %s is 405 and names what is allowed', async (method, path, allow) => {
    const res = await app.request(method, path)
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe(allow)
    expect(await res.json()).toEqual({ error: 'method not allowed' })
  })

  test.each(['/nope', '/events/extra', '/spawns/a/b', '/'])('an unknown path %s is 404', async (path) => {
    expect((await app.get(path)).status).toBe(404)
  })

  test('a malformed percent-escape in a path never reaches a 500', async () => {
    for (const path of ['/sessions/%E0%A4%A', '/spawns/%', '/quota/accounts/%zz']) {
      const res = await app.get(path)
      expect(res.status).toBeLessThan(500)
    }
  })

  test('/health answers ok with the version and the tick record', async () => {
    const res = await app.get('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: 'ok',
      version: 'test',
      reason: null,
      tick: { lastSuccessAt: '2026-10-30T12:00:00.000Z', lastError: null },
    })
  })
})

describe('config (finding 5)', () => {
  const env = {
    DATABASE_URL: 'postgres://x',
    HERDR_BIN: 'herdr',
    PORT: '7793',
    FACTORY_TOKEN: 'a-token-of-16-chars',
    HOME: '/home/me',
  }

  test('reads the environment', () => {
    expect(loadConfig({ ...env, FACTORY_VERSION: 'abc' })).toEqual({
      databaseUrl: 'postgres://x',
      herdrBin: 'herdr',
      token: 'a-token-of-16-chars',
      port: 7793,
      version: 'abc',
      pretrustBin: '/home/me/SourceRoot/dotfiles/scripts/claude-pretrust.sh',
      accountsFile: '/home/me/SourceRoot/dotfiles/config/claude-accounts.json',
      claudeAccountBin: '/home/me/.local/bin/claude-account',
      rolesFile: DEFAULT_ROLES_FILE,
      retryBudgetMs: 30 * 60_000,
      repoRoots: ['/home/me/SourceRoot', '/home/me/IuRoot'],
      spoolDir: '/home/me/.local/share/factory/spool',
      hookSocket: '/home/me/.local/share/factory/hook.sock',
    })
    expect(loadConfig(env).version).toBe('dev')
    expect(loadConfig({ ...env, FACTORY_RETRY_BUDGET_MS: '90000' }).retryBudgetMs).toBe(90_000)
  })

  test('FACTORY_REPO_ROOTS replaces the default roots', () => {
    expect(loadConfig({ ...env, FACTORY_REPO_ROOTS: '/srv/a:/srv/b::' }).repoRoots).toEqual(['/srv/a', '/srv/b'])
  })

  test.each(['relative/path', '/srv/a:rel', ':'])('FACTORY_REPO_ROOTS %p is refused', (value) => {
    expect(() => loadConfig({ ...env, FACTORY_REPO_ROOTS: value })).toThrow(/FACTORY_REPO_ROOTS/)
  })

  test.each(['abc', '0', '5', '1.5'])('FACTORY_RETRY_BUDGET_MS %p is refused', (value) => {
    expect(() => loadConfig({ ...env, FACTORY_RETRY_BUDGET_MS: value })).toThrow(/FACTORY_RETRY_BUDGET_MS/)
  })

  test.each(['abc', '', '0', '65536', '80.5', '-1', 'NaN', ' '])('PORT %p is refused', (port) => {
    expect(() => loadConfig({ ...env, PORT: port })).toThrow(/PORT/)
  })

  test('a short token is refused', () => {
    expect(() => loadConfig({ ...env, FACTORY_TOKEN: 'short' })).toThrow(/FACTORY_TOKEN/)
  })

  test.each(['DATABASE_URL', 'HERDR_BIN', 'PORT', 'FACTORY_TOKEN'])('%s is required', (name) => {
    expect(() => loadConfig({ ...env, [name]: undefined })).toThrow(`${name} is not set`)
  })
})

const ROUTES: [string, string][] = [
  ['GET', '/spawns'],
  ['GET', '/spawns/x'],
  ['POST', '/spawns'],
  ['GET', '/sessions/x'],
  ['POST', '/events'],
  ['PUT', '/quota/accounts/a'],
  ['GET', '/quota'],
  ['POST', '/quota/refresh'],
  ['GET', '/queue'],
  ['PUT', '/queue'],
]
const SPAWN = JSON.stringify({ key: 'k', repo: TEST_REPO, prompt: 'p' })
const json = { 'content-type': 'application/json' }
const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

describe('authentication', () => {
  test.each(ROUTES)('%s %s without a token is 401', async (method, path) => {
    const res = await app.bare(path, { method, headers: json, body: method === 'GET' ? undefined : SPAWN })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
  })

  test.each([
    ['a wrong token', bearer('wrong-token-0123456789')],
    ['a token of another length', bearer('x')],
    ['another scheme', { authorization: `Basic ${TEST_TOKEN}` }],
    ['an empty bearer', { authorization: 'Bearer ' }],
  ])('%s is 401', async (_name, headers) => {
    expect((await app.bare('/spawns', { headers })).status).toBe(401)
  })

  test('the right token passes, and the scheme is case-insensitive', async () => {
    expect((await app.bare('/spawns', { headers: bearer(TEST_TOKEN) })).status).toBe(200)
    expect((await app.bare('/spawns', { headers: { authorization: `bearer ${TEST_TOKEN}` } })).status).toBe(200)
  })

  test('GET /health needs no token', async () => {
    expect((await app.bare('/health')).status).toBe(200)
  })

  test('nothing is stored by a request that was refused', async () => {
    await app.bare('/spawns', { method: 'POST', headers: json, body: SPAWN })
    expect(await (await app.get('/spawns')).json()).toEqual({ spawns: [] })
  })
})

describe('content type', () => {
  // A cross-origin page can send text/plain with no preflight.
  test.each([
    ['text/plain', 'text/plain'],
    ['a form', 'application/x-www-form-urlencoded'],
    ['none', undefined],
  ])('a POST with %s is 415 and stores nothing', async (_name, type) => {
    const headers: Record<string, string> = { ...bearer(TEST_TOKEN) }
    if (type) headers['content-type'] = type
    const res = await app.bare('/spawns', { method: 'POST', headers, body: SPAWN })
    expect(res.status).toBe(415)
    expect(await (await app.get('/spawns')).json()).toEqual({ spawns: [] })
  })

  test('a PUT is held to it too', async () => {
    const body = JSON.stringify({ weeklyUsed: 1, fiveHourUsed: 1 })
    const res = await app.bare('/quota/accounts/a', {
      method: 'PUT',
      headers: { ...bearer(TEST_TOKEN), 'content-type': 'text/plain' },
      body,
    })
    expect(res.status).toBe(415)
  })

  test('application/json with a charset passes', async () => {
    const headers = { ...bearer(TEST_TOKEN), 'content-type': 'Application/JSON; charset=utf-8' }
    expect((await app.bare('/spawns', { method: 'POST', headers, body: SPAWN })).status).toBe(201)
  })

  test('the token is checked before the content type', async () => {
    expect((await app.bare('/spawns', { method: 'POST', body: SPAWN })).status).toBe(401)
  })
})

describe('host header', () => {
  test.each(['evil.example', 'evil.example:7793', '127.0.0.1.evil.example', 'localhost.evil.example:80', ''])(
    'Host %p is 421, with a valid token',
    async (host) => {
      const res = await app.bare('/spawns', { headers: { ...bearer(TEST_TOKEN), host } })
      expect(res.status).toBe(421)
    },
  )

  test.each(['127.0.0.1', '127.0.0.1:7793', 'localhost', 'LOCALHOST:7793', '[::1]:7793'])(
    'Host %p passes',
    async (host) => {
      expect((await app.bare('/spawns', { headers: { ...bearer(TEST_TOKEN), host } })).status).toBe(200)
    },
  )

  test('it applies to /health too', async () => {
    expect((await app.bare('/health', { headers: { host: 'evil.example' } })).status).toBe(421)
  })
})

describe('body size', () => {
  const post = (body: string, extra: Record<string, string> = {}) =>
    app.bare('/spawns', { method: 'POST', headers: { ...bearer(TEST_TOKEN), ...json, ...extra }, body })
  const oversized = JSON.stringify({ key: 'k', repo: '/r', prompt: 'p'.repeat(MAX_BODY_BYTES) })

  test('a body above 64 KiB is 413 and stores nothing', async () => {
    const res = await post(oversized)
    expect(res.status).toBe(413)
    expect(await (await app.get('/spawns')).json()).toEqual({ spawns: [] })
  })

  test('the declared Content-Length alone is refused, before any of the body arrives', async () => {
    // Headers only: a server that waited for 64 KiB + 1 bytes would never answer.
    let received = ''
    const answered = Promise.withResolvers<void>()
    const socket = await Bun.connect({
      hostname: '127.0.0.1',
      port: Number(app.url.port),
      socket: {
        data(_socket, data) {
          received += data.toString()
          answered.resolve()
        },
      },
    })
    socket.write(
      `POST /spawns HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TEST_TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${MAX_BODY_BYTES + 1}\r\nConnection: close\r\n\r\n{`,
    )
    await Promise.race([answered.promise, Bun.sleep(3000)])
    socket.end()
    expect(received.split('\r\n')[0]).toBe('HTTP/1.1 413 Payload Too Large')
  })

  test('a chunked body with no Content-Length is counted as it streams', async () => {
    const stream = new ReadableStream({
      start(controller) {
        const chunk = new TextEncoder().encode('x'.repeat(8 * 1024))
        for (let i = 0; i < 16; i++) controller.enqueue(chunk)
        controller.close()
      },
    })
    const res = await app.bare('/spawns', {
      method: 'POST',
      headers: { ...bearer(TEST_TOKEN), ...json },
      body: stream,
      duplex: 'half',
    })
    expect(res.status).toBe(413)
  })

  test('a body just under the cap is read', async () => {
    const prompt = 'p'.repeat(MAX_PROMPT_CHARS)
    const res = await post(JSON.stringify({ key: 'big', repo: TEST_REPO, prompt }))
    expect(res.status).toBe(201)
  })

  test('a prompt over its cap is 400', async () => {
    const res = await post(JSON.stringify({ key: 'k', repo: '/r', prompt: 'p'.repeat(MAX_PROMPT_CHARS + 1) }))
    expect(res.status).toBe(400)
  })

  test('an event payload over its cap is 400, one at the cap is stored', async () => {
    const event = (payload: unknown, key: string) =>
      app.send('POST', '/events', { key, session: 's', kind: 'turn_ended', at: '2026-10-30T10:00:00Z', payload })
    const fits = { v: 'x'.repeat(MAX_PAYLOAD_CHARS - 8) }
    expect(JSON.stringify(fits).length).toBe(MAX_PAYLOAD_CHARS)
    expect((await event(fits, 'fits')).status).toBe(201)
    expect((await event({ v: 'x'.repeat(MAX_PAYLOAD_CHARS) }, 'too-big')).status).toBe(400)
  })
})
