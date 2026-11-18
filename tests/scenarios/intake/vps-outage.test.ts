import { afterAll, beforeAll, expect, test } from 'bun:test'
import { startWorld, type ServerProcess, type World } from '../harness.ts'
import {
  type Door,
  type Estate,
  get,
  makeEstate,
  observe,
  post,
  startDoor,
  startIntakeServer,
  until,
} from './support.ts'

/**
 * A VPS outage fires two HyperDX alerts (an infra alert for host.name=mini, as ClickStack sends it, and an app alert) and Kuma, all through the real door process. The three become
 * one incident Issue, and their `up`s heal it: no second Issue, no lead ever started.
 */
let world: World
let estate: Estate
let server: ServerProcess
let door: Door

beforeAll(async () => {
  world = await startWorld()
  estate = await makeEstate(world, [{ repo: 'vps' }])
  server = await startIntakeServer(world, estate)
  door = await startDoor(estate, server, ['kuma', 'hyperdx'])
})

afterAll(async () => {
  await door.stop()
  await server.stop()
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

/** What ClickStack sends for an infra alert: the host is in the body's group, the alert's name is the monitor. */
const INFRA_MONITOR = 'Infra mini filesystem >= 93% (15m)'
const infra = (state: 'ALERT' | 'OK') => ({
  title: `🚨 ${INFRA_MONITOR}`,
  body: "Group: \"concat(arrayElement(ResourceAttributes, 'host.name'), ' ', arrayElement(Attributes, 'mountpoint')):mini /System/Volumes/Data\"\n0.94 meets or exceeds 0.93\n",
  link: 'https://hyperdx.example.com/dashboards/dash-1?granularity=5+minute',
  state,
  startTime: '2026-11-07T10:00:00.000Z',
  endTime: '2026-11-07T10:05:00.000Z',
  eventId: 'evt-infra',
  alertId: 'alert-infra',
})

test("a VPS outage's three alerts make one incident Issue, and their ups heal it", async () => {
  for (const [source, monitor] of [
    ['kuma', 'vps - Push'],
    ['hyperdx', 'API error rate'],
    ['hyperdx', INFRA_MONITOR],
  ] as const) {
    expect((await post(server, '/door/routes', { source, monitor, repo: 'vps' })).status).toBe(200)
  }

  // The infra alert first: a ClickStack alert for host.name=mini becomes a signal and an Issue.
  const first = await door.post('hyperdx', infra('ALERT'))
  expect(first).toMatchObject({ status: 200, body: { outcome: 'filed' } })
  const issue = (first.body as { issue: string }).issue

  // Then the app alert and Kuma, through the door.
  const h = await door.post('hyperdx', hyperdx('ALERT'))
  const k = await door.post('kuma', kuma(0, '2026-11-07 10:06:00.000'))
  expect(h).toMatchObject({ status: 200, body: { outcome: 'incident', detail: 'joined', issue } })
  expect(k).toMatchObject({ status: 200, body: { outcome: 'incident', detail: 'joined', issue } })

  const signals = (await get(server, '/v1/signals')).body.signals as {
    source: string
    title: string
    issue: string | null
    state: string
  }[]
  expect(signals.map((s) => s.issue)).toEqual([issue, issue, issue])
  expect(new Set(signals.map((s) => s.source))).toEqual(new Set(['hyperdx', 'kuma']))
  expect(signals.some((s) => s.title === INFRA_MONITOR && s.state === 'filed')).toBe(true)
  // filed + two notes: three applied events, nothing else, and still `settling`
  expect(await observe(world, issue)).toMatchObject({ state: 'settling', outcome: null, version: 3 })

  // The ups: Kuma and the app alert amend, the infra alert recovering heals it.
  expect(await door.post('kuma', kuma(1, '2026-11-07 10:20:00.000'))).toMatchObject({
    body: { outcome: 'amended', detail: 'matched', issue },
  })
  expect(await door.post('hyperdx', hyperdx('OK'))).toMatchObject({
    body: { outcome: 'amended', detail: 'matched', issue },
  })
  expect(await door.post('hyperdx', infra('OK'))).toMatchObject({ status: 200, body: { outcome: 'amended' } })
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
