import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { bearer, freePort, type ServerProcess, startServer, startWorld, type World } from './harness.ts'

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

test('the Console listener starts when the build exists and serves the read slice without any header', async () => {
  expect(server.output()).toContain(`console listening on ${consoleUrl}`)
  expect((await fetch(`${consoleUrl}/v1/overview`)).status).toBe(200)
  expect((await fetch(`${consoleUrl}/health`)).status).toBe(200)
  const index = await fetch(consoleUrl)
  expect(index.status).toBe(200)
  expect(await index.text()).toBe('<title>console</title>')
  // a write that is not one of the nine answers never passes, and the client's own token buys nothing here
  const post = await fetch(`${consoleUrl}/v1/issues`, { method: 'POST', headers: bearer() })
  expect(post.status).toBe(405)
})

const ANSWERS = [
  '/v1/decisions/decision_none/answer',
  '/v1/artifacts/artifact_none/verdict',
  '/v1/artifacts/artifact_none/annotations',
  '/v1/errands/errand_none/done',
  '/v1/errands/errand_none/turn-back',
  '/signals/signal_none/promote',
  '/signals/signal_none/dismiss',
]

const API_REFUSALS = [404, 422]

const write = (path: string, headers: Record<string, string> = {}, body: string = '{}') =>
  fetch(`${consoleUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })

test('the six POST answer verbs reach the API with the body; the API, not the listener, answers', async () => {
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
  const json = { 'content-type': 'application/json' }
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
      headers: json,
      body: method === 'POST' || method === 'PUT' ? '{}' : undefined,
    })
    expect(reply.status, `${method} ${path}`).toBe(405)
    expect(reply.headers.get('allow')).toBe('GET, HEAD')
  }
})

test('a write is refused with the wrong type, cross-site, from a foreign origin and over 64 KiB', async () => {
  const path = ANSWERS[0] ?? ''
  expect((await write(path, { 'content-type': 'text/plain' })).status).toBe(415)
  expect((await write(path, { 'content-type': 'application/x-www-form-urlencoded' }, 'answer=x')).status).toBe(415)
  expect((await fetch(`${consoleUrl}${path}`, { method: 'POST' })).status).toBe(415)
  for (const site of ['cross-site', 'same-site', 'none']) {
    expect((await write(path, { 'sec-fetch-site': site })).status, site).toBe(403)
  }
  expect((await write(path, { origin: 'https://evil.example.com' })).status).toBe(403)
  expect((await write(path, { origin: 'null' })).status).toBe(403)
  expect((await write(path, {}, JSON.stringify({ answer: 'x'.repeat(64 * 1024 + 1) }))).status).toBe(413)
  const ok = JSON.stringify({ answer: 'x'.repeat(60 * 1024) })
  expect(API_REFUSALS).toContain((await write(path, {}, ok)).status)
})

const ANNOTATION = '/v1/artifacts/artifact_none/annotations/annotation_none'

const annotationWrite = (method: 'PATCH' | 'DELETE', headers: Record<string, string> = {}, body?: string) =>
  fetch(`${consoleUrl}${ANNOTATION}`, {
    method,
    headers: method === 'PATCH' ? { 'content-type': 'application/json', ...headers } : headers,
    body: method === 'PATCH' ? (body ?? '{"comment":"x"}') : undefined,
  })

test('an annotation is edited and deleted through the listener, on that path only, with the same guards', async () => {
  for (const method of ['PATCH', 'DELETE'] as const) {
    const reply = await annotationWrite(method)
    expect(API_REFUSALS, method).toContain(reply.status)
    expect(await reply.json(), method).toMatchObject({ code: expect.any(String) })
    for (const site of ['cross-site', 'same-site', 'none']) {
      expect((await annotationWrite(method, { 'sec-fetch-site': site })).status, `${method} ${site}`).toBe(403)
    }
    expect((await annotationWrite(method, { origin: 'https://evil.example.com' })).status, method).toBe(403)
  }
  expect((await annotationWrite('PATCH', { 'content-type': 'text/plain' })).status).toBe(415)
  const big = JSON.stringify({ comment: 'x'.repeat(64 * 1024 + 1) })
  expect((await annotationWrite('PATCH', {}, big)).status).toBe(413)
  const refused: [string, string][] = [
    ['PATCH', '/v1/artifacts/artifact_none/annotations'],
    ['DELETE', '/v1/artifacts/artifact_none/annotations'],
    ['PATCH', '/v1/artifacts/artifact_none/annotations/annotation_none/extra'],
    ['DELETE', '/v1/artifacts/artifact_none'],
    ['PATCH', '/v1/artifacts/artifact_none/verdict'],
    ['PUT', ANNOTATION],
    ['POST', ANNOTATION],
    ['OPTIONS', ANNOTATION],
    ['PATCH', '/v1/issues/issue_1'],
  ]
  for (const [method, path] of refused) {
    const reply = await fetch(`${consoleUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' || method === 'OPTIONS' ? undefined : '{}',
    })
    expect(reply.status, `${method} ${path}`).toBe(405)
  }
})

test('the main port is unchanged: it still wants a token, and an open Console buys nothing', async () => {
  expect((await fetch(`${server.url}/v1/overview`)).status).toBe(401)
  expect((await fetch(`${server.url}/v1/overview`, { headers: bearer() })).status).toBe(200)
})
