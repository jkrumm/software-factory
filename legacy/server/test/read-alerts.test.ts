import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AlertList } from '@software-factory/contract'
import {
  type AlertMessage,
  AlertsUnavailable,
  type AlertSource,
  NtfyAlertSource,
  parseMessages,
} from '../src/read/alerts.ts'
import { startApp, TEST_READ_TOKEN, TEST_TOKEN, type TestApp } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

const NOW = new Date('2026-11-07T08:00:00.000Z')
const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000)

class FakeAlerts implements AlertSource {
  messages: AlertMessage[] = []
  error: AlertsUnavailable | undefined
  asked: number[] = []
  async recent(hours: number): Promise<AlertMessage[]> {
    this.asked.push(hours)
    if (this.error) throw this.error
    return this.messages
  }
}

let db: TestDb
let app: TestApp
let alerts: FakeAlerts

beforeAll(async () => {
  db = await startTestDb()
})
afterAll(async () => {
  await db.stop()
})
beforeEach(() => {
  alerts = new FakeAlerts()
  app = startApp({
    sql: db.sql,
    clock: new FakeClock(NOW),
    readToken: TEST_READ_TOKEN,
    alerts,
    read: { visibleNames: async () => ['secretportal'] },
  })
})
afterEach(async () => {
  await app.stop()
})

const as = (token: string, path: string) => app.bare(path, { headers: { authorization: `Bearer ${token}` } })

describe('GET /v1/alerts', () => {
  test('the read token gets the last 24 hours, newest first, with time, source and a one-line text', async () => {
    alerts.messages = [
      { id: 'a', time: sec('2026-11-07T01:00:00Z'), title: 'Kuma', message: 'api is down', priority: 4 },
      { id: 'b', time: sec('2026-11-07T05:30:00Z'), tags: ['hyperdx', 'warning'], message: 'error rate\nabove 5%' },
      { id: 'old', time: sec('2026-11-06T07:00:00Z'), title: 'Kuma', message: 'older than a day' },
    ]
    const res = await as(TEST_READ_TOKEN, '/v1/alerts')
    expect(res.status).toBe(200)
    const body = AlertList.parse(await res.json())
    expect(alerts.asked).toEqual([24])
    expect(body.total).toBe(2)
    expect(body.alerts.map((a) => [a.id, a.at, a.source, a.text, a.priority])).toEqual([
      ['b', '2026-11-07T05:30:00.000Z', 'hyperdx', 'error rate above 5%', 3],
      ['a', '2026-11-07T01:00:00.000Z', 'Kuma', 'api is down', 4],
    ])
  })

  test('hours and limit narrow the read; total counts before the limit', async () => {
    alerts.messages = [1, 2, 3].map((n) => ({ id: `m${n}`, time: sec('2026-11-07T07:00:00Z') + n, message: `m${n}` }))
    const body = AlertList.parse(await (await as(TEST_READ_TOKEN, '/v1/alerts?hours=2&limit=2')).json())
    expect(alerts.asked).toEqual([2])
    expect(body.total).toBe(3)
    expect(body.alerts.map((a) => a.id)).toEqual(['m3', 'm2'])
    for (const q of ['hours=0', 'hours=25', 'hours=x', 'limit=0', 'limit=501'])
      expect([q, (await as(TEST_READ_TOKEN, `/v1/alerts?${q}`)).status]).toEqual([q, 400])
  })

  test('an alert that names a visible repo loses its text and source under the read token, not under the owner token', async () => {
    alerts.messages = [{ id: 'v', time: sec('2026-11-07T06:00:00Z'), title: 'Kuma', message: 'secretportal is down' }]
    const surface = AlertList.parse(await (await as(TEST_READ_TOKEN, '/v1/alerts')).json())
    expect(surface.alerts[0]).toMatchObject({ id: 'v', visible: true, source: null })
    expect(JSON.stringify(surface)).not.toContain('secretportal')
    const owner = AlertList.parse(await (await as(TEST_TOKEN, '/v1/alerts')).json())
    expect(owner.alerts[0]).toMatchObject({ visible: true, source: 'Kuma', text: 'secretportal is down' })
  })

  test('the source down is 503 unavailable, a missing source 503 not_configured, no token 401', async () => {
    alerts.error = new AlertsUnavailable('ntfy answered 500', 'unavailable')
    const down = await as(TEST_READ_TOKEN, '/v1/alerts')
    expect([down.status, await down.json()]).toEqual([503, { error: 'ntfy answered 500', code: 'unavailable' }])
    expect((await app.bare('/v1/alerts')).status).toBe(401)

    await app.stop()
    app = startApp({ sql: db.sql, clock: new FakeClock(NOW), readToken: TEST_READ_TOKEN })
    const missing = await as(TEST_READ_TOKEN, '/v1/alerts')
    expect([missing.status, await missing.json()]).toEqual([
      503,
      { error: 'the alerts source is not set up', code: 'not_configured' },
    ])
  })
})

describe('NtfyAlertSource', () => {
  let ntfy: ReturnType<typeof Bun.serve>
  let seen: { url: string; auth: string | null }[]
  let reply: () => Response

  beforeAll(() => {
    ntfy = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => {
        seen.push({ url: new URL(req.url).pathname + new URL(req.url).search, auth: req.headers.get('authorization') })
        return reply()
      },
    })
  })
  afterAll(async () => {
    await ntfy.stop(true)
  })
  beforeEach(() => {
    seen = []
  })

  const source = (token = 'tk-secret') =>
    new NtfyAlertSource({ url: ntfy.url.origin, topic: 'alerts', token, timeoutMs: 500 })

  test('polls the topic with the bearer and keeps message events only', async () => {
    reply = () =>
      new Response(
        [
          JSON.stringify({ id: 'o', time: 1, event: 'open', topic: 'alerts' }),
          JSON.stringify({
            id: 'm1',
            time: 1_800_000_000,
            event: 'message',
            title: 'Kuma',
            message: 'down',
            priority: 5,
          }),
          'not json',
          JSON.stringify({ id: 'k', time: 2, event: 'keepalive' }),
        ].join('\n'),
      )
    const out = await source().recent(24)
    expect(seen).toEqual([{ url: '/alerts/json?poll=1&since=24h', auth: 'Bearer tk-secret' }])
    expect(out).toEqual([
      { id: 'm1', time: 1_800_000_000, title: 'Kuma', tags: undefined, message: 'down', priority: 5 },
    ])
  })

  test('an error answer is unavailable and never carries the token', async () => {
    reply = () => new Response('nope', { status: 403 })
    const error = await source()
      .recent(24)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AlertsUnavailable)
    expect(error).toMatchObject({ message: 'ntfy answered 403', code: 'unavailable' })
  })

  test('a server that does not answer in time is unavailable', async () => {
    reply = () => new Response(new ReadableStream({ start() {} }))
    const error = await source()
      .recent(24)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'unavailable' })
  })

  test('without a url or a token it says not_configured', async () => {
    const noUrl = await new NtfyAlertSource({ url: '', topic: 'alerts', token: 't' }).recent(1).catch((e: unknown) => e)
    const noToken = await new NtfyAlertSource({ url: 'http://x', topic: 'alerts', token: '' })
      .recent(1)
      .catch((e: unknown) => e)
    expect([noUrl, noToken]).toEqual([
      expect.objectContaining({ code: 'not_configured' }),
      expect.objectContaining({ code: 'not_configured' }),
    ])
  })

  test('parseMessages skips lines without an id or a numeric time', () => {
    expect(parseMessages('{"event":"message","id":"x"}\n{"event":"message","time":1}\n')).toEqual([])
  })
})
