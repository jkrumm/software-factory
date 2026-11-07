import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Health } from '@software-factory/contract'
import { TickMonitor } from '../src/health.ts'
import { startTick } from './support/ticker.ts'
import { startApp, type TestApp } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

let db: TestDb
let app: TestApp
let clock: FakeClock
let monitor: TickMonitor

beforeAll(async () => {
  db = await startTestDb()
})
afterAll(async () => {
  await app?.stop()
  await db.stop()
})
beforeEach(async () => {
  await app?.stop()
  clock = new FakeClock()
  monitor = new TickMonitor(clock, 5_000, 240_000)
  app = startApp({ sql: db.sql, clock, monitor })
})

const health = async () => {
  const res = await app.get('/health')
  return { status: res.status, body: Health.parse(await res.json()) }
}

describe('/health and the tick', () => {
  test('reports the last successful tick', async () => {
    monitor.passStarted()
    clock.advance(1000)
    monitor.passSucceeded()
    const { status, body } = await health()
    expect(status).toBe(200)
    expect(body.tick.lastSuccessAt).toBe(clock.now().toISOString())
  })

  test('reports the last tick error and stays ok while ticks keep succeeding', async () => {
    monitor.passStarted()
    monitor.passFailed('database gone')
    clock.advance(5_000)
    monitor.passStarted()
    monitor.passSucceeded()
    const { status, body } = await health()
    expect(status).toBe(200)
    expect(body.tick.lastError).toEqual({
      at: new Date(clock.now().getTime() - 5_000).toISOString(),
      message: 'database gone',
    })
  })

  test('a tick older than three intervals is unhealthy (503) and says how old', async () => {
    monitor.passSucceeded()
    clock.advance(15_000)
    expect((await health()).status).toBe(200)
    clock.advance(1_000)
    const { status, body } = await health()
    expect(status).toBe(503)
    expect(body).toMatchObject({ status: 'unhealthy', reason: 'no successful tick for 16s (limit 15s)' })
  })

  test('a server whose ticks have never succeeded is unhealthy at once, so a broken ticker fails a deploy', async () => {
    expect((await health()).body).toMatchObject({ status: 'unhealthy', reason: 'no tick has succeeded yet' })
    monitor.passStarted()
    monitor.passFailed('boom')
    const { status, body } = await health()
    expect(status).toBe(503)
    expect(body.tick.lastError?.message).toBe('boom')
  })

  test('while the first pass is still running the server is not yet called dead', async () => {
    monitor.passStarted()
    expect((await health()).status).toBe(200)
  })

  test('a pass in flight is healthy until it passes its limit, not after three intervals', async () => {
    monitor.passSucceeded()
    monitor.passStarted()
    clock.advance(200_000)
    expect((await health()).status).toBe(200)
    clock.advance(41_000)
    const { status, body } = await health()
    expect(status).toBe(503)
    expect(body.reason).toContain('a tick pass has run for 241s')
  })

  test('a successful pass makes it healthy again', async () => {
    monitor.passSucceeded()
    clock.advance(60_000)
    expect((await health()).status).toBe(503)
    monitor.passStarted()
    monitor.passSucceeded()
    expect((await health()).status).toBe(200)
  })

  test('a ticker that is stopped is seen as dead', async () => {
    const ticker = startTick(db.sql, clock, monitor)
    await ticker.settled()
    expect((await health()).status).toBe(200)
    await ticker.stop()
    clock.advance(20_000)
    expect((await health()).status).toBe(503)
  })
})
