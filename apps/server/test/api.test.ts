import { describe, expect, test } from 'bun:test'
import { ErrorBody, Health } from '@software-factory/contract'
import * as z from 'zod'
import { createApp, OPENAPI_PATH } from '../src/api/app.ts'
import { healthOf } from '../src/read/health.ts'

const ok = healthOf({ version: 'abc123', databaseFailure: null, tickAt: null, queueMovedAt: null })
const down = healthOf({
  version: 'abc123',
  databaseFailure: 'the database failed: gone',
  tickAt: null,
  queueMovedAt: null,
})

const appWith = (health: Health) => createApp({ health: { read: async () => health }, docs: true, log: () => {} })

// Elysia's router finds the path at a fixed offset: a URL as short as `http://x/…` answers 404 for every route.
const get = (app: { handle(request: Request): Promise<Response> }, path: string) =>
  app.handle(new Request(`http://localhost${path}`))

/** The parts of OpenAPI 3 the CLI generator relies on, checked structurally. */
const OpenApiDocument = z.object({
  openapi: z.string().regex(/^3\.\d+\.\d+$/),
  info: z.object({ title: z.string(), version: z.string() }),
  paths: z.record(
    z.string().startsWith('/'),
    z.record(
      z.string(),
      z.object({
        operationId: z.string().optional(),
        responses: z.record(
          z.string().regex(/^\d{3}$/),
          z.object({
            description: z.string(),
            content: z.record(z.string(), z.object({ schema: z.record(z.string(), z.unknown()) })).optional(),
          }),
        ),
      }),
    ),
  ),
})

describe('GET /health', () => {
  test('answers 200 with the contract shape when the database answers', async () => {
    const response = await get(appWith(ok), '/health')
    expect(response.status).toBe(200)
    expect(Health.parse(await response.json())).toEqual({
      status: 'ok',
      version: 'abc123',
      reason: null,
      heartbeat: { ok: true, reason: null, tickAt: null, queueMovedAt: null },
      lines: [],
      loops: [],
    })
  })

  test('answers 503 in the same shape, with the reason in the heartbeat the pusher reads', async () => {
    const response = await get(appWith(down), '/health')
    expect(response.status).toBe(503)
    const body = Health.parse(await response.json())
    expect(body.heartbeat).toEqual({ ok: false, reason: 'the database failed: gone', tickAt: null, queueMovedAt: null })
  })
})

describe('errors', () => {
  test('an unknown route is a 404 ErrorBody', async () => {
    const response = await get(appWith(ok), '/nope')
    expect(response.status).toBe(404)
    expect(ErrorBody.parse(await response.json()).code).toBe('not_found')
  })

  // Elysia 1.4 answers a response that fails its zod schema with 422; the server maps it to its own bug, a 500.
  test('an answer the contract refuses is a 500 with code invalid_response', async () => {
    const response = await get(appWith({ status: 'sideways' } as unknown as Health), '/health')
    expect(response.status).toBe(500)
    expect(ErrorBody.parse(await response.json()).code).toBe('invalid_response')
  })

  test('a request the contract refuses is a 422 that names the fields', async () => {
    const owner = 'o'.repeat(16)
    const app = createApp({ tokens: { owner }, health: { read: async () => ok }, log: () => {} })
    const response = await app.handle(
      new Request('http://localhost/v1/issues/issue_1/close', {
        method: 'POST',
        body: '{"attempt":1}',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${owner}` },
      }),
    )
    expect(response.status).toBe(422)
    const body = ErrorBody.parse(await response.json())
    expect(body.code).toBe('invalid_request')
    expect(body.details?.fields).toEqual(['outcome', 'reason'])
  })
})

describe('the OpenAPI document', () => {
  test('parses as OpenAPI 3 and holds /health with the Health schema for 200 and 503', async () => {
    const response = await get(appWith(ok), OPENAPI_PATH)
    expect(response.status).toBe(200)
    const doc = OpenApiDocument.parse(await response.json())
    const operation = doc.paths['/health']?.get
    expect(operation?.operationId).toBe('health.get')
    for (const status of ['200', '503']) {
      const schema = operation?.responses[status]?.content?.['application/json']?.schema
      expect(schema?.$ref).toBe('#/$defs/Health')
      expect(Object.keys(z.record(z.string(), z.unknown()).parse(schema?.$defs))).toEqual(['Health', 'Heartbeat', 'HealthLine', 'HealthLoop'])
    }
  })
})

describe('the OpenAPI document', () => {
  test('is not served unless docs is on', async () => {
    const app = createApp({ health: { read: async () => ok }, log: () => {} })
    expect((await get(app, OPENAPI_PATH)).status).toBe(404)
  })
})

describe('the internal test routes', () => {
  test('do not exist unless mounted, and are never in the OpenAPI document', async () => {
    const owner = 'o'.repeat(16)
    const app = createApp({ tokens: { owner }, health: { read: async () => ok }, docs: true, log: () => {} })
    const response = await app.handle(
      new Request('http://localhost/internal/test/issues', {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${owner}` },
      }),
    )
    expect(response.status).toBe(404)
    const document = OpenApiDocument.parse(await (await get(app, OPENAPI_PATH)).json())
    expect(Object.keys(document.paths).some((path) => path.startsWith('/internal'))).toBe(false)
  })
})
