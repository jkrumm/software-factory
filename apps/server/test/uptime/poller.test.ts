import { describe, expect, test } from 'bun:test'
import { STALE_AFTER_MS, uptimePoller } from '../../src/adapters/uptime/poller.ts'
import { loadUptimeEnv } from '../../src/adapters/uptime/settings.ts'
import { fixedClock } from '../../src/kernel/clock.ts'

const START = '2026-11-13T10:00:00.000Z'
const URL = 'http://uptime.example/api/monitors'

const monitor = (name: string, status: number, extra: Record<string, unknown> = {}) => ({
  id: name,
  name,
  type: 'http',
  active: true,
  status,
  ...extra,
})

const ready = (monitors: unknown[]) => ({ status: 'ready', lastUpdatedAt: START, staleSince: null, monitors })

function setup(respond: () => Response | Promise<Response>) {
  const clock = fixedClock(START)
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const lines: string[] = []
  const poller = uptimePoller({
    clock,
    url: URL,
    token: 'tok-1',
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return respond()
    }) as unknown as typeof fetch,
    log: (line) => lines.push(line),
  })
  return { clock, calls, lines, poller }
}

describe('uptime poller', () => {
  test('counts by the rule: groups and paused are out, pending and maintenance only in the total', async () => {
    const { poller, calls } = setup(() =>
      Response.json(
        ready([
          monitor('HomeLab', 1, { type: 'group' }),
          monitor('b-down', 0),
          monitor('a-down', 0),
          monitor('ok', 1),
          monitor('ok2', 1),
          monitor('pending', 2),
          monitor('maint', 3),
          monitor('paused', 0, { active: false }),
          monitor('group-down', 0, { type: 'group' }),
        ]),
      ),
    )
    await poller.pass()
    expect(poller.snapshot()).toEqual({ up: 2, down: 2, total: 6, downNames: ['a-down', 'b-down'], at: START })
    expect(calls[0]?.url).toBe(URL)
    expect((calls[0]?.init?.headers as Record<string, string> | undefined)?.Authorization).toBe('Bearer tok-1')
  })

  test('downNames are capped at 10 names of 80 characters', async () => {
    const monitors = Array.from({ length: 12 }, (_, i) =>
      monitor(`m${String(i).padStart(2, '0')}${'x'.repeat(100)}`, 0),
    )
    const { poller } = setup(() => Response.json(ready(monitors)))
    await poller.pass()
    const snapshot = poller.snapshot()
    expect(snapshot?.down).toBe(12)
    expect(snapshot?.downNames).toHaveLength(10)
    expect(snapshot?.downNames.every((name) => name.length === 80)).toBe(true)
  })

  test('a failed pass keeps the last good snapshot and logs one line', async () => {
    let next: () => Response = () => Response.json(ready([monitor('a', 1)]))
    const { poller, lines, clock } = setup(() => next())
    await poller.pass()
    const good = poller.snapshot()
    expect(good).toMatchObject({ up: 1, total: 1 })
    clock.advance(60_000)
    for (const failing of [
      () => new Response('nope', { status: 503 }),
      () => new Response('not json', { status: 200 }),
      () => Response.json({ status: 'starting', monitors: [] }),
      () => Response.json({ nothing: true }),
      () => {
        throw new Error('boom')
      },
    ]) {
      next = failing
      await poller.pass()
      expect(poller.snapshot()).toEqual(good)
    }
    expect(lines).toHaveLength(5)
  })

  test('a body that is not ready is no snapshot', async () => {
    const { poller, lines } = setup(() => Response.json({ status: 'error', monitors: [monitor('a', 1)] }))
    await poller.pass()
    expect(poller.snapshot()).toBeNull()
    expect(lines).toHaveLength(1)
  })

  test('older than ten minutes reads as null', async () => {
    const { poller, clock } = setup(() => Response.json(ready([monitor('a', 1)])))
    await poller.pass()
    clock.advance(STALE_AFTER_MS)
    expect(poller.snapshot()).not.toBeNull()
    clock.advance(1)
    expect(poller.snapshot()).toBeNull()
  })

  test('without a url the feature is off: no call, null', async () => {
    let called = false
    const poller = uptimePoller({
      clock: fixedClock(START),
      url: null,
      fetch: (async () => {
        called = true
        return Response.json({})
      }) as unknown as typeof fetch,
      log: () => {},
    })
    await poller.pass()
    expect(poller.enabled).toBe(false)
    expect(called).toBe(false)
    expect(poller.snapshot()).toBeNull()
  })

  test('settings: off without a url, one minute by default, a bad interval throws', () => {
    expect(loadUptimeEnv({})).toEqual({ url: null, token: null, everyMs: 60_000 })
    expect(loadUptimeEnv({ FACTORY_UPTIME_URL: URL, FACTORY_UPTIME_EVERY_MS: '5000' }).everyMs).toBe(5000)
    expect(() => loadUptimeEnv({ FACTORY_UPTIME_EVERY_MS: 'soon' })).toThrow('FACTORY_UPTIME_EVERY_MS')
  })
})
