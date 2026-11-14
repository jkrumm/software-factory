import { afterAll, beforeAll, expect, test } from 'bun:test'
import { factory, startServer, type ServerProcess } from './harness.ts'
import { type LeadsWorld, startLeadsWorld } from './leads/support.ts'

/** A deploy stops the one server process and starts the next: the CLI waits that out instead of reporting an outage. */
let w: LeadsWorld
let server: ServerProcess
let issue: string

beforeAll(async () => {
  w = await startLeadsWorld()
  server = w.server
  issue = await w.admitted('restart')
})

afterAll(async () => {
  await server.stop()
  await w.stop()
})

const waiting = 'server restarting (deploy), waiting\n'

async function answers(url: string): Promise<boolean> {
  return fetch(`${url}/health`).then(
    (response) => response.status === 200,
    () => false,
  )
}

/** The server on the same port again, once it answers /health. */
async function restart(): Promise<ServerProcess> {
  const next = await startServer(w.world, { env: { PORT: String(server.port) }, ready: false })
  const until = Date.now() + 60_000
  while (Date.now() < until && !(await answers(server.url))) await Bun.sleep(100)
  return next
}

test('a server away for a few seconds: a read and a write both succeed, with one waiting line on stderr', async () => {
  expect(await server.stop()).toBe(0)
  const env = { FACTORY_URL: server.url }
  const read = factory(w.world, ['capacity', 'get'], env)
  const write = factory(w.world, ['issue', 'note', issue, 'sent while the server restarts'], env)
  await Bun.sleep(6_000)
  server = await restart()
  const [capacity, note] = await Promise.all([read, write])
  expect(capacity.code).toBe(0)
  expect(capacity.err).toBe(waiting)
  expect(JSON.parse(capacity.out)).toBeObject()
  expect(note.code).toBe(0)
  expect(note.err).toBe(waiting)
  expect(JSON.parse(note.out)).toMatchObject({ noted: true })
}, 120_000)

test('a server away past the wait limit ends in the unreachable error, after the waiting line', async () => {
  expect(await server.stop()).toBe(0)
  const started = Date.now()
  const result = await factory(w.world, ['capacity', 'get'], {
    FACTORY_URL: server.url,
    FACTORY_RESTART_WAIT_MS: '3000',
  })
  expect(result.code).toBe(7)
  expect(Date.now() - started).toBeLessThan(15_000)
  const [notice, error] = result.err.trim().split('\n')
  expect(`${notice}\n`).toBe(waiting)
  expect(JSON.parse(error ?? '')).toMatchObject({ error: { kind: 'network' } })
  server = await restart()
}, 60_000)

test('health get never waits: a monitor learns the server is down at once', async () => {
  expect(await server.stop()).toBe(0)
  const result = await factory(w.world, ['health', 'get'], { FACTORY_URL: server.url }, { as: 'none' })
  expect(result.code).toBe(7)
  expect(result.err).not.toContain('waiting')
  server = await restart()
}, 60_000)
