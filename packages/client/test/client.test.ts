import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createServer } from 'node:net'
import type { Health } from '@software-factory/contract'
import { createApp } from '@software-factory/server/app'
import { inProcessClient } from '../src/eden.ts'
import { send, sendPatient } from '../src/transport.ts'

const health: Health = {
  status: 'ok',
  version: 'dev',
  reason: null,
  heartbeat: { ok: true, reason: null, tickAt: null, queueMovedAt: null },
}

let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === '/echo') {
        return Response.json({ method: request.method, q: url.searchParams.get('q'), body: await request.text() })
      }
      return new Response('plain text', { status: 500 })
    },
  })
})

afterAll(async () => {
  await server.stop(true)
})

test('eden reads /health typed from the app', async () => {
  const app = createApp({ health: { read: async () => health } })
  const { data, status } = await inProcessClient(app).health.get()
  expect(status).toBe(200)
  expect(data).toEqual(health)
})

test('send carries query and JSON body and decodes JSON', async () => {
  const answer = await send({
    base: server.url.href,
    method: 'POST',
    path: '/echo',
    query: { q: 'x y' },
    body: { a: 1 },
  })
  expect(answer).toEqual({
    reached: true,
    status: 200,
    json: { method: 'POST', q: 'x y', body: '{"a":1}' },
    text: '{"method":"POST","q":"x y","body":"{\\"a\\":1}"}',
  })
})

test('send keeps a body that is not JSON as text', async () => {
  const answer = await send({ base: server.url.href, method: 'GET', path: '/other' })
  expect(answer).toEqual({ reached: true, status: 500, json: null, text: 'plain text' })
})

test('send reports an unreachable server instead of throwing', async () => {
  const answer = await send({ base: 'http://127.0.0.1:9', method: 'GET', path: '/health', timeoutMs: 2_000 })
  expect(answer.reached).toBe(false)
})

/** A clock the test drives: `sleep` advances it, and `onTick` can bring a server up at a chosen moment. */
function virtualClock(onTick: (nowMs: number) => void = () => {}) {
  let nowMs = 0
  const sleeps: number[] = []
  return {
    sleeps,
    now: () => nowMs,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      nowMs += ms
      onTick(nowMs)
    },
  }
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const port = probe.port
  await probe.stop(true)
  return port as number
}

describe('sendPatient', () => {
  test('a refused connection is retried for a write until the server is back, then answers', async () => {
    const port = await freePort()
    let back: ReturnType<typeof Bun.serve> | undefined
    const clock = virtualClock((nowMs) => {
      if (!back && nowMs >= 20_000) {
        back = Bun.serve({ hostname: '127.0.0.1', port, fetch: async (r) => Response.json({ got: await r.text() }) })
      }
    })
    let waits = 0
    const answer = await sendPatient(
      { base: `http://127.0.0.1:${port}`, method: 'POST', path: '/x', body: { a: 1 } },
      { limitMs: () => 90_000, onWait: () => waits++, ...clock },
    )
    await back?.stop(true)
    expect(answer).toMatchObject({ reached: true, status: 200, json: { got: '{"a":1}' } })
    expect(waits).toBe(1)
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(20_000)
    expect(Math.max(...clock.sleeps)).toBeLessThanOrEqual(5_000)
  })

  test('a server that stays away past the limit is unreachable, and the limit is the one asked for', async () => {
    const port = await freePort()
    const clock = virtualClock()
    const answer = await sendPatient(
      { base: `http://127.0.0.1:${port}`, method: 'POST', path: '/x', body: {} },
      { limitMs: () => 90_000, ...clock },
    )
    expect(answer).toMatchObject({ reached: false, nothingSent: true })
    expect(clock.now()).toBeLessThanOrEqual(90_000)
    expect(clock.now()).toBeGreaterThan(80_000)
  })

  test('the limit is asked again before every wait, so a deploy that begins stretches the wait', async () => {
    const port = await freePort()
    let limit = 10_000
    const clock = virtualClock((nowMs) => {
      if (nowMs >= 3_000) limit = 30_000
    })
    await sendPatient(
      { base: `http://127.0.0.1:${port}`, method: 'GET', path: '/x' },
      { limitMs: () => limit, ...clock },
    )
    expect(clock.now()).toBeGreaterThan(25_000)
    expect(clock.now()).toBeLessThanOrEqual(30_000)
  })

  test('a connection that was accepted and then closed is retried for a read and never for a write', async () => {
    let connections = 0
    const closing = createServer((socket) => {
      connections++
      socket.on('data', () => socket.destroy())
    })
    await new Promise<void>((resolve) => closing.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(closing.address() as { port: number }).port}`
    const patience = { limitMs: () => 3_000, ...virtualClock() }
    const read = await sendPatient({ base, method: 'GET', path: '/x' }, patience)
    const readConnections = connections
    const write = await sendPatient({ base, method: 'POST', path: '/x', body: {} }, patience)
    closing.close()
    expect(read).toMatchObject({ reached: false, nothingSent: false })
    expect(readConnections).toBeGreaterThan(1)
    expect(write).toMatchObject({ reached: false, nothingSent: false })
    expect(connections - readConnections).toBe(1)
  })

  test('an answer is never retried, whatever its status', async () => {
    let calls = 0
    const failing = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        calls++
        return new Response('no', { status: 503 })
      },
    })
    const answer = await sendPatient(
      { base: failing.url.href, method: 'GET', path: '/x' },
      { limitMs: () => 60_000, ...virtualClock() },
    )
    await failing.stop(true)
    expect(answer).toMatchObject({ reached: true, status: 503 })
    expect(calls).toBe(1)
  })
})
