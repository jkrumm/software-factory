import { afterAll, beforeAll, expect, test } from 'bun:test'
import { startWorld, type ServerProcess, type World } from '../harness.ts'
import {
  type Door,
  type Estate,
  fakeBeszel,
  type FakeBeszel,
  get,
  makeEstate,
  observe,
  post,
  startDoor,
  startIntakeServer,
  until,
} from './support.ts'

/**
 * A VPS outage fires Beszel (a poll of the hub), HyperDX and Kuma (both through the real door process). The three become
 * one incident Issue, and their `up`s heal it: no second Issue, no lead ever started.
 */
let world: World
let estate: Estate
let hub: FakeBeszel
let server: ServerProcess
let door: Door

beforeAll(async () => {
  world = await startWorld()
  estate = await makeEstate(world, [{ repo: 'vps' }])
  hub = fakeBeszel('vps')
  server = await startIntakeServer(world, estate, {
    FACTORY_BESZEL_URL: hub.url,
    FACTORY_BESZEL_EMAIL: 'owner@example.com',
    FACTORY_BESZEL_PASSWORD: 'hub-password-0123',
    FACTORY_BESZEL_POLL: '1s',
  })
  door = await startDoor(estate, server, ['kuma', 'hyperdx'])
})

afterAll(async () => {
  await door.stop()
  await server.stop()
  hub.stop()
  await estate.stop()
  await world.stop()
})

const kuma = (status: 0 | 1, time: string) => ({
  msg: `[vps - Push] [${status === 0 ? 'Down' : 'Up'}]`,
  monitor: { name: 'vps - Push', type: 'push', hostname: null, port: null },
  heartbeat: { status, time, msg: status === 0 ? 'no heartbeat' : 'ok', ping: null, retries: 0 },
})

const hyperdx = (state: 'ALERT' | 'OK') => ({
  title: '🚨 Alert for "API error rate" - 57 lines found',
  body: 'upstream timeout',
  link: 'https://hyperdx.example.com/search?q=level%3Aerror',
  state,
  startTime: '2026-11-07T10:05:00.000Z',
  endTime: '2026-11-07T10:10:00.000Z',
  eventId: 'evt-1',
  alertId: 'alert-1',
})

test("a VPS outage's three alerts make one incident Issue, and their ups heal it", async () => {
  for (const [source, monitor] of [
    ['kuma', 'vps - Push'],
    ['hyperdx', 'API error rate'],
  ] as const) {
    expect((await post(server, '/door/routes', { source, monitor, repo: 'vps' })).status).toBe(200)
  }

  // Beszel first: the hub reports the VPS choking on memory.
  hub.setMemory(96)
  const first = await until('the Beszel alert to file an Issue', async () => {
    const signals = (await get(server, '/v1/signals')).body.signals as {
      source: string
      issue: string | null
      state: string
    }[]
    return signals.find((s) => s.source === 'beszel' && s.issue)
  })
  expect(first.state).toBe('filed')
  const issue = first.issue as string

  // Then HyperDX and Kuma, through the door.
  const h = await door.post('hyperdx', hyperdx('ALERT'))
  const k = await door.post('kuma', kuma(0, '2026-11-07 10:06:00.000'))
  expect(h).toMatchObject({ status: 200, body: { outcome: 'incident', detail: 'joined', issue } })
  expect(k).toMatchObject({ status: 200, body: { outcome: 'incident', detail: 'joined', issue } })

  const signals = (await get(server, '/v1/signals')).body.signals as {
    source: string
    issue: string | null
    state: string
  }[]
  expect(signals.map((s) => s.issue)).toEqual([issue, issue, issue])
  expect(new Set(signals.map((s) => s.source))).toEqual(new Set(['beszel', 'hyperdx', 'kuma']))
  // filed + two notes: three applied events, nothing else, and still `settling`
  expect(await observe(world, issue)).toMatchObject({ state: 'settling', outcome: null, version: 3 })

  // The ups: Kuma and HyperDX through the door amend, the hub recovering heals it.
  expect(await door.post('kuma', kuma(1, '2026-11-07 10:20:00.000'))).toMatchObject({
    body: { outcome: 'amended', detail: 'matched', issue },
  })
  expect(await door.post('hyperdx', hyperdx('OK'))).toMatchObject({
    body: { outcome: 'amended', detail: 'matched', issue },
  })
  hub.setMemory(30)
  await until('the Issue to close as healed', async () => {
    const seen = await observe(world, issue)
    return seen.state === 'closed' ? seen : null
  })
  expect(await observe(world, issue)).toMatchObject({ state: 'closed', outcome: 'healed' })

  // Never a second Issue: every stored signal points at the one.
  const after = (await get(server, '/v1/signals')).body.signals as { issue: string | null }[]
  expect(new Set(after.map((s) => s.issue))).toEqual(new Set([issue]))
  expect(await world.calls()).toEqual([])
}, 40000)
