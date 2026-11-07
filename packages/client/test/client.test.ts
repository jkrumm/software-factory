import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { Health } from '@software-factory/contract'
import { createApp } from '@software-factory/server/app'
import { inProcessClient } from '../src/eden.ts'
import { send } from '../src/transport.ts'

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
