import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { READ_API_VERSION } from '@software-factory/contract'
import { FactoryError } from '../src/exit.ts'
import { follow } from '../src/follow.ts'
import type { Io } from '../src/operation.ts'
import { run } from '../src/run.ts'

interface Request {
  path: string
  authorization: string | null
  lastEventId: string | null
}

const requests: Request[] = []
/** What the server does with the n-th connection: frames to send, then `close` or `hang` (stay open until the client leaves). */
let plan: (connection: number, request: Request) => Response

const change = (cursor: string, over: Record<string, unknown> = {}) =>
  `id: ${cursor}\nevent: issue\ndata: ${JSON.stringify({ kind: 'issue', issue: 7, ref: 'issue_7', subject: 'working', detail: { to: 'working' }, at: '2026-11-07T10:11:12.000Z', ...over })}\n\n`
const hello = (cursor: string) =>
  `id: ${cursor}\nevent: hello\ndata: ${JSON.stringify({ version: READ_API_VERSION, cursor })}\n\n`

function stream(frames: string[], then: 'close' | 'hang', signal: AbortSignal): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`: keepalive\n\n${frames.join('')}`))
        if (then === 'close') return controller.close()
        signal.addEventListener('abort', () => {
          try {
            controller.close()
          } catch {
            // the client already left
          }
        })
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      const seen = {
        path: `${url.pathname}${url.search}`,
        authorization: request.headers.get('authorization'),
        lastEventId: request.headers.get('last-event-id'),
      }
      requests.push(seen)
      return plan(requests.length, seen)
    },
  })
})

afterAll(async () => {
  await server.stop(true)
})

function setup(env: Record<string, string> = {}) {
  requests.length = 0
  const out: string[] = []
  const io: Io = {
    env: { FACTORY_URL: server.url.href, FACTORY_TOKEN: 'owner-t', ...env },
    out: (text) => void out.push(text),
    err: () => {},
    stdin: () => Promise.resolve(''),
    readFile: () => Promise.resolve(''),
  }
  return { out, io }
}

const FAST = { firstMs: 5, maxMs: 20 }
const input = { untilClosed: false, format: 'json' } as const

describe('follow', () => {
  test('prints one line per frame, resumes with the last cursor after a drop, and ends when the Issue closes', async () => {
    plan = (connection, request) => {
      const signal = new AbortController().signal
      if (connection === 1) return stream([hello('0.0'), change('5.1')], 'close', signal)
      expect(request.lastEventId).toBe('5.1')
      return stream([change('5.2', { detail: { to: 'closed' }, subject: 'closed' })], 'hang', signal)
    }
    const { out, io } = setup()
    await follow({ ...input, issue: 'issue_7', untilClosed: true }, io, new AbortController().signal, FAST)
    expect(out.map((line) => JSON.parse(line).id)).toEqual(['0.0', '5.1', '5.2'])
    expect(JSON.parse(out[1] ?? '')).toMatchObject({
      event: 'issue',
      id: '5.1',
      data: { ref: 'issue_7', kind: 'issue' },
    })
    expect(requests.map((r) => r.path)).toEqual(['/v1/stream?issue=issue_7', '/v1/stream?issue=issue_7&since=5.1'])
    expect(requests[0]?.authorization).toBe('Bearer owner-t')
  })

  test('--since starts from that cursor; the read token is used when there is no owner token; plain is time, id, words', async () => {
    plan = () => stream([change('9.9', { detail: { to: 'closed' } })], 'close', new AbortController().signal)
    const { out, io } = setup({ FACTORY_TOKEN: '', FACTORY_READ_TOKEN: 'read-t' })
    await follow(
      { untilClosed: true, issue: '7', since: '9.0', format: 'plain' },
      io,
      new AbortController().signal,
      FAST,
    )
    expect(requests[0]).toEqual({
      path: '/v1/stream?issue=issue_7&since=9.0',
      authorization: 'Bearer read-t',
      lastEventId: '9.0',
    })
    expect(out).toEqual(['10:11:12\tissue_7\tissue working -> closed\n'])
  })

  test('a signal ends it quietly while the stream is open', async () => {
    plan = () => stream([hello('1.1')], 'hang', new AbortController().signal)
    const { out, io } = setup()
    const stop = new AbortController()
    const done = follow(input, io, stop.signal, FAST)
    while (!out.length) await Bun.sleep(5)
    stop.abort()
    await done
    expect(out).toHaveLength(1)
  })

  test('a 410 is a failure that says to read the resources again', async () => {
    plan = () => Response.json({ error: 'the cursor is gone', code: 'cursor_gone' }, { status: 410 })
    const { io } = setup()
    const error = await follow({ ...input, since: 'bad' }, io, new AbortController().signal, FAST).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(FactoryError)
    expect(error).toMatchObject({ kind: 'general', code: 'cursor_gone', details: { status: 410 } })
    expect((error as FactoryError).hint).toContain('read the resources again')
  })

  test('401 and 403 are auth, exit 3', async () => {
    for (const status of [401, 403]) {
      plan = () => Response.json({ error: 'no', code: 'forbidden' }, { status })
      const { io } = setup()
      const error = await follow(input, io, new AbortController().signal, FAST).catch((e: unknown) => e)
      expect(error).toMatchObject({ kind: 'auth', details: { status } })
    }
  })

  test('a 5xx after the stream was open is waited out; before, it is a failure', async () => {
    plan = (connection) =>
      connection === 1
        ? stream([hello('1.1')], 'close', new AbortController().signal)
        : connection === 2
          ? new Response('down', { status: 503 })
          : stream([change('1.2', { detail: { to: 'closed' } })], 'close', new AbortController().signal)
    const { out, io } = setup()
    await follow({ ...input, issue: '7', untilClosed: true }, io, new AbortController().signal, FAST)
    expect(out).toHaveLength(2)
    expect(requests).toHaveLength(3)

    plan = () => new Response('down', { status: 503 })
    const { io: fresh } = setup()
    const error = await follow(input, fresh, new AbortController().signal, FAST).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'general', details: { status: 503 } })
  })

  test('an unreachable server is exit 7 on the first connect', async () => {
    const { io } = setup({ FACTORY_URL: 'http://127.0.0.1:9' })
    const error = await follow(input, io, new AbortController().signal, FAST).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'network' })
  })

  test('an event this CLI does not know is shown as it came; a frame that is not JSON is exit 9', async () => {
    plan = (connection) =>
      connection === 1
        ? stream(['id: 1.1\nevent: future\ndata: {"x":1}\n\n'], 'close', new AbortController().signal)
        : stream(['id: 1.2\nevent: issue\ndata: nope\n\n'], 'close', new AbortController().signal)
    const { out, io } = setup()
    const error = await follow(input, io, new AbortController().signal, FAST).catch((e: unknown) => e)
    expect(JSON.parse(out[0] ?? '')).toEqual({ event: 'future', id: '1.1', data: { x: 1 } })
    expect(error).toMatchObject({ kind: 'contract_mismatch' })
  })
})

describe('factory follow', () => {
  const cli = async (argv: string[]) => {
    const { io } = setup()
    let err = ''
    const code = await run(argv, { ...io, err: (text) => void (err += text) })
    return { code, err }
  }

  test('--until-closed needs --issue, an unknown flag and a stray argument are usage errors, nothing is requested', async () => {
    for (const argv of [
      ['follow', '--until-closed'],
      ['follow', '--bogus'],
      ['follow', 'extra'],
    ]) {
      requests.length = 0
      const result = await cli(argv)
      expect(result.code).toBe(2)
      expect(JSON.parse(result.err).error.kind).toBe('usage')
      expect(requests).toHaveLength(0)
    }
  })

  test('a refused stream is the exit code of its status, through run', async () => {
    plan = () => Response.json({ error: 'no', code: 'unauthorized' }, { status: 401 })
    expect((await cli(['follow'])).code).toBe(3)
  })
})
