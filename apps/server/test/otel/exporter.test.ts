import { describe, expect, test } from 'bun:test'
import { gaugesOf, otelExporter } from '../../src/adapters/otel/exporter.ts'
import { encodeGauges } from '../../src/adapters/otel/otlp.ts'
import { loadOtelEnv } from '../../src/adapters/otel/settings.ts'
import { fixedClock } from '../../src/kernel/clock.ts'
import type { CapacityGauges } from '../../src/read/capacity-gauges.ts'

const START = '2026-11-18T10:00:00.123Z'
const caps = { perAccount: 3, byAccount: { iu: 20, me: 10 } }

const figures: CapacityGauges = {
  queue: [
    { reason: 'memory', issues: 2 },
    { reason: 'memory_fit', issues: 1 },
  ],
  slotWaits: [{ reason: 'load', repo: 'alpha', waits: 3, totalMs: 4500 }],
  slotWaitP90: [{ reason: 'load', p90Ms: 2000 }],
  placements: [{ host: 'vps', reason: 'free', steps: 4 }],
  seats: [{ account: 'me', used: 7 }],
  host: { load: 9.5, loadCeiling: 8 },
}

/** The first of a list a test knows is not empty; a missing one fails the test with a name. */
function only<T>(list: readonly T[] | undefined): T {
  const found = list?.[0]
  if (found === undefined) throw new Error('expected a first element')
  return found
}

const point = (name: string, gauges = gaugesOf(figures, caps)) => gauges.find((g) => g.name === name)?.points

describe('OTLP encoding', () => {
  test('timestamps are decimal nanosecond strings past 2^53, attributes are string values, empty gauges are dropped', () => {
    const body = encodeGauges({
      resource: { 'service.name': 'x' },
      scope: 's',
      at: new Date(START),
      gauges: [
        { name: 'a', unit: '1', points: [{ value: 1.5, attributes: { k: 'v' } }] },
        { name: 'empty', unit: '1', points: [] },
      ],
    })
    const metrics = only(only(body.resourceMetrics).scopeMetrics).metrics
    expect(metrics.map((m) => m.name)).toEqual(['a'])
    expect(only(only(metrics).gauge.dataPoints)).toEqual({
      timeUnixNano: '1794996000123000000',
      asDouble: 1.5,
      attributes: [{ key: 'k', value: { stringValue: 'v' } }],
    })
    expect(only(body.resourceMetrics).resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'x' } },
    ])
  })
})

describe('the series', () => {
  test('every queue kind is a series, zero when nothing waits; a kind the contract does not list is kept', () => {
    const queue = point('factory.queue.issues') ?? []
    expect(queue.find((p) => p.attributes?.reason === 'memory')?.value).toBe(2)
    expect(queue.find((p) => p.attributes?.reason === 'chain')?.value).toBe(0)
    expect(queue.find((p) => p.attributes?.reason === 'memory_fit')?.value).toBe(1)
  })

  test('seats: used and cap per account, an account with a cap and no lead reads 0 used, the default cap for the rest', () => {
    const withOther = gaugesOf(
      {
        ...figures,
        seats: [
          { account: 'me', used: 7 },
          { account: 'new', used: 1 },
        ],
      },
      caps,
    )
    expect(point('factory.seats.used', withOther)).toEqual([
      { value: 0, attributes: { account: 'iu' } },
      { value: 7, attributes: { account: 'me' } },
      { value: 1, attributes: { account: 'new' } },
    ])
    expect(point('factory.seats.cap', withOther)?.map((p) => p.value)).toEqual([20, 10, 3])
  })

  test('slot waits, placements and the load carry their attributes; a stale host reading leaves the load out', () => {
    expect(point('factory.slot.waits')).toEqual([{ value: 3, attributes: { reason: 'load', repo: 'alpha' } }])
    expect(point('factory.slot.wait.ms')?.[0]?.value).toBe(4500)
    expect(point('factory.slot.wait.p90.ms')).toEqual([{ value: 2000, attributes: { reason: 'load' } }])
    // every placement pair is a series, 0 until one happens; a pair the code does not know yet is kept
    const placements = point('factory.step.placements') ?? []
    expect(placements.find((p) => p.attributes?.host === 'vps' && p.attributes.reason === 'free')?.value).toBe(4)
    expect(placements.find((p) => p.attributes?.host === 'mini' && p.attributes.reason === 'held')?.value).toBe(0)
    expect(placements.find((p) => p.attributes?.host === 'vps' && p.attributes.reason === 'vps')?.value).toBe(0)
    expect(point('factory.host.load')).toEqual([{ value: 9.5 }])
    expect(point('factory.host.load.ceiling')).toEqual([{ value: 8 }])
    const stale = gaugesOf({ ...figures, host: null }, caps)
    expect(point('factory.host.load', stale)).toEqual([])
  })
})

function setup(respond: () => Response | Promise<Response>, read = async () => figures) {
  const calls: { url: string; init: RequestInit }[] = []
  const lines: string[] = []
  const exporter = otelExporter({
    clock: fixedClock(START),
    endpoint: 'https://otel.example',
    key: 'ingest-key',
    version: '0123456789abcdef',
    allowanceCaps: caps,
    read,
    fetch: (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init })
      return respond()
    }) as unknown as typeof fetch,
    log: (line) => lines.push(line),
  })
  return { exporter, calls, lines }
}

describe('the export pass', () => {
  test('posts the gauges as JSON with the key and the contract resource', async () => {
    const { exporter, calls, lines } = setup(() => Response.json({ partialSuccess: {} }))
    await exporter.pass()
    expect(calls).toHaveLength(1)
    expect(only(calls).url).toBe('https://otel.example/v1/metrics')
    const headers = only(calls).init.headers as Record<string, string>
    expect(headers.Authorization).toBe('ingest-key')
    expect(headers['Content-Type']).toBe('application/json')
    const sent = JSON.parse(only(calls).init.body as string)
    const resource = sent.resourceMetrics[0].resource.attributes.map(
      (a: { key: string; value: { stringValue: string } }) => [a.key, a.value.stringValue],
    )
    expect(resource).toContainEqual(['service.name', 'software-factory'])
    expect(resource).toContainEqual(['service.version', '0123456'])
    expect(resource).toContainEqual(['deployment.environment.name', 'prod'])
    expect(lines).toEqual([])
  })

  test('a failing push never throws, is logged once, and the recovery is logged once', async () => {
    let status = 503
    const { exporter, lines } = setup(() => (status === 200 ? Response.json({}) : new Response('no', { status })))
    await exporter.pass()
    await exporter.pass()
    expect(lines).toEqual(['otel export: HTTP 503'])
    status = 200
    await exporter.pass()
    await exporter.pass()
    expect(lines).toEqual(['otel export: HTTP 503', 'otel export: working again'])
  })

  test('a network error, a failing read and rejected data points are caught', async () => {
    const down = setup(() => Promise.reject(new Error('connect refused')))
    await down.exporter.pass()
    expect(down.lines).toEqual(['otel export: connect refused'])

    const broken = setup(
      () => Response.json({}),
      async () => {
        throw new Error('statement timeout')
      },
    )
    await broken.exporter.pass()
    expect(broken.calls).toHaveLength(0)
    expect(broken.lines).toEqual(['otel export: statement timeout'])

    const rejected = setup(() => Response.json({ partialSuccess: { rejectedDataPoints: 5 } }))
    await rejected.exporter.pass()
    expect(rejected.lines).toEqual(['otel export: 5 data points rejected'])
  })

  test('without an endpoint it is off and sends nothing', async () => {
    const calls: unknown[] = []
    const exporter = otelExporter({
      clock: fixedClock(START),
      endpoint: null,
      key: null,
      version: 'dev',
      allowanceCaps: caps,
      read: async () => figures,
      fetch: (async () => calls.push(1)) as unknown as typeof fetch,
    })
    expect(exporter.enabled).toBe(false)
    await exporter.pass()
    expect(calls).toEqual([])
  })
})

describe('settings', () => {
  test('defaults, a trailing slash dropped, and a bad value named', () => {
    expect(loadOtelEnv({})).toEqual({ endpoint: null, key: null, everyMs: 60_000, windowMs: 300_000 })
    expect(loadOtelEnv({ FACTORY_OTEL_ENDPOINT: 'https://otel.example//' }).endpoint).toBe('https://otel.example')
    expect(() => loadOtelEnv({ FACTORY_OTEL_EVERY_MS: '10' })).toThrow('FACTORY_OTEL_EVERY_MS')
  })
})
