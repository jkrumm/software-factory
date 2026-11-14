import { expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { createApp } from '../src/api/app.ts'
import { p95Of, ROUTE_WINDOW_MS, routeTimer } from '../src/api/route-timer.ts'
import { healthOf } from '../src/read/health.ts'

test('p95Of: nearest rank, null without a value', () => {
  expect(p95Of([])).toBeNull()
  expect(p95Of([5])).toBe(5)
  expect(p95Of(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95)
  expect(p95Of([3000, 10, 20, 30, 40, 50, 60, 70, 80, 90])).toBe(3000)
})

const health = {
  read: async () => healthOf({ version: 'test', databaseFailure: null, tickAt: null, queueMovedAt: null }),
}

test('routeTimer times every route but /health, with a failing one counted too', async () => {
  let clock = 1_000_000
  const timer = routeTimer({ now: () => clock })
  const app = createApp({ health, routes: timer, tokens: { owner: 'secret' } })
  await app.handle(new Request('http://localhost/health'))
  expect(timer.snapshot().samples).toBe(0)
  // an unknown route without a token answers 401; an answer is an answer
  await app.handle(new Request('http://localhost/v1/nothing'))
  await app.handle(new Request('http://localhost/v1/nothing', { headers: { authorization: 'Bearer secret' } }))
  expect(timer.snapshot().samples).toBe(2)
  clock += ROUTE_WINDOW_MS + 1
  expect(timer.snapshot()).toEqual({ p95Ms: null, samples: 0, windowMs: ROUTE_WINDOW_MS })
})

test('routeTimer: a request still unanswered counts at its age, a stream never counts, a request nobody answers ages out', async () => {
  let clock = 0
  const timer = routeTimer({ now: () => clock })
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  const app = new Elysia()
    .use(timer.plugin)
    .get('/v1/slow', async () => {
      await held
      return 'late'
    })
    .get('/v1/stream', async () => {
      await held
      return 'stream'
    })
    .get('/v1/changes', async () => {
      await held
      return 'sse'
    })
  const calls = [
    app.handle(new Request('http://localhost/v1/slow')),
    app.handle(new Request('http://localhost/v1/stream')),
    app.handle(new Request('http://localhost/v1/changes', { headers: { accept: 'text/event-stream' } })),
  ]
  await Bun.sleep(20)
  clock = 4_000
  expect(timer.snapshot()).toEqual({ p95Ms: 4_000, samples: 1, windowMs: ROUTE_WINDOW_MS })
  // the slow one ends: now it is an answer of 4 s, and the two streams were never counted
  release()
  await Promise.all(calls)
  await Bun.sleep(20)
  expect(timer.snapshot()).toEqual({ p95Ms: 4_000, samples: 1, windowMs: ROUTE_WINDOW_MS })
  clock = ROUTE_WINDOW_MS + 10_000
  expect(timer.snapshot().samples).toBe(0)
})

test('healthOf: the heartbeat gains routeP95Ms and routeSamples beside the four names that stay', () => {
  const base = { version: 'test', databaseFailure: null, tickAt: '2026-11-14T20:00:00.000Z', queueMovedAt: null }
  const plain = healthOf(base)
  expect(Object.keys(plain.heartbeat).sort()).toEqual(['ok', 'queueMovedAt', 'reason', 'tickAt'])
  const timed = healthOf({ ...base, routes: { p95Ms: 2750, samples: 31 } })
  expect(timed.heartbeat).toEqual({
    ok: true,
    reason: null,
    tickAt: '2026-11-14T20:00:00.000Z',
    queueMovedAt: null,
    routeP95Ms: 2750,
    routeSamples: 31,
  })
  expect(healthOf({ ...base, routes: { p95Ms: null, samples: 0 } }).heartbeat.routeP95Ms).toBeNull()
})
