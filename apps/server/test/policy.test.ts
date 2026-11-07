import { describe, expect, test } from 'bun:test'
import * as z from 'zod'
import { createApp, OPENAPI_PATH } from '../src/api/app.ts'
import { type Caller, POLICY, ruleFor } from '../src/api/policy.ts'

const TOKENS = {
  owner: 'owner-token-0123456789',
  agent: 'agent-token-0123456789',
  machine: 'door-token-0123456789',
  signal: 'signal-token-0123456789',
  read: 'read-token-0123456789',
}
const app = createApp({
  tokens: TOKENS,
  docs: true,
  health: { read: () => Promise.reject(new Error('unused')) },
  log: () => {},
})

const Document = z.object({ paths: z.record(z.string(), z.record(z.string(), z.unknown())) })
const METHODS = ['get', 'post', 'put', 'patch', 'delete']

/** Every (METHOD, Elysia route) of the document. The slot routes are hidden from it and added by hand. */
async function routes(): Promise<{ method: string; route: string }[]> {
  const response = await app.handle(new Request(`http://localhost${OPENAPI_PATH}`))
  const doc = Document.parse(await response.json())
  const found = Object.entries(doc.paths).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((method) => METHODS.includes(method))
      .map((method) => ({ method: method.toUpperCase(), route: path.replace(/\{([^}]+)\}/g, ':$1') })),
  )
  return [...found, { method: 'PUT', route: '/slots/:id' }, { method: 'DELETE', route: '/slots/:id' }]
}

const allowed = (method: string, route: string): readonly Caller[] | 'public' => {
  const rule = ruleFor(method, route)
  if (!rule) throw new Error(`no policy row for ${method} ${route}`)
  return rule.callers
}

describe('the policy table', () => {
  test('has a row for every route of the OpenAPI document', async () => {
    const found = await routes()
    expect(found.length).toBeGreaterThan(30)
    const missing = found.filter(({ method, route }) => !ruleFor(method, route))
    expect(missing).toEqual([])
  })

  test('only GET /health is public', async () => {
    const open = (await routes()).filter(({ method, route }) => allowed(method, route) === 'public')
    expect(open).toEqual([{ method: 'GET', route: '/health' }])
  })

  test('the owner is on every row that is not public', () => {
    for (const rule of POLICY) if (rule.callers !== 'public') expect(rule.callers).toContain('owner')
  })

  test('the read token is refused on every route that is not a GET /v1 read', async () => {
    for (const { method, route } of await routes()) {
      const callers = allowed(method, route)
      if (callers === 'public' || !callers.includes('read')) continue
      expect({ method, v1: route.startsWith('/v1/') }).toEqual({ method: 'GET', v1: true })
    }
  })

  test('the read token cannot read the whole text of a Decision, an artifact or a page', () => {
    for (const route of ['/v1/decisions', '/v1/decisions/:id', '/v1/artifacts', '/v1/artifacts/:id', '/v1/pages']) {
      expect(allowed('GET', route)).not.toContain('read')
      expect(allowed('GET', route)).toContain('agent')
    }
  })

  test('the machine is allowed on exactly POST /signals/alerts and POST /door/reports', async () => {
    const machine = (await routes())
      .filter(({ method, route }) => {
        const callers = allowed(method, route)
        return callers !== 'public' && callers.includes('machine')
      })
      .map(({ method, route }) => `${method} ${route}`)
    expect(machine.sort()).toEqual(['POST /door/reports', 'POST /signals/alerts'])
  })

  test('the signal token is allowed on exactly POST /signals', async () => {
    const signal = (await routes())
      .filter(({ method, route }) => {
        const callers = allowed(method, route)
        return callers !== 'public' && callers.includes('signal')
      })
      .map(({ method, route }) => `${method} ${route}`)
    expect(signal).toEqual(['POST /signals'])
  })

  test('an agent is not allowed on an owner verb', () => {
    for (const [method, route] of [
      ['POST', '/issues/:id/reopen'],
      ['POST', '/v1/decisions/:id/answer'],
      ['POST', '/v1/artifacts/:id/verdict'],
      ['POST', '/v1/artifacts/:id/annotations'],
      ['POST', '/v1/errands/:id/done'],
      ['GET', '/v1/errands'],
      ['POST', '/signals/:id/promote'],
      ['POST', '/issues'],
      ['POST', '/issues/:id/cancel'],
      ['POST', '/issues/:id/note'],
      ['POST', '/issues/:id/answer'],
      ['POST', '/issues/:id/prio'],
      ['PUT', '/queue'],
      ['POST', '/v1/loops/:name/run'],
    ] as const) {
      expect(allowed(method, route)).toEqual(['owner'])
    }
  })

  test('a lead may call a session note but no owner verb of the Issue', () => {
    expect(allowed('POST', '/v1/sessions/:session/note')).toEqual(['owner', 'agent'])
    expect(allowed('POST', '/issues/:id/ship')).toEqual(['owner', 'agent'])
  })

  test('a route without a row has no entry', () => {
    expect(ruleFor('POST', '/v1/brand-new')).toBeUndefined()
    expect(ruleFor('DELETE', '/health')).toBeUndefined()
  })
})

describe('the auth plugin over HTTP', () => {
  const call = (method: string, path: string, token?: string) =>
    app.handle(
      new Request(`http://localhost${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} }),
    )

  test('no token and an unknown token are 401 unauthorized', async () => {
    for (const token of [undefined, 'nope-nope-nope-nope']) {
      const response = await call('GET', '/v1/loops', token)
      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({ code: 'unauthorized' })
    }
  })

  test('an unknown route is 401 without a token and 404 with one', async () => {
    for (const path of ['/spawns', '/v1/nowhere']) {
      const stranger = await call('GET', path)
      expect(stranger.status).toBe(401)
      expect(await stranger.json()).toMatchObject({ code: 'unauthorized' })
      expect((await call('GET', path, TOKENS.owner)).status).toBe(404)
    }
  })

  test('a token that is not a bearer is 401', async () => {
    const response = await app.handle(
      new Request('http://localhost/v1/loops', { headers: { authorization: TOKENS.owner } }),
    )
    expect(response.status).toBe(401)
  })

  test('a caller the row does not list is 403 forbidden', async () => {
    const response = await call('POST', '/v1/loops/steward/run', TOKENS.agent)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'forbidden' })
    expect((await call('GET', '/capacity', TOKENS.read)).status).toBe(403)
    expect((await call('POST', '/signals/alerts', TOKENS.read)).status).toBe(403)
    expect((await call('POST', '/issues/issue_1/reopen', TOKENS.machine)).status).toBe(403)
    for (const [method, path] of [
      ['GET', '/v1/loops'],
      ['POST', '/issues'],
      ['POST', '/signals/alerts'],
      ['POST', '/v1/issues/issue_1/close'],
    ] as const) {
      expect((await call(method, path, TOKENS.signal)).status).toBe(403)
    }
  })

  test('a listed caller passes the plugin (the unwired route answers 503)', async () => {
    for (const caller of ['owner', 'agent', 'read'] as const) {
      expect((await call('GET', '/v1/loops', TOKENS[caller])).status).toBe(503)
    }
    expect((await call('POST', '/v1/loops/steward/run', TOKENS.owner)).status).toBe(503)
    expect((await call('POST', '/signals', TOKENS.signal)).status).not.toBe(403)
  })

  test('GET /health needs no token', async () => {
    expect((await call('GET', '/health')).status).not.toBe(401)
  })

  test('the OpenAPI document is public only when docs is on', async () => {
    expect((await call('GET', OPENAPI_PATH)).status).toBe(200)
    const prod = createApp({ tokens: TOKENS, health: { read: () => Promise.reject(new Error('unused')) } })
    const authorized = { headers: { authorization: `Bearer ${TOKENS.owner}` } }
    expect((await prod.handle(new Request(`http://localhost${OPENAPI_PATH}`, authorized))).status).toBe(404)
  })
})
