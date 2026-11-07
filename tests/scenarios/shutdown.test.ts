import { afterAll, beforeAll, expect, test } from 'bun:test'
import { type Socket, connect } from 'node:net'
import { bearer, type ServerProcess, startServer, startWorld, type World } from './harness.ts'

/** A restart sends SIGTERM to a server with an open stream and a kept-alive socket: it must end, and the next copy must boot. */
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

/** A socket that has made one request and been answered, and is now idle: a kept-alive connection. */
async function idleKeepAlive(port: number): Promise<{ socket: Socket; closed: Promise<void> }> {
  const socket = connect({ host: '127.0.0.1', port })
  const closed = new Promise<void>((resolve) => {
    socket.on('close', () => resolve())
    socket.on('error', () => resolve())
  })
  await new Promise<void>((resolve, reject) => {
    let seen = ''
    socket.on('data', (chunk) => {
      seen += chunk.toString()
      if (seen.includes('\r\n\r\n') && seen.includes('"status"')) resolve()
    })
    socket.on('error', reject)
    socket.write(`GET /health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`)
  })
  return { socket, closed }
}

test('SIGTERM with an open stream and an idle keep-alive socket ends the process, and the next copy takes the lock', async () => {
  const idle = await idleKeepAlive(server.port)

  const stream = await fetch(`${server.url}/v1/stream`, { headers: bearer() })
  expect(stream.status).toBe(200)
  const reader = (stream.body as ReadableStream<Uint8Array>).getReader()
  const hello = await reader.read()
  expect(new TextDecoder().decode(hello.value)).toContain('event: hello')

  const started = Date.now()
  const code = await Promise.race([
    server.stop(),
    Bun.sleep(15_000).then(() => {
      server.proc.kill('SIGKILL')
      throw new Error(`the server did not end within 15 s of SIGTERM:\n${server.output()}`)
    }),
  ])
  expect(code).toBe(0)
  expect(Date.now() - started).toBeLessThan(15_000)
  expect(server.output()).not.toContain('took too long')

  // both connections were closed by the server, not left to the client
  await idle.closed
  const ended = await reader.read().then(
    (chunk) => chunk.done,
    () => true,
  )
  expect(ended).toBe(true)

  const next = await startServer(world, { env: { FACTORY_LOCK_WAIT_MS: '5000' } })
  expect((await fetch(`${next.url}/health`)).status).toBe(200)
  expect(await next.stop()).toBe(0)
}, 60_000)
