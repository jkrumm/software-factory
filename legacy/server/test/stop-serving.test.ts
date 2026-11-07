import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { stopServing } from '../src/http.ts'

/** A response that never ends, like `/v1/stream`. */
const endless = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(': hello\n\n'))
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )

test('stopServing closes an open stream after the grace and stops accepting at once (port)', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: endless })
  const url = server.url.href
  const res = await fetch(url)
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  await reader.read()

  const started = Date.now()
  const stopping = stopServing(server, 300)
  await Bun.sleep(50)
  let refused = false
  await fetch(url, { signal: AbortSignal.timeout(500) }).catch(() => {
    refused = true
  })
  expect(refused).toBe(true)
  await stopping
  expect(Date.now() - started).toBeLessThan(3000)
  const after = await reader.read().catch(() => ({ done: true }))
  expect(after.done).toBe(true)
})

test('stopServing closes an open stream on a unix socket', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-stop-'))
  try {
    const unix = join(dir, 's.sock')
    const server = Bun.serve({ unix, fetch: endless })
    const res = await fetch('http://localhost/', { unix })
    await (res.body as ReadableStream<Uint8Array>).getReader().read()
    const started = Date.now()
    await stopServing(server, 300)
    expect(Date.now() - started).toBeLessThan(3000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stopServing returns at once for an idle server', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') })
  const started = Date.now()
  await stopServing(server, 5000)
  expect(Date.now() - started).toBeLessThan(1000)
})
