import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { IntakeInput } from '@software-factory/contract'
import { createDoor, fileViaSocket, type Filed, MAX_BODY_BYTES } from '../src/door.ts'

const KUMA_TOKEN = 'kuma-token-0123456789-abcdef'
const HYPERDX_TOKEN = 'hyperdx-token-0123456789-abcdef'
const fixture = (name: string): Promise<unknown> => Bun.file(join(import.meta.dir, 'fixtures', name)).json()

let filed: IntakeInput[]
let answer: () => Promise<Filed>
let logs: string[]

const door = createDoor({
  tokens: { kuma: KUMA_TOKEN, hyperdx: HYPERDX_TOKEN },
  file: async (input) => {
    filed.push(input)
    return answer()
  },
  log: (line) => logs.push(line),
})
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: door })
afterAll(() => server.stop(true))
beforeEach(() => {
  filed = []
  logs = []
  answer = async () => ({ status: 201, body: { outcome: 'created', issue: 7 } })
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
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ outcome: 'created', issue: 7 })
    expect(filed).toHaveLength(1)
    expect(filed[0]).toMatchObject({ source: 'kuma', monitor: 'forecast-api', status: 'down' })
  })

  test('the same door takes the other source with its own token', async () => {
    const response = await alert('hyperdx-alert.json', '/alert/hyperdx', { token: HYPERDX_TOKEN })
    expect(response.status).toBe(201)
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

  test('the server’s 200 and 202 are the door’s', async () => {
    answer = async () => ({ status: 202, body: { outcome: 'unrouted', issue: null } })
    expect((await alert()).status).toBe(202)
    answer = async () => ({ status: 200, body: { outcome: 'attached', issue: 7 } })
    expect((await alert()).status).toBe(200)
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
      file: async () => ({ status: 201, body: {} }),
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
    expect(logs[0]).toMatch(/^POST kuma 201 \d+ms$/)
    expect(logs[1]).toMatch(/^POST - 401 \d+ms$/)
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
    expect((await alert('kuma-down.json', '/alert/kuma', { type: 'Application/JSON; charset=utf-8' })).status).toBe(201)
  })

  test('JSON that is not JSON, or not the source’s shape, is 400', async () => {
    expect((await send('/alert/kuma', { body: '{ nope' })).status).toBe(400)
    expect((await send('/alert/kuma', { body: '[]' })).status).toBe(400)
    expect((await send('/alert/hyperdx', { body: '{}', token: HYPERDX_TOKEN })).status).toBe(400)
    expect(filed).toEqual([])
  })
})

describe('the server', () => {
  test('a socket that is down is 503, and nothing is spooled', async () => {
    const dir = mkdtempSync('/tmp/factory-door-sock-')
    try {
      const unreachable = createDoor({
        tokens: { kuma: KUMA_TOKEN },
        file: fileViaSocket(join(dir, 'nobody.sock')),
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
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a server error is 503; a refusal is 422 without its reason; a drifted answer is 502', async () => {
    answer = async () => ({ status: 500, body: { error: 'internal error' } })
    expect((await alert()).status).toBe(503)
    answer = async () => ({ status: 422, body: { error: 'repo /Users/me/IuRoot/x is outside the allowed roots' } })
    const refused = await alert()
    expect(refused.status).toBe(422)
    expect(await refused.text()).not.toContain('IuRoot')
    answer = async () => ({ status: 201, body: { something: 'else' } })
    expect((await alert()).status).toBe(502)
    answer = async () => ({ status: 400, body: { error: 'x' } })
    expect((await alert()).status).toBe(502)
  })

  test('the door sends one line to the server over the socket, and a payload’s own repo is not a field of it', async () => {
    const base = (await fixture('kuma-down.json')) as Record<string, unknown>
    await send('/alert/kuma', { body: JSON.stringify({ ...base, repo: '/etc', path: '/etc', command: 'x' }) })
    expect(Object.keys(filed[0] ?? {}).sort()).toEqual(['event', 'facts', 'monitor', 'source', 'status', 'title'])
  })
})
