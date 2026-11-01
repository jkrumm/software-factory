import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { hyperdxMonitor, parseHyperdx, parseKuma, PayloadError } from '../src/parsers.ts'

const fixture = (name: string): Promise<unknown> => Bun.file(join(import.meta.dir, 'fixtures', name)).json()

/** The alert of a parse that must have found one. */
const alertOf = (parsed: ReturnType<typeof parseKuma>) => {
  if (parsed.kind !== 'alert') throw new Error(`expected an alert, got: ${parsed.reason}`)
  return parsed.alert
}

describe('kuma', () => {
  test('a down beat: the monitor by name, the event by time', async () => {
    const alert = alertOf(parseKuma(await fixture('kuma-down.json')))
    expect(alert).toMatchObject({
      monitor: 'forecast-api',
      event: '2026-11-01 21:14:07.512',
      status: 'down',
      title: 'forecast-api is down: connect ECONNREFUSED 192.0.2.5:3000',
    })
    expect(alert.facts).toMatchObject({ monitor: { type: 'http', hostname: 'example.com', port: 443 } })
  })

  test('an up beat', async () => {
    const alert = alertOf(parseKuma(await fixture('kuma-up.json')))
    expect(alert).toMatchObject({ monitor: 'forecast-api', status: 'up', event: '2026-11-01 21:19:07.331' })
  })

  test('the monitor url, which can carry credentials, never reaches the facts', async () => {
    const down = alertOf(parseKuma(await fixture('kuma-down.json')))
    expect(JSON.stringify(down)).not.toContain('s3cret')
    expect(JSON.stringify(down)).not.toContain('also-secret')
  })

  test('the test message files nothing', async () => {
    expect(parseKuma(await fixture('kuma-test.json'))).toEqual({ kind: 'ignore', reason: 'a test message' })
  })

  test('a pending beat is neither down nor up', async () => {
    expect(parseKuma(await fixture('kuma-pending.json')).kind).toBe('ignore')
  })

  test('an object with neither key is not Kuma’s test message', () => {
    expect(() => parseKuma({})).toThrow(PayloadError)
    expect(() => parseKuma({ msg: 'Testing' })).toThrow(PayloadError)
  })

  test('a heartbeat without its monitor is not a Kuma payload', () => {
    expect(() => parseKuma({ heartbeat: { status: 0, time: 't' }, monitor: null })).toThrow(PayloadError)
    expect(() => parseKuma('nope')).toThrow(PayloadError)
    expect(() => parseKuma({ heartbeat: { status: 'down', time: 't' }, monitor: { name: 'm' } })).toThrow(PayloadError)
  })

  test('fields the payload adds that mean something elsewhere change nothing here', async () => {
    const base = (await fixture('kuma-down.json')) as Record<string, unknown>
    const hostile = { ...base, repo: '/etc', role: 'lead', path: '/tmp/x', command: 'rm -rf /' }
    expect(alertOf(parseKuma(hostile))).toEqual(alertOf(parseKuma(base)))
  })
})

/** Every string in a value, keys included. */
const strings = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : typeof value === 'object' && value !== null
      ? Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)])
      : []

describe('text cut at a limit', () => {
  test('never ends inside a surrogate pair, wherever the limit falls', async () => {
    const kuma = (await fixture('kuma-down.json')) as { heartbeat: object }
    for (let length = 470; length < 530; length++) {
      const msg = `${'x'.repeat(length)}😀😀😀`
      const down = alertOf(parseKuma({ ...kuma, msg, heartbeat: { ...kuma.heartbeat, msg } }))
      const hyper = alertOf(
        parseHyperdx({ title: `🚨 ${'x'.repeat(length)}😀😀`, body: msg, state: 'ALERT', eventId: msg }),
      )
      for (const text of [...strings(down), ...strings(hyper)]) expect(text.isWellFormed()).toBe(true)
    }
  })
})

describe('short fields', () => {
  const long = 'z'.repeat(9000)

  test('a Kuma type, host, port and time of 9 KB are cut, and the facts stay small', async () => {
    const base = (await fixture('kuma-down.json')) as { heartbeat: object; monitor: object }
    const alert = alertOf(
      parseKuma({
        ...base,
        monitor: { ...base.monitor, type: long, hostname: long, port: long },
        heartbeat: { ...base.heartbeat, time: long },
      }),
    )
    expect(Buffer.byteLength(JSON.stringify(alert.facts))).toBeLessThan(6000)
    expect(alert.event.length).toBeLessThanOrEqual(128)
    expect(alert.facts).toMatchObject({ monitor: { type: expect.stringMatching(/^z+…$/) } })
  })

  test('a HyperDX id and window of 9 KB are cut too, and the event still ends in its status', async () => {
    const base = (await fixture('hyperdx-alert.json')) as object
    const alert = alertOf(
      parseHyperdx({ ...base, eventId: long, alertId: long, startTime: long, endTime: long, link: long }),
    )
    expect(Buffer.byteLength(JSON.stringify(alert.facts))).toBeLessThan(6000)
    expect(alert.event.endsWith(':down')).toBe(true)
  })
})

describe('a label with nothing left of it', () => {
  test('is the source’s own name, so the alert still reaches the server', async () => {
    const base = (await fixture('kuma-down.json')) as { monitor: object; heartbeat: object }
    for (const name of ['   ', '\u0001\u0002']) {
      const alert = alertOf(
        parseKuma({
          ...base,
          monitor: { ...base.monitor, name },
          heartbeat: { ...base.heartbeat, time: name, msg: null },
          msg: null,
        }),
      )
      expect(alert).toMatchObject({ monitor: 'kuma', event: '-', title: 'kuma is down' })
    }
    for (const title of ['🚨', '✅ ', '  ', '🚨 \u0001']) {
      const alert = alertOf(parseHyperdx({ title, state: 'ALERT', eventId: ' ' }))
      expect(alert).toMatchObject({ monitor: 'hyperdx', title: 'hyperdx' })
      expect(alert.event.length).toBeGreaterThan(0)
    }
  })
})

describe('hyperdx', () => {
  test('a firing alert: the monitor is the alert name, not its value', async () => {
    const alert = alertOf(parseHyperdx(await fixture('hyperdx-alert.json')))
    expect(alert).toMatchObject({
      monitor: 'API error rate',
      status: 'down',
      title: 'Alert for "API error rate" - 57 lines found',
    })
    expect(alert.event).toBe(
      '6f0b6a7c-2f43-4d51-9c1e-0a1f2b3c4d5e@2026-11-01T21:05:00.000Z/2026-11-01T21:10:00.000Z:down',
    )
    expect(alert.facts).toMatchObject({ link: expect.stringContaining('hyperdx'), alertId: '65f1c0ffee00112233445566' })
  })

  test('the recovery has the same monitor and another event, though the eventId is the same', async () => {
    const down = alertOf(parseHyperdx(await fixture('hyperdx-alert.json')))
    const up = alertOf(parseHyperdx(await fixture('hyperdx-ok.json')))
    expect(up).toMatchObject({ monitor: down.monitor, status: 'up' })
    expect(up.event).not.toBe(down.event)
  })

  test('a re-fire over a later window is another event, a retry of one notification is the same', async () => {
    const base = (await fixture('hyperdx-alert.json')) as Record<string, unknown>
    const event = (extra: object) => alertOf(parseHyperdx({ ...base, ...extra })).event
    expect(event({ endTime: '2026-11-01T21:15:00.000Z' })).not.toBe(event({}))
    expect(event({})).toBe(event({}))
  })

  test('a state that is neither ALERT nor OK files nothing', async () => {
    const payload = { ...((await fixture('hyperdx-alert.json')) as object), state: 'INSUFFICIENT_DATA' }
    expect(parseHyperdx(payload).kind).toBe('ignore')
  })

  test('a body that is not the template is refused', () => {
    expect(() => parseHyperdx({ title: 'x' })).toThrow(PayloadError)
    expect(() => parseHyperdx([])).toThrow(PayloadError)
  })

  test('a numeric window, as an unquoted template slot sends it, is read too', async () => {
    const payload = { ...((await fixture('hyperdx-alert.json')) as object), startTime: 1793567100000 }
    expect(alertOf(parseHyperdx(payload)).event).toMatch(/@1793567100000\/2026-11-01T21:10:00.000Z:down$/)
  })

  test('a title of another shape loses its prefix and its trailing numbers', () => {
    expect(hyperdxMonitor('🚨 Disk usage 83%')).toBe('Disk usage')
    expect(hyperdxMonitor('✅ Queue depth (1,204)')).toBe('Queue depth')
    expect(hyperdxMonitor('Errors > 5')).toBe('Errors')
    expect(hyperdxMonitor('12345')).toBe('12345')
    expect(hyperdxMonitor('p99 latency')).toBe('p99 latency')
  })

  test('a title made to backtrack costs nothing', () => {
    const started = performance.now()
    for (const title of [
      `${'1'.repeat(60_000)}x`,
      `${'1.'.repeat(30_000)}x`,
      `${' 1'.repeat(30_000)}x`,
      `Alert for "${'1'.repeat(60_000)}`,
    ]) {
      hyperdxMonitor(title)
      parseHyperdx({ title, state: 'ALERT', eventId: 'e' })
    }
    expect(performance.now() - started).toBeLessThan(500)
  })

  test('a value too long for the title does not change the name', () => {
    expect(hyperdxMonitor(`CPU ${'9'.repeat(600)}`)).toBe(hyperdxMonitor(`CPU ${'8'.repeat(700)}`))
  })

  test('the names it makes stay inside the limits of the contract', () => {
    const alert = alertOf(parseHyperdx({ title: 'x'.repeat(5000), state: 'ALERT', eventId: 'e'.repeat(1000) }))
    expect(alert.monitor.length).toBeLessThanOrEqual(256)
    expect(alert.event.length).toBeLessThanOrEqual(256)
    expect(alert.title.length).toBeLessThanOrEqual(500)
  })
})
