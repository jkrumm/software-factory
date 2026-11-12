import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { SQL } from 'bun'
import { Health } from '@software-factory/contract'
import { type ServerProcess, startServer, startWorld, type World } from './harness.ts'

/**
 * `GET /health` against the real server process: what the Uptime Kuma pusher reads must say `ok` through a restart and a
 * deploy, must answer while the database is blocked, and must fail only for a factory that is stopped.
 */
let world: World
let server: ServerProcess | undefined
const lock = () => join(world.bin, 'data', 'deploy.lock')

/** Leads tick every hour and not due for an hour: the server runs without a tick, as right after a restart. */
const NO_TICK = { FACTORY_LOOP_LEADS_MS: '3600000', FACTORY_HEALTH_PROBE_MS: '100' }

const health = async (url: string) => {
  const response = await fetch(`${url}/health`)
  return { status: response.status, body: Health.parse(await response.json()) }
}

beforeAll(async () => {
  world = await startWorld()
  // boot once so the schema exists, then record a leads pass as of now: the next copy waits an hour for its first tick
  const first = await startServer(world)
  await first.stop()
  await world.db.sql`INSERT INTO factory.loop_passes (loop, last_pass_at) VALUES ('leads', now())
    ON CONFLICT (loop) DO UPDATE SET last_pass_at = EXCLUDED.last_pass_at`
  await mkdir(join(world.bin, 'data'), { recursive: true })
})

afterAll(async () => {
  await server?.stop()
  await world.stop()
})

const restart = async (env: Record<string, string>) => {
  await server?.stop()
  server = await startServer(world, { env: { ...NO_TICK, ...env } })
  return server
}

test('a fresh start is ok and says starting until its first tick', async () => {
  const { url } = await restart({})
  const { status, body } = await health(url)
  expect(status).toBe(200)
  expect(body.status).toBe('ok')
  expect(body.reason).toBe('starting')
  expect(body.heartbeat).toEqual({ ok: true, reason: 'starting', tickAt: null, queueMovedAt: null })
})

test('a restart that never ticks within its grace is not ok', async () => {
  const { url } = await restart({ FACTORY_HEARTBEAT_STALE_MS: '1500' })
  expect((await health(url)).body.reason).toBe('starting')
  await Bun.sleep(1800)
  const { status, body } = await health(url)
  expect(status).toBe(503)
  expect(body.heartbeat.ok).toBe(false)
  expect(body.reason).toStartWith('no tick has succeeded yet; ')
})

test('a deploy that holds the lock is ok and says deploying, until it lets go', async () => {
  const { url } = await restart({ FACTORY_HEARTBEAT_STALE_MS: '1500' })
  await Bun.sleep(1800)
  expect((await health(url)).status).toBe(503)

  await symlink(String(process.pid), lock())
  const held = await health(url)
  expect(held.status).toBe(200)
  expect(held.body.reason).toBe('deploying')
  expect(held.body.heartbeat.ok).toBe(true)

  await rm(lock())
  expect((await health(url)).status).toBe(503)
})

test('a lock whose deploy is dead holds nothing', async () => {
  const { url } = await restart({ FACTORY_HEARTBEAT_STALE_MS: '1500' })
  await Bun.sleep(1800)
  await symlink('2147483646', lock())
  expect((await health(url)).status).toBe(503)
  await rm(lock())
})

test('with the database blocked, /health still answers within a second', async () => {
  const { url } = await restart({})
  // the queue's events table is locked exclusively by another connection: every read of it waits
  const other = new SQL(world.db.url)
  const held = other.begin(async (tx) => {
    await tx`LOCK TABLE factory.issue_events IN ACCESS EXCLUSIVE MODE`
    await Bun.sleep(4_000)
  })
  await Bun.sleep(600)
  try {
    for (let i = 0; i < 5; i++) {
      const started = performance.now()
      const { status, body } = await health(url)
      expect(performance.now() - started).toBeLessThan(1_000)
      expect(status).toBe(200)
      expect(body.status).toBe('ok')
      await Bun.sleep(200)
    }
  } finally {
    await held
    await other.close()
  }
})
