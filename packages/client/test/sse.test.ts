import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { TCPSocketListener } from 'bun'
import { type SseEvent, StreamError, streamEvents } from '../src/sse.ts'

let server: ReturnType<typeof Bun.serve>
// answers with a length it does not deliver, then closes once the test says so: a stream that breaks
let breaking: TCPSocketListener
let held: { end(): unknown } | undefined
let seen: { url: string; authorization: string | null; lastEventId: string | null } | undefined

const sse = (text: string) => new Response(text, { headers: { 'content-type': 'text/event-stream' } })

beforeAll(() => {
  breaking = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket) {
        socket.write(
          'HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: 500\r\n\r\nid: 1\ndata: first\n\n',
        )
        // closing in the same tick can beat the first event to the reader; the test breaks the stream after receiving it
        held = socket
      },
    },
  })
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      seen = {
        url: `${url.pathname}${url.search}`,
        authorization: request.headers.get('authorization'),
        lastEventId: request.headers.get('last-event-id'),
      }
      switch (url.pathname) {
        case '/frames':
          // comments, CRLF, a split data field and a frame without data are all in one answer
          return sse(
            ': keepalive\n\nid: 1.1\nevent: issue\ndata: {"a":1}\n\r\n: again\n\nevent: note\ndata: one\ndata: two\n\nid: 9\n\nid: 1.2\r\ndata: bare\r\n\r\n',
          )
        case '/gone':
          return Response.json({ error: 'gone', code: 'cursor_gone' }, { status: 410 })
        case '/hang':
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('id: 1\ndata: first\n\n'))
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          )
        default:
          return new Response('no', { status: 404 })
      }
    },
  })
})

afterAll(async () => {
  breaking.stop(true)
  await server.stop(true)
})

const collect = async (events: AsyncIterable<SseEvent>) => {
  const out: SseEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

test('events are parsed: comments and data-less frames are dropped, data lines joined, CRLF accepted', async () => {
  const events = await collect(streamEvents({ base: server.url.href, path: '/frames' }))
  expect(events).toEqual([
    { id: '1.1', event: 'issue', data: '{"a":1}' },
    { id: null, event: 'note', data: 'one\ntwo' },
    { id: '1.2', event: 'message', data: 'bare' },
  ])
})

test('token, since and query go on the request', async () => {
  await collect(
    streamEvents({ base: server.url.href, path: '/frames', token: 't', since: '3.4', query: { issue: 'issue_1' } }),
  )
  expect(seen).toEqual({ url: '/frames?issue=issue_1&since=3.4', authorization: 'Bearer t', lastEventId: '3.4' })
})

test('a refusal throws with its status and body', async () => {
  const error = await collect(streamEvents({ base: server.url.href, path: '/gone' })).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(StreamError)
  expect(error).toMatchObject({ reason: 'refused', status: 410, body: { code: 'cursor_gone' } })
})

test('a server that cannot be reached throws unreachable', async () => {
  const error = await collect(streamEvents({ base: 'http://127.0.0.1:9', path: '/x' })).catch((e: unknown) => e)
  expect(error).toMatchObject({ reason: 'unreachable' })
})

test('a break after the first event throws dropped', async () => {
  const seenEvents: SseEvent[] = []
  const error = await (async () => {
    for await (const event of streamEvents({ base: `http://127.0.0.1:${breaking.port}`, path: '/break' })) {
      seenEvents.push(event)
      held?.end()
    }
  })().catch((e: unknown) => e)
  expect(seenEvents).toEqual([{ id: '1', event: 'message', data: 'first' }])
  expect(error).toMatchObject({ reason: 'dropped' })
})

test('aborting ends an open stream without an error', async () => {
  const stop = new AbortController()
  const events: SseEvent[] = []
  for await (const event of streamEvents({ base: server.url.href, path: '/hang', signal: stop.signal })) {
    events.push(event)
    stop.abort()
  }
  expect(events).toEqual([{ id: '1', event: 'message', data: 'first' }])
})
