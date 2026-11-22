import { expect, test } from 'bun:test'
import { createApp } from '../src/api/app.ts'
import type { ApiRefusal } from '../src/api/refusals.ts'
import type { ReadApi } from '../src/read/reader.ts'
import { healthOf } from '../src/read/health.ts'

const health = {
  read: async () => healthOf({ version: 'test', databaseFailure: null, tickAt: null, queueMovedAt: null }),
}
const tokens = { owner: 'owner-secret', agent: 'agent-secret' }

/** An app whose refusals land in a list; `read` knows no Issue, so an unknown id is the handler's own 404. */
function counted() {
  const refusals: ApiRefusal[] = []
  const read = { issue: async () => null } as unknown as ReadApi
  const app = createApp({ health, tokens, read, log: () => {}, refusals: (refusal) => refusals.push(refusal) })
  const call = (path: string, token: string | null, init: RequestInit = {}) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
      }),
    )
  // the count is written after the answer is sent
  const settled = async () => {
    await Bun.sleep(10)
    return refusals
  }
  return { call, settled }
}

test('a 422, a 403, a 404 and a 401 are counted by operation, caller and status, and no value is kept', async () => {
  const { call, settled } = counted()
  expect((await call('/v1/issues?state=nonsense&limit=987654', 'owner-secret')).status).toBe(422)
  expect(
    (await call('/issues', 'agent-secret', { method: 'POST', body: '{"text":"a private sentence"}' })).status,
  ).toBe(403)
  expect((await call('/v1/issues/issue_99999', 'owner-secret')).status).toBe(404)
  expect((await call('/v1/issues', null)).status).toBe(401)
  expect((await call('/v1/issues', 'owner-secret')).status).not.toBe(422)

  const rows = await settled()
  expect(rows.map(({ operation, caller, status }) => ({ operation, caller, status }))).toEqual([
    { operation: 'issue.list', caller: 'owner', status: 422 },
    { operation: 'issue.new', caller: 'agent', status: 403 },
    { operation: 'issue.show', caller: 'owner', status: 404 },
    { operation: 'issue.list', caller: 'none', status: 401 },
  ])
  expect(rows[0]?.fields).toEqual(expect.arrayContaining(['state', 'limit']))
  expect(rows.slice(1).every((row) => row.fields.length === 0)).toBe(true)
  // what a caller sent, and the tokens, are in no row
  const stored = JSON.stringify(rows)
  for (const value of ['nonsense', '987654', 'private sentence', 'owner-secret', 'agent-secret']) {
    expect(stored).not.toContain(value)
  }
})

test('a path no route has is counted as the operation unknown; an answer that is not a 4xx counts nothing', async () => {
  const { call, settled } = counted()
  expect((await call('/v1/nothing-here-99', 'owner-secret')).status).toBe(404)
  expect((await call('/health', null)).status).toBe(200)
  const rows = await settled()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ operation: 'unknown', caller: 'owner', status: 404, fields: [] })
})

test('a sink that throws changes no answer', async () => {
  const app = createApp({
    health,
    tokens,
    log: () => {},
    refusals: () => {
      throw new Error('sink down')
    },
  })
  const answer = await app.handle(
    new Request('http://localhost/v1/nothing-here', { headers: { authorization: 'Bearer owner-secret' } }),
  )
  expect(answer.status).toBe(404)
})
