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
  // a write that is not one of the five answers never passes, and the client's own token buys nothing here
  const post = await fetch(`${consoleUrl}/v1/issues`, { method: 'POST', headers: { ...owner, ...bearer() } })
  expect(post.status).toBe(405)
})

const ANSWERS = [
  '/v1/decisions/decision_none/answer',
  '/v1/artifacts/artifact_none/verdict',
  '/v1/artifacts/artifact_none/annotations',
  '/v1/errands/errand_none/done',
  '/signals/signal_none/promote',
]

const API_REFUSALS = [404, 422]

const write = (path: string, headers: Record<string, string> = {}, body: string = '{}', login = true) =>
  fetch(`${consoleUrl}${path}`, {
    method: 'POST',
    headers: { ...(login ? { 'tailscale-user-login': OWNER } : {}), 'content-type': 'application/json', ...headers },
    body,
  })

test('the five answer verbs reach the API with the body; the API, not the listener, answers', async () => {
  for (const path of ANSWERS) {
    const reply = await write(path)
    // the API's own refusal of an unknown id or an empty answer, with its ErrorBody
    expect(API_REFUSALS, path).toContain(reply.status)
    expect(await reply.json(), path).toMatchObject({ code: expect.any(String) })
  }
  // a same-origin browser request: fetch metadata and an origin that is the listener's own host
  const browser = await write(ANSWERS[0] ?? '', {
    'sec-fetch-site': 'same-origin',
    origin: consoleUrl,
    host: new URL(consoleUrl).host,
  })
  expect(API_REFUSALS).toContain(browser.status)
  // the client's own authorization is dropped: forwarded, a wrong token would be a 401
  expect(API_REFUSALS).toContain(
    (await write(ANSWERS[0] ?? '', { authorization: 'Bearer not-the-owner-token' })).status,
  )
})

test('everything else that writes stays 405, OPTIONS too', async () => {
  const owner = { 'tailscale-user-login': OWNER, 'content-type': 'application/json' }
  const refused: [string, string][] = [
    ['POST', '/v1/issues'],
    ['POST', '/v1/issues/issue_1/cancel'],
    ['POST', '/v1/issues/issue_1/reopen'],
    ['POST', '/v1/issues/issue_1/ask'],
    ['POST', '/signals'],
    ['POST', '/v1/decisions/decision_none/worth-asking'],
    ['POST', '/v1/decisions/decision_none/answer/extra'],
    ['PUT', '/v1/decisions/decision_none/answer'],
    ['DELETE', '/v1/errands/errand_none/done'],
    ['OPTIONS', '/v1/decisions/decision_none/answer'],
    ['POST', '/'],
  ]
  for (const [method, path] of refused) {
    const reply = await fetch(`${consoleUrl}${path}`, {
      method,
      headers: owner,
      body: method === 'POST' || method === 'PUT' ? '{}' : undefined,
    })
    expect(reply.status, `${method} ${path}`).toBe(405)
    expect(reply.headers.get('allow')).toBe('GET, HEAD')
  }
})

test('a write is refused without the login, with the wrong type, cross-site, from a foreign origin and over 64 KiB', async () => {
  const path = ANSWERS[0] ?? ''
  expect((await write(path, {}, '{}', false)).status).toBe(403)
  expect((await write(path, { 'tailscale-user-login': 'other@example.com' })).status).toBe(403)
  expect((await write(path, { 'content-type': 'text/plain' })).status).toBe(415)
  expect((await write(path, { 'content-type': 'application/x-www-form-urlencoded' }, 'answer=x')).status).toBe(415)
  expect(
    (await fetch(`${consoleUrl}${path}`, { method: 'POST', headers: { 'tailscale-user-login': OWNER } })).status,
  ).toBe(415)
  for (const site of ['cross-site', 'same-site', 'none']) {
    expect((await write(path, { 'sec-fetch-site': site })).status, site).toBe(403)
  }
  expect((await write(path, { origin: 'https://evil.example.com' })).status).toBe(403)
  expect((await write(path, { origin: 'null' })).status).toBe(403)
  expect((await write(path, {}, JSON.stringify({ answer: 'x'.repeat(64 * 1024 + 1) }))).status).toBe(413)
  const ok = JSON.stringify({ answer: 'x'.repeat(60 * 1024) })
  expect(API_REFUSALS).toContain((await write(path, {}, ok)).status)
})

test('the main port is unchanged: it still wants a token and the login header buys nothing', async () => {
  expect((await fetch(`${server.url}/v1/overview`)).status).toBe(401)
  expect((await fetch(`${server.url}/v1/overview`, { headers: { 'tailscale-user-login': OWNER } })).status).toBe(401)
  expect((await fetch(`${server.url}/v1/overview`, { headers: bearer() })).status).toBe(200)
})
