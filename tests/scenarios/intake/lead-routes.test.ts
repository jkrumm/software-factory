import { afterAll, beforeAll, expect, test } from 'bun:test'
import { bearer, startWorld, type ServerProcess, type World } from '../harness.ts'
import { type Estate, get, makeEstate, post, startIntakeServer } from './support.ts'

/** A lead's token (the agent caller) routes monitors to its own Issue's repo only; the owner's token keeps every route. */
let world: World
let estate: Estate
let server: ServerProcess
let argoIssue: string

beforeAll(async () => {
  world = await startWorld()
  estate = await makeEstate(world, [{ repo: 'argo' }, { repo: 'vps' }])
  server = await startIntakeServer(world, estate)
  const filed = await post(server, '/signals', { from: 'owner:hermes', repo: 'argo', title: 'The login page crashes' })
  argoIssue = filed.body.issue
})

afterAll(async () => {
  await server.stop()
  await estate.stop()
  await world.stop()
})

const asLead = async (path: string, body: unknown) => {
  const response = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { ...bearer('agent'), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

const routeOf = async (monitor: string) =>
  ((await get(server, '/door/routes')).body.routes as { monitor: string; repo: string; setBy: string }[]).find(
    (route) => route.monitor === monitor,
  )

test('a lead routes a monitor to its own Issue repo, and the route records who set it', async () => {
  const set = await asLead('/door/routes', { source: 'kuma', monitor: 'argo-web', repo: 'argo', issue: argoIssue })
  expect(set.status).toBe(200)
  expect(await routeOf('argo-web')).toMatchObject({ repo: 'argo', setBy: `lead:${argoIssue}` })
})

test('a lead cannot route to another repo, or without naming its Issue', async () => {
  const other = await asLead('/door/routes', { source: 'kuma', monitor: 'vps-web', repo: 'vps', issue: argoIssue })
  expect(other.status).toBe(403)
  const bare = await asLead('/door/routes', { source: 'kuma', monitor: 'argo-api', repo: 'argo' })
  expect(bare.status).toBe(403)
  const unknown = await asLead('/door/routes', {
    source: 'kuma',
    monitor: 'argo-api',
    repo: 'argo',
    issue: 'issue_999',
  })
  expect(unknown.status).toBe(404)
  expect(await routeOf('vps-web')).toBeUndefined()
  expect(await routeOf('argo-api')).toBeUndefined()
})

test("a lead cannot overwrite or remove another repo's route, but removes its own", async () => {
  expect((await post(server, '/door/routes', { source: 'kuma', monitor: 'shop', repo: 'vps' })).status).toBe(200)
  expect(await routeOf('shop')).toMatchObject({ repo: 'vps', setBy: 'owner' })
  const overwrite = await asLead('/door/routes', { source: 'kuma', monitor: 'shop', repo: 'argo', issue: argoIssue })
  expect(overwrite.status).toBe(403)
  const remove = await asLead('/door/routes/remove', { source: 'kuma', monitor: 'shop', issue: argoIssue })
  expect(remove.status).toBe(403)
  expect(await routeOf('shop')).toMatchObject({ repo: 'vps' })

  const own = await asLead('/door/routes/remove', { source: 'kuma', monitor: 'argo-web', issue: argoIssue })
  expect(own.status).toBe(200)
  expect(await routeOf('argo-web')).toBeUndefined()
})

test('the owner routes any repo, and the route says owner', async () => {
  expect((await post(server, '/door/routes', { source: 'kuma', monitor: 'any', repo: 'vps' })).status).toBe(200)
  expect(await routeOf('any')).toMatchObject({ repo: 'vps', setBy: 'owner' })
})
