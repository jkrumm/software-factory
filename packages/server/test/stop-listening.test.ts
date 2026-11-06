import { describe, expect, test } from 'bun:test'
import { stopListening } from '../src/http.ts'

/** A stream that never ends, like `/v1/stream`. */
function openStream() {
  return Bun.serve({
    port: 0,
    fetch: () =>
      new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode(': hi\n\n')) }), {
        headers: { 'content-type': 'text/event-stream' },
      }),
  })
}

describe('stopListening', () => {
  test('closes a connection that never ends once the grace is over, instead of waiting for it', async () => {
    const server = openStream()
    const res = await fetch(`http://127.0.0.1:${server.port}/`)
    await res.body?.getReader().read()
    const started = Date.now()
    await stopListening(server, 100)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  test('returns at once when nothing is open', async () => {
    const server = openStream()
    const started = Date.now()
    await stopListening(server, 5000)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
