import { expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { createApp } from '../src/api/app.ts'
import { p95Of, ROUTE_WARMUP_MS, ROUTE_WINDOW_MS, routeLabel, routeTimer } from '../src/api/route-timer.ts'
import { healthOf } from '../src/read/health.ts'

test('p95Of: nearest rank, null without a value', () => {
  expect(p95Of([])).toBeNull()
  expect(p95Of([5])).toBe(5)
  expect(p95Of(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95)
  expect(p95Of([3000, 10, 20, 30, 40, 50, 60, 70, 80, 90])).toBe(3000)
})

test('routeLabel: the method and the path, a segment with a digit collapsed', () => {
  expect(routeLabel(new Request('http://localhost/v1/issues'))).toBe('GET /v1/issues')
  expect(routeLabel(new Request('http://localhost/v1/issues/issue_1317/note?x=1', { method: 'POST' }))).toBe(
    'POST /v1/issues/:id/note',
  )
})

const health = {
  read: async () => healthOf({ version: 'test', databaseFailure: null, tickAt: null, queueMovedAt: null }),
}

test('routeTimer times every route but /health, with a failing one counted too', async () => {
  let clock = 1_000_000
  const timer = routeTimer({ now: () => clock, warmupMs: 0 })
  const app = createApp({ health, routes: timer, tokens: { owner: 'secret' } })
  await app.handle(new Request('http://localhost/health'))
  expect(timer.snapshot().samples).toBe(0)
  // an unknown route without a token answers 401; an answer is an answer
  await app.handle(new Request('http://localhost/v1/nothing'))
  await app.handle(new Request('http://localhost/v1/nothing', { headers: { authorization: 'Bearer secret' } }))
  expect(timer.snapshot().samples).toBe(2)
  clock += ROUTE_WINDOW_MS + 1
  expect(timer.snapshot()).toEqual({ p95Ms: null, samples: 0, windowMs: ROUTE_WINDOW_MS, slowest: [] })
})

test('routeTimer: a request still unanswered counts at its age, a stream never counts, a request nobody answers ages out', async () => {
  let clock = 0
  const timer = routeTimer({ now: () => clock, warmupMs: 0 })
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
  expect(timer.snapshot()).toEqual({
    p95Ms: 4_000,
    samples: 1,
    windowMs: ROUTE_WINDOW_MS,
    slowest: [{ route: 'GET /v1/slow', ms: 4_000 }],
  })
  // the slow one ends: now it is an answer of 4 s, and the two streams were never counted
  release()
  await Promise.all(calls)
  await Bun.sleep(20)
  expect(timer.snapshot()).toEqual({
    p95Ms: 4_000,
    samples: 1,
    windowMs: ROUTE_WINDOW_MS,
    slowest: [{ route: 'GET /v1/slow', ms: 4_000 }],
  })
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

test('routeTimer: requests begun in the warm-up after the start are not timed, later ones are', async () => {
  let clock = 5_000
  const timer = routeTimer({ now: () => clock })
  const app = new Elysia().use(timer.plugin).get('/v1/ping', () => 'pong')
  await app.handle(new Request('http://localhost/v1/ping'))
  await app.handle(new Request('http://localhost/v1/ping'))
  expect(timer.snapshot().samples).toBe(0)
  clock += ROUTE_WARMUP_MS
  await app.handle(new Request('http://localhost/v1/ping'))
  expect(timer.snapshot().samples).toBe(1)
})

test('routeTimer: filing a signal and a ship wait on a port by design and are not timed; the same paths by another method, and database routes, are', async () => {
  const timer = routeTimer({ now: () => 0, warmupMs: 0 })
  const ok = () => 'ok'
  const app = new Elysia()
    .use(timer.plugin)
    .post('/signals', ok)
    .post('/signals/alerts', ok)
    .post('/signals/feedback', ok)
    .post('/issues/:id/ship', ok)
    .get('/signals', ok)
    .post('/signals/:id/dismiss', ok)
    .post('/issues/:id/note', ok)
  const post = (path: string) => app.handle(new Request(`http://localhost${path}`, { method: 'POST' }))
  await Promise.all(['/signals', '/signals/alerts', '/signals/feedback', '/issues/issue_7/ship'].map(post))
  expect(timer.snapshot().samples).toBe(0)
  await app.handle(new Request('http://localhost/signals'))
  await post('/signals/sig_1/dismiss')
  await post('/issues/issue_7/note')
  expect(timer.snapshot().samples).toBe(3)
})

test('routeTimer: the report reads (retro, throughput, kpis) are not timed; the other reads and a write to the same path are', async () => {
  const timer = routeTimer({ now: () => 0, warmupMs: 0 })
  const ok = () => 'ok'
  const app = new Elysia()
    .use(timer.plugin)
    .get('/v1/retro', ok)
    .get('/v1/throughput', ok)
    .get('/v1/kpis', ok)
    .post('/v1/kpis', ok)
    .get('/v1/capacity-loop', ok)
    .get('/v1/friction', ok)
  await Promise.all(
    ['/v1/retro?days=7', '/v1/throughput', '/v1/kpis'].map((path) =>
      app.handle(new Request(`http://localhost${path}`)),
    ),
  )
  expect(timer.snapshot().samples).toBe(0)
  await app.handle(new Request('http://localhost/v1/kpis', { method: 'POST' }))
  await app.handle(new Request('http://localhost/v1/capacity-loop'))
  await app.handle(new Request('http://localhost/v1/friction'))
  expect(timer.snapshot().samples).toBe(3)
})
