import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { bearer, freePort, type ServerProcess, startServer, startWorld, type World } from './harness.ts'

const OWNER = 'owner@example.com'

let world: World
let server: ServerProcess
let dir = ''
let consoleUrl = ''

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-console-scenario-')
  await writeFile(join(dir, 'index.html'), '<title>console</title>')
  const port = await freePort()
  consoleUrl = `http://127.0.0.1:${port}`
  world = await startWorld()
  server = await startServer(world, {
    env: {
      FACTORY_CONSOLE_OWNER_LOGIN: OWNER,
      FACTORY_CONSOLE_PORT: String(port),
      FACTORY_CONSOLE_DIR: dir,
    },
  })
})

afterAll(async () => {
  await server.stop()
  await world.stop()
  await rm(dir, { recursive: true, force: true })
})

test('the Console listener refuses a request without the owner login and serves the read slice with it', async () => {
  expect(server.output()).toContain(`console listening on ${consoleUrl}`)
  const without = await fetch(`${consoleUrl}/v1/overview`)
  expect(without.status).toBe(403)
  expect(await without.json()).toMatchObject({ code: 'forbidden' })
  expect(
    (await fetch(`${consoleUrl}/v1/overview`, { headers: { 'tailscale-user-login': 'other@example.com' } })).status,
  ).toBe(403)

  const owner = { 'tailscale-user-login': OWNER }
  expect((await fetch(`${consoleUrl}/v1/overview`, { headers: owner })).status).toBe(200)
  expect((await fetch(`${consoleUrl}/health`, { headers: owner })).status).toBe(200)
  const index = await fetch(consoleUrl, { headers: owner })
  expect(index.status).toBe(200)
  expect(await index.text()).toBe('<title>console</title>')
  // a write never passes, and the client's own token buys nothing here
  const post = await fetch(`${consoleUrl}/v1/issues`, { method: 'POST', headers: { ...owner, ...bearer() } })
  expect(post.status).toBe(405)
})

test('the main port is unchanged: it still wants a token and the login header buys nothing', async () => {
  expect((await fetch(`${server.url}/v1/overview`)).status).toBe(401)
  expect((await fetch(`${server.url}/v1/overview`, { headers: { 'tailscale-user-login': OWNER } })).status).toBe(401)
  expect((await fetch(`${server.url}/v1/overview`, { headers: bearer() })).status).toBe(200)
})
