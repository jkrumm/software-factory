import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Elysia } from 'elysia'
import { agwPort } from '../../src/adapters/agw/port.ts'
import { installStampedConsole, lineStamper } from '../../src/adapters/otel/console.ts'
import { encodeLogs, encodeSpans } from '../../src/adapters/otel/otlp.ts'
import { otelTelemetry } from '../../src/adapters/otel/telemetry.ts'
import { runProcess } from '../../src/adapters/process.ts'
import { createApp } from '../../src/api/app.ts'
import { requestTelemetry } from '../../src/api/telemetry.ts'
import { createLoopRunner, passLoop } from '../../src/app/loops/runner.ts'
import { fixedClock } from '../../src/kernel/clock.ts'
import { key } from '../../src/kernel/keys.ts'
import { err, ok, portError } from '../../src/kernel/result.ts'
import {
  cleanAttrs,
  installTelemetry,
  type LogRecord,
  logEvent,
  markActive,
  reportLine,
  type SpanRecord,
  tracePass,
} from '../../src/kernel/telemetry.ts'

const spans: SpanRecord[] = []
const logs: LogRecord[] = []
let restore = () => {}
let dir = ''

beforeEach(async () => {
  spans.length = 0
  logs.length = 0
  restore = installTelemetry({ span: (s) => spans.push(s), log: (l) => logs.push(l) })
  dir = await mkdtemp('/tmp/factory-telemetry-')
})
afterEach(async () => {
  restore()
  await rm(dir, { recursive: true, force: true })
})

const TITLE = 'Rotate the Postgres password of the work repo'
const NOTE = 'the owner said: do it before friday'

async function fakeAgw(script: string): Promise<string> {
  const path = join(dir, 'agw')
  await writeFile(path, `#!/bin/sh\n${script}\n`)
  await chmod(path, 0o755)
  return path
}

describe('a failing port call', () => {
  test('is one error log and one error span with the loop name and the Result kind, and no text field', async () => {
    const bin = await fakeAgw(`echo "${TITLE}: ${NOTE}" >&2; exit 3`)
    const port = agwPort({ bin })
    const result = await tracePass('triage', async () => {
      const answer = await port.run('judge', { question: TITLE, note: NOTE } as never, key('judge', 'issue_42', 1))
      expect(answer.ok).toBe(false)
      return ok('looked')
    })
    expect(result.ok).toBe(true)

    expect(logs).toHaveLength(1)
    const [log] = logs
    expect(log?.level).toBe('error')
    expect(log?.event).toBe('port.failed')
    expect(log?.attrs).toMatchObject({
      loop: 'triage',
      port: 'agw',
      workflow: expect.any(String),
      'error.kind': 'gone',
      issue: 'issue_42',
    })

    const failed = spans.filter((s) => s.failed)
    expect(failed).toHaveLength(1)
    expect(failed[0]?.name.startsWith('agw.')).toBe(true)
    expect(failed[0]?.attrs).toMatchObject({ loop: 'triage', result: 'gone', 'error.kind': 'gone' })
    // the pass that holds the failed call is recorded, one level up, and is not itself marked failed
    expect(spans.map((s) => s.name)).toContain('loop.triage')
    expect(spans.find((s) => s.name === 'loop.triage')?.failed).toBe(false)

    // no text field: the record shapes carry only a fixed name and attributes
    for (const record of [...spans, ...logs]) {
      expect(Object.keys(record)).not.toContain('message')
      expect(Object.keys(record)).not.toContain('body')
      expect(Object.keys(record)).not.toContain('text')
    }
  })

  test('no span or log attribute is built from an Issue title, note or fact', async () => {
    const bin = await fakeAgw(`echo "${TITLE} ${NOTE}" >&2; exit 3`)
    const port = agwPort({ bin })
    await tracePass('checkpoints', async () => {
      await port.run('judge', { question: TITLE, note: NOTE, facts: [TITLE] } as never, key('judge', 'issue_7'))
      logEvent('error', 'test.event', { title: TITLE, note: NOTE, 'error.type': 'Error', ref: 'artifact_1' })
      reportLine('error', `local words: ${TITLE}`, 'test.reported', { ref: TITLE, issue: NOTE })
      return err(portError('gone', `${TITLE} ${NOTE}`))
    })
    const everything = JSON.stringify({
      spans,
      logs,
      otlp: [encodeSpans({ resource: {}, scope: 's', spans }), encodeLogs({ resource: {}, scope: 's', logs })],
    })
    expect(everything).not.toContain('Postgres')
    expect(everything).not.toContain('friday')
    expect(everything).not.toContain('owner said')
    expect(everything).toContain('artifact_1')
  })

  test('cleanAttrs lets through listed names with one-word values, and drops the rest', () => {
    expect(
      cleanAttrs({
        loop: 'leads',
        title: 'x',
        issue: 'two words',
        ref: '/Users/someone/work-repo/secret.txt with space',
        'duration.ms': 12,
        'exit.code': Number.NaN,
        'error.kind': null,
        count: 3,
      }),
    ).toEqual({ loop: 'leads', 'duration.ms': 12, count: 3 })
  })
})

describe('what a pass records', () => {
  test('a pass that looked and found nothing records nothing, not even its calls', async () => {
    await tracePass('leads', async () => {
      await runProcess(['/usr/bin/true'], 5_000)
      return ok('nothing to do')
    })
    expect(spans).toHaveLength(0)
    expect(logs).toHaveLength(0)
  })

  test('a pass that changed something is one span with its calls under it, in one trace', async () => {
    await tracePass('leads', async () => {
      await runProcess(['/usr/bin/true'], 5_000)
      markActive()
      return ok('did it')
    })
    const pass = spans.find((s) => s.name === 'loop.leads')
    const call = spans.find((s) => s.name === 'process.true')
    expect(pass?.parentSpanId).toBeNull()
    expect(call?.parentSpanId).toBe(pass?.spanId ?? 'missing')
    expect(call?.traceId).toBe(pass?.traceId ?? 'missing')
    expect(call?.attrs).toMatchObject({ port: 'process', program: 'true', result: 'ok', loop: 'leads' })
  })

  test('a failed pass is an error span and one error log with the Result kind', async () => {
    const failed = await tracePass('planning', async () => err(portError('timeout', TITLE)))
    expect(failed).toEqual({ ok: false, error: { kind: 'timeout', detail: TITLE } })
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({ name: 'loop.planning', failed: true })
    expect(spans[0]?.attrs['error.kind']).toBe('timeout')
    expect(logs).toHaveLength(1)
    expect(logs[0]?.attrs).toMatchObject({ loop: 'planning', 'error.kind': 'timeout' })
    expect(JSON.stringify([spans, logs])).not.toContain('Postgres')
  })

  test('a pass that throws is a crashed pass with the error type, and the throw goes on', async () => {
    const thrown = await tracePass('host', async () => {
      throw new TypeError(NOTE)
    }).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(TypeError)
    expect(logs[0]?.attrs).toMatchObject({ loop: 'host', result: 'crashed', 'error.type': 'TypeError' })
    expect(JSON.stringify([spans, logs])).not.toContain('friday')
  })

  test('a call outside any pass is recorded when it fails, and not when it succeeds', async () => {
    await runProcess(['/usr/bin/true'], 5_000)
    expect(spans).toHaveLength(0)
    const refused = await runProcess(['/nonexistent/binary-x'], 5_000).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(Error)
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({ name: 'process.binary-x', failed: true })
    expect(spans[0]?.attrs).toMatchObject({ result: 'threw', 'error.type': 'CannotExecute' })
    expect(logs).toHaveLength(1)
  })

  test('a timed-out process is a failed call; a non-zero exit is an answer, with its code', async () => {
    await runProcess(['/usr/bin/false'], 5_000)
    expect(spans).toHaveLength(0)
    await tracePass('leads', async () => {
      await runProcess(['/usr/bin/false'], 5_000)
      await runProcess(['/bin/sleep', '5'], 50)
      return ok('x')
    })
    const exit = spans.find((s) => s.name === 'process.false')
    expect(exit).toMatchObject({ failed: false })
    expect(exit?.attrs).toMatchObject({ result: 'exit', 'exit.code': 1 })
    expect(spans.find((s) => s.name === 'process.sleep')).toMatchObject({ failed: true })
  })
})

describe('a loop says what counts as work', () => {
  const counted = (n: number) =>
    passLoop(
      { intervalMs: 5, said: () => {} },
      { name: 'watch', pass: async () => ok({ n }), active: (p) => p.n > 0, summary: (p) => `checked ${p.n}` },
    )

  test('a pass with a count above zero is recorded as a span', async () => {
    await tracePass('watch', () => counted(2).run())
    expect(spans.map((s) => s.name)).toEqual(['loop.watch'])
  })

  test('a pass whose counts are all zero records nothing', async () => {
    await tracePass('watch', () => counted(0).run())
    expect(spans).toHaveLength(0)
  })
})

describe('the process span never carries the arguments', () => {
  test('a git verb is named, a path or a message is not', async () => {
    await tracePass('leads', async () => {
      markActive()
      await runProcess(['/usr/bin/git', '-C', '/tmp/some/work-repo', 'status'], 5_000)
      await runProcess(['/bin/echo', '/tmp/some/work-repo'], 5_000)
      await runProcess(['/bin/sh', '-c', 'exit 0 # secret words'], 5_000)
      return ok('x')
    })
    const attrs = spans.filter((s) => s.name.startsWith('process.')).map((s) => s.attrs)
    expect(attrs[0]).toMatchObject({ program: 'git', verb: 'status' })
    expect(attrs[1]?.verb).toBeUndefined()
    expect(attrs[2]?.verb).toBeUndefined()
    expect(JSON.stringify(spans)).not.toContain('work-repo')
    expect(JSON.stringify(spans)).not.toContain('secret')
  })
})

describe('OTLP encoding', () => {
  test('spans: hex ids, nanosecond strings, a status code, typed attributes, no message', () => {
    const body = encodeSpans({
      resource: { 'service.name': 'x' },
      scope: 's',
      spans: [
        {
          traceId: 'a'.repeat(32),
          spanId: 'b'.repeat(16),
          parentSpanId: null,
          name: 'loop.leads',
          startMs: 1_794_996_000_123,
          endMs: 1_794_996_000_223,
          failed: true,
          attrs: { loop: 'leads', count: 2, ratio: 0.5, ok: false },
        },
      ],
    })
    const span = body.resourceSpans[0]?.scopeSpans[0]?.spans[0]
    expect(span).toMatchObject({
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      name: 'loop.leads',
      startTimeUnixNano: '1794996000123000000',
      endTimeUnixNano: '1794996000223000000',
      status: { code: 2 },
    })
    expect(span && 'parentSpanId' in span).toBe(false)
    expect(span?.attributes).toEqual([
      { key: 'loop', value: { stringValue: 'leads' } },
      { key: 'count', value: { intValue: '2' } },
      { key: 'ratio', value: { doubleValue: 0.5 } },
      { key: 'ok', value: { boolValue: false } },
    ])
    expect(span?.status).not.toHaveProperty('message')
  })

  test('logs: the body is the fixed event name, severity and the trace the pass belongs to', () => {
    const body = encodeLogs({
      resource: {},
      scope: 's',
      logs: [
        {
          atMs: 1_794_996_000_123,
          level: 'error',
          event: 'port.failed',
          traceId: 'a'.repeat(32),
          spanId: 'b'.repeat(16),
          attrs: { port: 'agw' },
        },
        {
          atMs: 1_794_996_000_124,
          level: 'warn',
          event: 'api.request_refused',
          traceId: null,
          spanId: null,
          attrs: {},
        },
      ],
    })
    const [first, second] = body.resourceLogs[0]?.scopeLogs[0]?.logRecords ?? []
    expect(first).toMatchObject({
      severityNumber: 17,
      severityText: 'ERROR',
      body: { stringValue: 'port.failed' },
      traceId: 'a'.repeat(32),
    })
    expect(second).toMatchObject({ severityNumber: 13, severityText: 'WARN' })
    expect(second && 'traceId' in second).toBe(false)
  })
})

describe('the exporter', () => {
  const sample: SpanRecord = {
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    parentSpanId: null,
    name: 'loop.leads',
    startMs: 1,
    endMs: 2,
    failed: false,
    attrs: { loop: 'leads' },
  }
  const line: LogRecord = { atMs: 1, level: 'error', event: 'port.failed', traceId: null, spanId: null, attrs: {} }

  test('pushes spans to /v1/traces and logs to /v1/logs with the key, one request each', async () => {
    const calls: { url: string; auth: string | null; body: unknown }[] = []
    const exporter = otelTelemetry({
      endpoint: 'http://collector.example:4318/',
      key: 'ingest-key',
      version: 'abcdef0123',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) })
        return Response.json({})
      }) as unknown as typeof fetch,
    })
    exporter.sink.span(sample)
    exporter.sink.log(line)
    await exporter.flush()
    expect(calls.map((c) => c.url).sort()).toEqual([
      'http://collector.example:4318/v1/logs',
      'http://collector.example:4318/v1/traces',
    ])
    expect(calls.every((c) => c.auth === 'ingest-key')).toBe(true)
    expect(JSON.stringify(calls[0]?.body)).toContain('"service.version"')
    expect(JSON.stringify(calls[0]?.body)).toContain('abcdef0')
    expect(exporter.dropped()).toEqual({ logs: 0, spans: 0 })
    await exporter.flush()
    expect(calls).toHaveLength(2)
  })

  test('a failing export drops the batch, counts it, says so once and never throws', async () => {
    const said: string[] = []
    const exporter = otelTelemetry({
      endpoint: 'http://collector.example:4318',
      key: null,
      version: 'abcdef0',
      log: (l) => said.push(l),
      fetch: (async () => {
        throw new Error('connection refused')
      }) as unknown as typeof fetch,
    })
    exporter.sink.span(sample)
    exporter.sink.span(sample)
    exporter.sink.log(line)
    await exporter.flush()
    exporter.sink.span(sample)
    await exporter.flush()
    expect(exporter.dropped()).toEqual({ logs: 1, spans: 3 })
    expect(said).toHaveLength(1)
  })

  test('an HTTP refusal and a rejected record count too; a full queue drops the newest', async () => {
    let answer: () => Response = () => new Response('no', { status: 503 })
    const exporter = otelTelemetry({
      endpoint: 'http://collector.example:4318',
      key: null,
      version: 'abcdef0',
      maxQueued: 2,
      log: () => {},
      fetch: (async () => answer()) as unknown as typeof fetch,
    })
    for (let i = 0; i < 4; i++) exporter.sink.span(sample)
    expect(exporter.dropped().spans).toBe(2)
    await exporter.flush()
    expect(exporter.dropped().spans).toBe(4)
    answer = () => Response.json({ partialSuccess: { rejectedSpans: '1' } })
    exporter.sink.span(sample)
    await exporter.flush()
    expect(exporter.dropped().spans).toBe(5)
  })

  test('off without an endpoint: nothing is pushed', async () => {
    const exporter = otelTelemetry({
      endpoint: null,
      key: null,
      version: 'x',
      fetch: (async () => {
        throw new Error('no')
      }) as unknown as typeof fetch,
    })
    expect(exporter.enabled).toBe(false)
    exporter.sink.span(sample)
    await exporter.flush()
    expect(exporter.dropped()).toEqual({ logs: 0, spans: 0 })
  })
})

describe('the local log gains a time', () => {
  const at = () => new Date('2026-11-22T10:00:00.123Z')
  const ISO = '2026-11-22T10:00:00.123Z'

  test('every line starts with an ISO time, whatever the chunks look like', () => {
    const stamp = lineStamper(at)
    expect(stamp('one\ntwo\n')).toBe(`${ISO} one\n${ISO} two\n`)
    expect(stamp('half a ')).toBe(`${ISO} half a `)
    expect(stamp('line\n\nafter an empty one')).toBe(`line\n${ISO} \n${ISO} after an empty one`)
    expect(stamp('\n')).toBe('\n')
    expect(stamp('next')).toBe(`${ISO} next`)
  })

  test('console and direct writes both come out stamped, and an unreported error line is one log record without its text', () => {
    const written: string[] = []
    const record = (tag: string) => (chunk: string | Uint8Array) => {
      written.push(`${tag}:${String(chunk)}`)
      return true
    }
    const target = console
    const before = { log: console.log, error: console.error }
    const streams = {
      stdout: { write: record('out') },
      stderr: { write: record('err') },
    }
    const undo = installStampedConsole({ now: at, streams, target })
    target.error('boom: the title was', TITLE)
    target.log('hello')
    streams.stderr.write('direct\n')
    reportLine('error', 'a structured one', 'test.reported', { ref: 'artifact_1' })
    undo()
    expect(written).toEqual([
      `err:${ISO} boom: the title was ${TITLE}\n`,
      `out:${ISO} hello\n`,
      `err:${ISO} direct\n`,
      `err:${ISO} a structured one\n`,
    ])
    // the console line is one record with its length; the structured line is one record, not two
    expect(logs.map((l) => l.event)).toEqual(['console.error', 'test.reported'])
    expect(logs[0]?.attrs).toEqual({ chars: `boom: the title was ${TITLE}`.length })
    expect(console.log).toBe(before.log)
    expect(console.error).toBe(before.error)
  })
})

describe('the API', () => {
  const app = new Elysia()
    .use(requestTelemetry())
    .get('/v1/issues/:id/note', ({ status }) => status(500, 'internal'))
    .post('/v1/signals', ({ status }) => status(400, 'bad'))
    .get('/v1/ok', () => 'fine')
    .get('/v1/own-answer', () => Response.json({ error: 'database down' }, { status: 503 }))
  // Elysia runs `onAfterResponse` after the answer is handed back: give it a tick
  const call = async (path: string, method = 'GET') => {
    const response = await app.handle(new Request(`http://localhost${path}`, { method }))
    await Bun.sleep(10)
    return response
  }

  test('a 5xx is one error span and one error log by route pattern, never by path', async () => {
    expect((await call('/v1/issues/issue_999/note')).status).toBe(500)
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({ name: 'http.request', failed: true })
    expect(spans[0]?.attrs).toMatchObject({
      'http.method': 'GET',
      'http.route': '/v1/issues/:id/note',
      'http.status': 500,
    })
    expect(logs.map((l) => [l.level, l.event])).toEqual([['error', 'api.server_error']])
    expect(JSON.stringify([spans, logs])).not.toContain('issue_999')
  })

  test('a handler that builds its own Response is read by that status', async () => {
    expect((await call('/v1/own-answer')).status).toBe(503)
    expect(spans.map((s) => s.attrs['http.route'])).toEqual(['/v1/own-answer'])
    expect(spans[0]?.attrs['http.status']).toBe(503)
    expect(logs.map((l) => l.event)).toEqual(['api.server_error'])
  })

  test('a bad request is one warning, an ordinary answer nothing', async () => {
    expect((await call('/v1/signals', 'POST')).status).toBe(400)
    expect((await call('/v1/ok')).status).toBe(200)
    expect(spans).toHaveLength(0)
    expect(logs.map((l) => [l.level, l.event])).toEqual([['warn', 'api.request_refused']])
    expect(logs[0]?.attrs).toMatchObject({ 'http.route': '/v1/signals', 'http.status': 400 })
  })
})

describe('the wiring', () => {
  test('a pass run by the loop runner is a loop span, a failed one an error span with its Result kind', async () => {
    const runner = createLoopRunner({
      loops: [
        { name: 'host', intervalMs: 0, onChange: false, run: async () => err(portError('gone', TITLE)) },
        {
          name: 'leads',
          intervalMs: 0,
          onChange: false,
          run: async () => {
            markActive()
            return ok('did something')
          },
        },
        { name: 'queue', intervalMs: 0, onChange: false, run: async () => ok('nothing') },
      ],
      clock: fixedClock('2026-11-22T10:00:00Z'),
      log: () => {},
    })
    await runner.runNow('host')
    await runner.runNow('leads')
    await runner.runNow('queue')
    expect(spans.map((s) => [s.name, s.failed])).toEqual([
      ['loop.host', true],
      ['loop.leads', false],
    ])
    expect(logs.map((l) => l.event)).toEqual(['loop.pass_failed'])
    expect(JSON.stringify([spans, logs])).not.toContain('Postgres')
  })

  test('createApp records a request that ends 500: one error span, the route pattern, an unexpected error with its type only', async () => {
    const app = createApp({
      health: {
        read: async () => {
          throw new RangeError(NOTE)
        },
      },
      log: () => {},
    })
    const response = await app.handle(new Request('http://localhost/health'))
    await Bun.sleep(10)
    expect(response.status).toBe(500)
    expect(spans.map((s) => [s.name, s.failed])).toEqual([['http.request', true]])
    expect(spans[0]?.attrs).toMatchObject({ 'http.route': '/health', 'http.status': 500 })
    expect(logs.map((l) => l.event).sort()).toEqual(['api.server_error', 'api.unexpected_error'])
    expect(logs.find((l) => l.event === 'api.unexpected_error')?.attrs['error.type']).toBe('RangeError')
    expect(JSON.stringify([spans, logs])).not.toContain('friday')
  })
})
