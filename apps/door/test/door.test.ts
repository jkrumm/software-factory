import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  AlertRequest,
  type DoorReport,
  FeedbackRequest,
  MAX_FACTS_BYTES,
  type SignalAck,
} from '@software-factory/contract'
import { createDoor, doorTokenFrom, fileViaHttp, type Filed, MAX_BODY_BYTES, reportViaHttp } from '../src/door.ts'

const KUMA_TOKEN = 'kuma-token-0123456789-abcdef'
const HYPERDX_TOKEN = 'hyperdx-token-0123456789-abcdef'
const WEATHER_TOKEN = 'weather-token-0123456789-abcdef'
const ack = (outcome: SignalAck['outcome'], detail: SignalAck['detail'], issue: string | null = null): SignalAck => ({
  outcome,
  detail,
  issue,
  signal: 'signal_1',
  reason: null,
})
const fixture = (name: string): Promise<unknown> => Bun.file(join(import.meta.dir, 'fixtures', name)).json()

let filed: AlertRequest[]
let feedbacks: FeedbackRequest[]
let answer: () => Promise<Filed>
let logs: string[]
let reports: DoorReport[]
let reportFails = false

const door = createDoor({
  tokens: { kuma: KUMA_TOKEN, hyperdx: HYPERDX_TOKEN, 'feedback-weather': WEATHER_TOKEN },
  file: async (input) => {
    filed.push(input)
    return answer()
  },
  feedback: async (input) => {
    feedbacks.push(input)
    return answer()
  },
  log: (line) => logs.push(line),
  now: () => new Date('2026-11-07T10:00:00.000Z'),
  report: async (r) => {
    reports.push(r)
    if (reportFails) throw new Error('server down')
  },
})
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: door })
afterAll(() => server.stop(true))
beforeEach(() => {
  filed = []
  feedbacks = []
  logs = []
  reports = []
  reportFails = false
  answer = async () => ({ status: 200, body: ack('filed', 'new', 'issue_7') })
})

const send = (path: string, init: RequestInit & { token?: string | null; type?: string | null } = {}) => {
  const { token = KUMA_TOKEN, type = 'application/json', headers, ...rest } = init
  return fetch(new URL(path, server.url), {
    method: 'POST',
    ...rest,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(type ? { 'content-type': type } : {}),
      ...headers,
    },
  })
}
const alert = async (name = 'kuma-down.json', path = '/alert/kuma', init: Parameters<typeof send>[1] = {}) =>
  send(path, { body: JSON.stringify(await fixture(name)), ...init })

describe('the route', () => {
  test('a real alert is filed with the server and its status passed on', async () => {
    const response = await alert()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(ack('filed', 'new', 'issue_7'))
    expect(filed).toHaveLength(1)
    expect(filed[0]).toMatchObject({ source: 'kuma', monitor: 'forecast-api', status: 'down' })
  })

  test('the same door takes the other source with its own token', async () => {
    const response = await alert('hyperdx-alert.json', '/alert/hyperdx', { token: HYPERDX_TOKEN })
    expect(response.status).toBe(200)
    expect(filed[0]).toMatchObject({ source: 'hyperdx', monitor: 'API error rate' })
  })

  test('a Kuma test message and a beat that is neither down nor up are answered 200 and file nothing', async () => {
    for (const name of ['kuma-test.json', 'kuma-pending.json']) {
      const response = await alert(name)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ outcome: 'ignored' })
    }
    expect(filed).toEqual([])
  })

  test('every outcome of the server’s ack is passed on as it is', async () => {
    for (const outcome of ['filed', 'amended', 'incident', 'held', 'dropped'] as const) {
      const body = ack(outcome, 'quiet')
      answer = async () => ({ status: 200, body })
      const response = await alert()
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(body)
    }
  })

  test('anything but /alert/<source> is 404, and another method on it 405', async () => {
    for (const path of ['/', '/health', '/alert', '/alert/', '/alert/kuma/x', '/alert/Kuma', '/intake', '/issues']) {
      expect((await send(path, { body: '{}' })).status).toBe(404)
    }
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const response = await send('/alert/kuma', { method })
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('POST')
    }
    expect((await fetch(new URL('/alert/kuma', server.url))).status).toBe(405)
    expect(filed).toEqual([])
  })

  test('a token for a source that has no parser is 404 once it has passed', async () => {
    const custom = createDoor({
      log: () => {},
      tokens: { other: 'other-token-0123456789-abcdef' },
      file: async () => ({ status: 200, body: {} }),
    })
    const response = await custom(
      new Request('http://localhost/alert/other', {
        method: 'POST',
        headers: { authorization: 'Bearer other-token-0123456789-abcdef', 'content-type': 'application/json' },
        body: '{}',
      }),
    )
    expect(response.status).toBe(404)
  })
})

describe('the token', () => {
  test('no token, a wrong one, another source’s and an unknown source are all 401 with no body', async () => {
    const attempts = [
      alert('kuma-down.json', '/alert/kuma', { token: null }),
      alert('kuma-down.json', '/alert/kuma', { token: 'wrong' }),
      alert('kuma-down.json', '/alert/kuma', { token: HYPERDX_TOKEN }),
      alert('kuma-down.json', '/alert/nobody', { token: KUMA_TOKEN }),
      alert('kuma-down.json', '/alert/kuma', { headers: { authorization: `Basic ${KUMA_TOKEN}` }, token: null }),
      alert('kuma-down.json', '/alert/kuma', { token: `${KUMA_TOKEN}x` }),
      alert('kuma-down.json', '/alert/kuma', { token: KUMA_TOKEN.slice(0, -1) }),
    ]
    for (const response of await Promise.all(attempts)) {
      expect(response.status).toBe(401)
      expect(await response.text()).toBe('')
    }
    expect(filed).toEqual([])
  })

  test('a source named like an inherited property is an unknown source, not an error', async () => {
    for (const name of ['constructor', 'tostring', 'valueof']) {
      const response = await alert('kuma-down.json', `/alert/${name}`)
      expect(response.status).toBe(401)
    }
  })

  test('the check comes before the content type and the body', async () => {
    const response = await send('/alert/kuma', {
      token: 'wrong',
      type: 'text/plain',
      body: 'x'.repeat(MAX_BODY_BYTES + 1),
    })
    expect(response.status).toBe(401)
  })

  test('neither a body nor a token is ever logged', async () => {
    await alert()
    await alert('kuma-down.json', '/alert/kuma', { token: 'wrong-token-visible-in-no-log' })
    await send('/alert/kuma', { body: '{ not json s3cret-in-body' })
    expect(logs.length).toBe(3)
    const text = logs.join('\n')
    for (const secret of [
      KUMA_TOKEN,
      HYPERDX_TOKEN,
      'wrong-token-visible-in-no-log',
      's3cret',
      'forecast-api',
      'ECONNREFUSED',
    ]) {
      expect(text).not.toContain(secret)
    }
    expect(logs[0]).toMatch(/^\S+ POST kuma 200 \d+ms$/)
    expect(logs[1]).toMatch(/^\S+ POST refused kuma 401 \d+ms$/)
  })
})

describe('the body', () => {
  test('a body of 64 KiB + 1 is 413, a body of exactly 64 KiB is read', async () => {
    const pad = (size: number) => JSON.stringify({ heartbeat: null, monitor: null, msg: 'x'.repeat(size) })
    const base = Buffer.byteLength(pad(0))
    expect(Buffer.byteLength(pad(MAX_BODY_BYTES - base))).toBe(MAX_BODY_BYTES)
    expect((await send('/alert/kuma', { body: pad(MAX_BODY_BYTES - base) })).status).toBe(200)
    expect((await send('/alert/kuma', { body: pad(MAX_BODY_BYTES - base + 1) })).status).toBe(413)
    expect(filed).toEqual([])
  })

  test('the cap holds for a body that does not say how long it is', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(16 * 1024))
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(chunk)
      },
    })
    const response = await send('/alert/kuma', { body: stream, duplex: 'half' })
    expect(response.status).toBe(413)
  })

  test('anything but application/json is 415, with its parameters allowed', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', null]) {
      expect((await alert('kuma-down.json', '/alert/kuma', { type })).status).toBe(415)
    }
    expect((await alert('kuma-down.json', '/alert/kuma', { type: 'Application/JSON; charset=utf-8' })).status).toBe(200)
  })

  test('JSON that is not JSON, or not the source’s shape, is 400', async () => {
    expect((await send('/alert/kuma', { body: '{ nope' })).status).toBe(400)
    expect((await send('/alert/kuma', { body: '[]' })).status).toBe(400)
    expect((await send('/alert/hyperdx', { body: '{}', token: HYPERDX_TOKEN })).status).toBe(400)
    expect(filed).toEqual([])
  })
})

describe('the server', () => {
  test('a server that is down is 503, and nothing is spooled', async () => {
    const unreachable = createDoor({
      tokens: { kuma: KUMA_TOKEN },
      file: async () => {
        throw new Error('ECONNREFUSED')
      },
      log: () => {},
    })
    const response = await unreachable(
      new Request('http://localhost/alert/kuma', {
        method: 'POST',
        headers: { authorization: `Bearer ${KUMA_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(await fixture('kuma-down.json')),
      }),
    )
    expect(response.status).toBe(503)
  })

  test('detail too large for the server is cut and the alert still filed', async () => {
    const msg = '障'.repeat(1500)
    const base = (await fixture('kuma-down.json')) as { heartbeat: object }
    const response = await send('/alert/kuma', {
      body: JSON.stringify({ ...base, msg, heartbeat: { ...base.heartbeat, msg } }),
    })
    expect(response.status).toBe(200)
    const sent = JSON.stringify(filed[0]?.facts)
    expect(Buffer.byteLength(sent)).toBeLessThanOrEqual(MAX_FACTS_BYTES)
    expect(Buffer.byteLength(JSON.stringify(filed[0]))).toBeLessThan(MAX_BODY_BYTES)
  })

  test('a server error is 503; a refusal is 422 without its reason; a drifted answer is 502', async () => {
    answer = async () => ({ status: 500, body: { error: 'internal error' } })
    expect((await alert()).status).toBe(503)
    answer = async () => ({ status: 503, body: null })
    expect((await alert()).status).toBe(503)
    answer = async () => ({ status: 422, body: { error: 'repo /Users/me/WorkRoot/x is outside the allowed roots' } })
    const refused = await alert()
    expect(refused.status).toBe(422)
    expect(await refused.json()).toEqual({ error: 'the alert was refused' })
    answer = async () => ({ status: 200, body: { something: 'else' } })
    expect((await alert()).status).toBe(502)
    answer = async () => ({ status: 201, body: ack('filed', 'new') })
    expect((await alert()).status).toBe(502)
    answer = async () => ({ status: 400, body: { error: 'x' } })
    expect((await alert()).status).toBe(502)
  })

  test('the door posts exactly an AlertRequest, and a payload’s own repo, path or command is not a field of it', async () => {
    const base = (await fixture('kuma-down.json')) as Record<string, unknown>
    await send('/alert/kuma', {
      body: JSON.stringify({
        ...base,
        repo: 'evil',
        path: '/etc',
        command: 'x',
        monitor: { ...(base.monitor as object), repo: 'evil' },
      }),
    })
    const posted: unknown = JSON.parse(JSON.stringify(filed[0]))
    expect(Object.keys(posted as object).sort()).toEqual(['event', 'facts', 'monitor', 'source', 'status', 'title'])
    expect(AlertRequest.safeParse(posted).success).toBe(true)
    expect(JSON.stringify(posted)).not.toContain('evil')
  })

  test('over HTTP the door posts to /signals/alerts and /door/reports of the factory URL with its bearer token', async () => {
    const seen: { path: string; body: unknown; authorization: string | null }[] = []
    const factory = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (req) => {
        seen.push({
          path: new URL(req.url).pathname,
          body: await req.json(),
          authorization: req.headers.get('authorization'),
        })
        return Response.json(seen.length === 1 ? ack('filed', 'new') : { ok: true })
      },
    })
    try {
      const base = factory.url.href
      const input = AlertRequest.parse({
        source: 'kuma',
        monitor: 'm',
        event: 'e',
        status: 'down',
        title: 't',
        facts: {},
      })
      expect(await fileViaHttp(base, 'door-token-0123456789')(input)).toEqual({
        status: 200,
        body: ack('filed', 'new'),
      })
      await reportViaHttp(base, 'door-token-0123456789')({ kind: 'accepted', source: 'kuma' })
      expect(seen.map((call) => call.path)).toEqual(['/signals/alerts', '/door/reports'])
      expect(seen[0]?.body).toEqual(input)
      expect(seen.map((call) => call.authorization)).toEqual(Array(2).fill('Bearer door-token-0123456789'))
    } finally {
      await factory.stop(true)
    }
  })
})

describe('refusals, probes and reports', () => {
  const T = '2026-11-07T10:00:00.000Z'

  test('a refusal is logged with the time and the claimed source, never the token, and reported', async () => {
    const response = await send('/alert/kuma', { token: 'wrong-token-secret', body: '{}' })
    expect(response.status).toBe(401)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(new RegExp(`^${T} POST refused kuma 401 \\d+ms$`))
    expect(logs.join()).not.toContain('wrong-token-secret')
    expect(reports).toEqual([{ kind: 'refused', source: 'kuma' }])
  })

  test('a request with the probe header is logged as a probe and not reported', async () => {
    const response = await send('/alert/kuma', { token: null, body: '{}', headers: { 'x-factory-probe': '1' } })
    expect(response.status).toBe(401)
    expect(logs[0]).toMatch(new RegExp(`^${T} POST probe kuma 401 \\d+ms$`))
    expect(reports).toEqual([])
  })

  test('a source without a token is logged but never reported', async () => {
    expect((await send('/alert/nobody', { token: 'x', body: '{}' })).status).toBe(401)
    expect(logs[0]).toContain('refused nobody 401')
    expect(reports).toEqual([])
  })

  test('a Kuma test message that passed auth is reported accepted; an ordinary line has the time in front', async () => {
    expect((await alert('kuma-test.json')).status).toBe(200)
    expect(reports).toEqual([{ kind: 'accepted', source: 'kuma' }])
    expect(logs[0]).toMatch(new RegExp(`^${T} POST kuma 200 \\d+ms$`))
  })

  test('a failing report changes nothing in the response', async () => {
    reportFails = true
    expect((await send('/alert/kuma', { token: 'wrong', body: '{}' })).status).toBe(401)
    expect((await alert('kuma-test.json')).status).toBe(200)
    expect(reports).toHaveLength(2)
  })

  test('a report that never settles delays nothing and a report that throws synchronously fails nothing', async () => {
    const hanging = createDoor({
      tokens: { kuma: KUMA_TOKEN },
      file: async () => ({ status: 200, body: ack('filed', 'new') }),
      log: () => {},
      report: () => new Promise<void>(() => {}),
    })
    const throwing = createDoor({
      tokens: { kuma: KUMA_TOKEN },
      file: async () => ({ status: 200, body: ack('filed', 'new') }),
      log: () => {},
      report: () => {
        throw new Error('sync')
      },
    })
    const request = async () =>
      new Request('http://localhost/alert/kuma', {
        method: 'POST',
        headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
        body: '{}',
      })
    expect((await hanging(await request())).status).toBe(401)
    expect((await throwing(await request())).status).toBe(401)
    const testMessage = new Request('http://localhost/alert/kuma', {
      method: 'POST',
      headers: { authorization: `Bearer ${KUMA_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(await fixture('kuma-test.json')),
    })
    expect((await hanging(testMessage)).status).toBe(200)
  })
})

describe('the factory token', () => {
  test('the door refuses to start without FACTORY_DOOR_TOKEN, naming the variable', () => {
    expect(() => doorTokenFrom({})).toThrow('FACTORY_DOOR_TOKEN')
    expect(() => doorTokenFrom({ FACTORY_DOOR_TOKEN: '' })).toThrow('FACTORY_DOOR_TOKEN')
    expect(doorTokenFrom({ FACTORY_DOOR_TOKEN: 'door-token-0123456789' })).toBe('door-token-0123456789')
  })
})

describe('app feedback', () => {
  const body = { title: 'The chart is empty', text: 'on the forecast page', version: '1.2.0', route: '/forecast' }
  const feedback = (init: Parameters<typeof send>[1] = {}, path = '/feedback/weather') =>
    send(path, { token: WEATHER_TOKEN, body: JSON.stringify(body), ...init })

  test('a feedback is filed as the envelope with the app from the path, and the ack is passed on', async () => {
    answer = async () => ({ status: 200, body: ack('held', 'quarantined') })
    const response = await feedback()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(ack('held', 'quarantined'))
    expect(feedbacks).toEqual([{ app: 'weather', link: null, ...body }])
    expect(FeedbackRequest.safeParse(feedbacks[0]).success).toBe(true)
    expect(filed).toEqual([])
  })

  test('the order is route, method, token, content type, size, JSON, shape', async () => {
    expect((await feedback({ method: 'GET', body: undefined })).status).toBe(405)
    expect((await feedback({}, '/feedback/Weather')).status).toBe(404)
    expect((await feedback({ token: null })).status).toBe(401)
    expect((await feedback({ token: KUMA_TOKEN })).status).toBe(401)
    expect((await feedback({ type: 'text/plain' })).status).toBe(415)
    expect((await feedback({ body: 'x'.repeat(MAX_BODY_BYTES + 1) })).status).toBe(413)
    expect((await feedback({ body: '{nope' })).status).toBe(400)
    expect((await feedback({ body: JSON.stringify({ title: 'x' }) })).status).toBe(400)
    expect(feedbacks).toEqual([])
  })

  test('an app with no token is 401 like any unknown source, and its token opens no alert route', async () => {
    expect((await feedback({}, '/feedback/other')).status).toBe(401)
    expect((await alert('kuma-down.json', '/alert/feedback-weather', { token: WEATHER_TOKEN })).status).toBe(404)
    expect(feedbacks).toEqual([])
  })

  test('a repo in the payload is refused, never carried', async () => {
    const response = await feedback({ body: JSON.stringify({ ...body, repo: 'chat' }) })
    expect(response.status).toBe(400)
    expect(feedbacks).toEqual([])
  })

  test('the server’s refusals and failures are mapped as for an alert, and a refusal is logged by app', async () => {
    answer = async () => ({ status: 422, body: { error: '/secret/path' } })
    const refused = await feedback()
    expect(refused.status).toBe(422)
    expect(await refused.json()).toEqual({ error: 'the feedback was refused' })
    answer = async () => ({ status: 500, body: null })
    expect((await feedback()).status).toBe(503)
    answer = async () => ({ status: 404, body: null })
    expect((await feedback()).status).toBe(502)
    answer = async () => ({ status: 200, body: { nope: true } })
    expect((await feedback()).status).toBe(502)
    answer = async () => {
      throw new Error('down')
    }
    expect((await feedback()).status).toBe(503)

    await feedback({ token: 'wrong-token-0123456789' })
    expect(logs.at(-1)).toContain('POST refused feedback-weather 401')
    expect(reports).toContainEqual({ kind: 'refused', source: 'feedback-weather' })
  })
})
