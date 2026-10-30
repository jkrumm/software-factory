import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { loadConfig } from '../src/config.ts'
import { startApp, type TestApp } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

let db: TestDb
let app: TestApp

beforeAll(async () => {
  db = await startTestDb()
  app = startApp({ sql: db.sql, clock: new FakeClock() })
})
afterAll(async () => {
  await app.stop()
  await db.stop()
})

describe('routing (finding 8)', () => {
  test.each([
    ['GET', '/events', 'POST'],
    ['DELETE', '/spawns/x', 'GET'],
    ['GET', '/capacity/a', 'PUT'],
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
    for (const path of ['/sessions/%E0%A4%A', '/spawns/%', '/capacity/%zz']) {
      const res = await app.get(path)
      expect(res.status).toBeLessThan(500)
    }
  })

  test('/health answers ok with the version', async () => {
    const res = await app.get('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', version: 'test' })
  })
})

describe('config (finding 5)', () => {
  const env = { DATABASE_URL: 'postgres://x', HERDR_BIN: 'herdr', PORT: '7793' }

  test('reads the environment', () => {
    expect(loadConfig({ ...env, FACTORY_VERSION: 'abc' })).toEqual({
      databaseUrl: 'postgres://x',
      herdrBin: 'herdr',
      port: 7793,
      version: 'abc',
    })
    expect(loadConfig(env).version).toBe('dev')
  })

  test.each(['abc', '', '0', '65536', '80.5', '-1', 'NaN', ' '])('PORT %p is refused', (port) => {
    expect(() => loadConfig({ ...env, PORT: port })).toThrow(/PORT/)
  })

  test.each(['DATABASE_URL', 'HERDR_BIN', 'PORT'])('%s is required', (name) => {
    expect(() => loadConfig({ ...env, [name]: undefined })).toThrow(`${name} is not set`)
  })
})
