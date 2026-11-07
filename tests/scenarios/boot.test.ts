import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Health } from '@software-factory/contract'
import { factory, type ServerProcess, startServer, startWorld, type World } from './harness.ts'

let world: World
let server: ServerProcess

beforeAll(async () => {
  world = await startWorld()
  server = await startServer(world)
})

afterAll(async () => {
  await server.stop()
  await world.stop()
})

test('the server boots on Postgres and /health answers through the contract', async () => {
  const response = await fetch(`${server.url}/health`)
  expect(response.status).toBe(200)
  expect(Health.parse(await response.json())).toEqual({
    status: 'ok',
    version: 'scenario',
    reason: null,
    heartbeat: { ok: true, reason: null, tickAt: null, queueMovedAt: null },
  })
  const [row] = await world.db.sql`SELECT array_agg(name ORDER BY name) AS names FROM factory.schema_migrations`
  expect(row?.names).toEqual(expect.arrayContaining(['0001_schema.sql', '0002_work.sql']))
})

test('factory health get reads it with the generated CLI', async () => {
  const result = await factory(world, ['health', 'get'], { FACTORY_URL: server.url })
  expect(result.code).toBe(0)
  expect(Health.parse(JSON.parse(result.out)).status).toBe('ok')
  expect(result.err).toBe('')
})

test('factory version and factory role get lead keep their contract', async () => {
  expect(await factory(world, ['version'])).toEqual({ code: 0, out: '{"version":"0.0.0"}\n', err: '' })
  expect(await factory(world, ['version', '--format', 'plain'])).toEqual({ code: 0, out: '0.0.0\n', err: '' })
  const lead = await factory(world, ['role', 'get', 'lead', '--format', 'json'])
  expect(lead.code).toBe(0)
  expect(lead.err).toBe('')
  expect(lead.out).toMatch(/^\{"role":"lead","tier":"(haiku|sonnet|opus)","effort":"(low|medium|high|xhigh|max)"\}\n$/)
  expect((await factory(world, ['role', 'get', 'nobody'])).code).toBe(4)
})

test('a second server on the same database waits for the process lock, then exits 1', async () => {
  const started = Date.now()
  const second = await startServer(world, { env: { FACTORY_LOCK_WAIT_MS: '1500' }, ready: false })
  expect(await second.exited()).toBe(1)
  expect(Date.now() - started).toBeGreaterThanOrEqual(1500)
  expect(second.output()).toContain('another server holds the process lock')
  expect((await fetch(`${server.url}/health`)).status).toBe(200)
})

test('a stopped server lets go of the lock: the next copy boots', async () => {
  expect(await server.stop()).toBe(0)
  server = await startServer(world, { env: { FACTORY_LOCK_WAIT_MS: '5000' } })
  expect((await fetch(`${server.url}/health`)).status).toBe(200)
})

test('booting called neither hc nor agw', async () => {
  expect(await world.calls()).toEqual([])
})
