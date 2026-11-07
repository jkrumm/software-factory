import { afterAll, beforeAll, expect, test } from 'bun:test'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { startWorld, type ServerProcess, type World } from '../harness.ts'
import { type Door, type Estate, get, makeEstate, post, startDoor, startIntakeServer, until } from './support.ts'

/** A heal rule settles a `down` before any lead: the grace, the runbook outside any transaction, nothing filed when the source comes back. */
let world: World
let estate: Estate
let server: ServerProcess
let door: Door
let repoDir: string

beforeAll(async () => {
  world = await startWorld()
  estate = await makeEstate(world, [
    { repo: 'argo', heal: [{ when: 'kuma.down', graceMs: 1500, runbook: 'make restart', max: 1 }] },
    { repo: 'vps', heal: [{ when: 'kuma.down', graceMs: 1500, runbook: 'make restart', max: 1 }] },
  ])
  repoDir = await estate.repo('argo', { makefile: 'restart:\n\ttouch restarted\n' })
  // vps has no Makefile: its rule cannot run, and the down files after the grace.
  await estate.repo('vps')
  server = await startIntakeServer(world, estate)
  door = await startDoor(estate, server, ['kuma'])
})

afterAll(async () => {
  await door.stop()
  await server.stop()
  await estate.stop()
  await world.stop()
})

const kuma = (name: string, status: 0 | 1, time: string) => ({
  msg: 'x',
  monitor: { name, type: 'http', hostname: null, port: null },
  heartbeat: { status, time, msg: status === 0 ? 'timeout' : 'ok', ping: null, retries: 1 },
})

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

test('a heal runbook that fixes the symptom files nothing', async () => {
  await post(server, '/door/routes', { source: 'kuma', monitor: 'web', repo: 'argo' })
  const down = await door.post('kuma', kuma('web', 0, '2026-11-07 09:00:00.000'))
  expect(down).toMatchObject({ status: 200, body: { outcome: 'held', detail: 'settling', issue: null } })
  expect((await door.post('kuma', kuma('web', 0, '2026-11-07 09:00:00.000'))).body).toMatchObject({
    detail: 'settling',
  })

  // After the grace the settle pass runs `make restart` in the repo, outside any transaction.
  await until('the runbook to run', () => exists(join(repoDir, 'restarted')))

  // The restart fixed it: the source's own up arrives, and no lead ever starts.
  const up = await door.post('kuma', kuma('web', 1, '2026-11-07 09:00:30.000'))
  expect(up).toMatchObject({ status: 200, body: { outcome: 'dropped', detail: 'healed' } })
  await Bun.sleep(3500)
  expect((await get(server, '/v1/signals')).body.signals).toEqual([])
  // a late retry of the down that healed opens no second row
  expect((await door.post('kuma', kuma('web', 0, '2026-11-07 09:00:00.000'))).body).toMatchObject({
    outcome: 'dropped',
    detail: 'replayed',
  })
}, 30000)

test('a rule that cannot run files the down once its grace is over', async () => {
  await post(server, '/door/routes', { source: 'kuma', monitor: 'api', repo: 'vps' })
  expect((await door.post('kuma', kuma('api', 0, '2026-11-07 09:10:00.000'))).body).toMatchObject({
    outcome: 'held',
    detail: 'settling',
  })
  const filed = await until('the down to be filed', async () => {
    const signals = (await get(server, '/v1/signals')).body.signals as { source: string; issue: string | null }[]
    return signals.find((s) => s.source === 'kuma' && s.issue)
  })
  expect(filed).toMatchObject({ state: 'filed' })
}, 30000)
