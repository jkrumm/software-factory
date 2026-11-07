import { afterAll, beforeAll, expect, test } from 'bun:test'
import { bearer, factory, startWorld, type ServerProcess, type World } from '../harness.ts'
import { type Estate, get, makeEstate, post, startIntakeServer } from './support.ts'

/**
 * The signal-only caller (Hermes' filing): its token files an owner signal as `owner:hermes` and is refused everywhere else,
 * so no surface needs the owner's token to file.
 */
let world: World
let estate: Estate
let server: ServerProcess

beforeAll(async () => {
  world = await startWorld()
  estate = await makeEstate(world, [{ repo: 'argo' }])
  server = await startIntakeServer(world, estate)
})

afterAll(async () => {
  await server.stop()
  await estate.stop()
  await world.stop()
})

const asSignal = (path: string, method = 'POST', body: unknown = {}) =>
  fetch(`${server.url}${path}`, {
    method,
    headers: { ...bearer('signal'), 'content-type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  })

test('the signal token files an owner signal as owner:hermes through the CLI', async () => {
  const filed = await factory(
    world,
    [
      '--format',
      'json',
      'signal',
      'file',
      '--body',
      JSON.stringify({ from: 'owner:hermes', repo: 'argo', title: 'Add dark mode' }),
    ],
    { FACTORY_URL: server.url },
    { as: 'signal' },
  )
  expect(filed.code).toBe(0)
  const out = JSON.parse(filed.out) as { outcome: string; signal: string }
  expect(out.outcome).toBe('filed')
  const stored = (await get(server, '/v1/signals')).body.signals.find((s: { id: string }) => s.id === out.signal)
  expect(stored).toMatchObject({ source: 'owner:hermes', trust: 'owner', repo: 'argo' })
}, 20000)

test('any other from under the signal token is refused, and nothing is stored', async () => {
  const before = (await get(server, '/v1/signals')).body.signals.length
  for (const from of ['owner', 'owner:iris', 'agent:argo', 'feedback:argo']) {
    const response = await asSignal('/signals', 'POST', { from, kind: 'request', repo: 'argo', title: 'x', text: '' })
    expect({ from, status: response.status }).toEqual({ from, status: 403 })
    expect(await response.json()).toMatchObject({ code: 'trust_refused' })
  }
  expect((await get(server, '/v1/signals')).body.signals.length).toBe(before)
}, 20000)

test('the signal token is refused on every other route, reads included', async () => {
  for (const [method, path] of [
    ['GET', '/v1/signals'],
    ['GET', '/v1/overview'],
    ['POST', '/issues'],
    ['POST', '/signals/alerts'],
    ['POST', '/door/reports'],
    ['POST', '/signals/signal_1/promote'],
    ['POST', '/v1/issues/issue_1/close'],
    ['PUT', '/queue'],
    ['GET', '/capacity'],
  ] as const) {
    const response = await asSignal(path, method)
    expect({ method, path, status: response.status }).toEqual({ method, path, status: 403 })
  }
}, 20000)

test('the owner token is unchanged: it files as owner:hermes too', async () => {
  const response = await post(server, '/signals', {
    from: 'owner:hermes',
    kind: 'request',
    repo: 'argo',
    title: 'Another',
    text: '',
  })
  expect(response.status).toBe(200)
}, 20000)
