import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { liveAccounts, loadRegistry } from '@software-factory/accounts'
import { ReadAccountList } from '@software-factory/contract'
import { createApp } from '../../src/api/app.ts'
import type { CapacityApi } from '../../src/api/capacity.ts'
import { deskAccountSource, packageAccountDesk } from '../../src/adapters/planning/accounts-source.ts'
import { accountsView, clearAccountMode, setAccountMode } from '../../src/app/accounts-view.ts'
import { admissionPass, refreshAccounts } from '../../src/app/capacity-admit.ts'
import { syncProjects } from '../../src/app/planning-sync.ts'
import { account, startWorld, value, type World } from '../planning/support.ts'
import { accountsFixture, cleanFixtures, NOW } from './accounts-fixture.ts'

const OWNER = 'owner-token-0123456789'
const AGENT = 'agent-token-0123456789'
const READER = 'read-token-0123456789'

let world: World
let app: ReturnType<typeof createApp>
let paths: ReturnType<typeof accountsFixture>

beforeAll(async () => {
  world = await startWorld()
  await world.reset()
  paths = accountsFixture({ a: { w: 20 }, b: { w: 40 }, c: { w: 60 }, d: { w: 10 } })
  world.clock.set(NOW)
  world.source.add('solo', {
    project: { state: 'text' as const, sha: 'sha-solo', value: { apiVersion: 'factory/v2', name: 'solo', leads: 1 } },
  })
  value(await syncProjects(world.deps, { fetch: false }))
  const deps = { ...world.deps, desk: packageAccountDesk({ paths }) }
  const capacity = {
    accounts: () => accountsView(deps),
    setAccountMode: (account: string, body: Parameters<CapacityApi['setAccountMode']>[1]) =>
      setAccountMode(deps, account, body),
    clearAccountMode: (account: string) => clearAccountMode(deps, account),
  } as unknown as CapacityApi
  app = createApp({
    tokens: { owner: OWNER, agent: AGENT, read: READER },
    health: { read: () => Promise.reject(new Error('unused')) },
    capacity,
  })
})
afterAll(async () => {
  cleanFixtures()
  await world.stop()
})

const call = (method: string, path: string, token: string, body?: unknown) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  )

describe('GET /v1/accounts', () => {
  test("is the package's status with the seats and the leads running beside it", async () => {
    world.accounts.rows = [account('a'), account('b')]
    const one = await world.queued({ repo: 'solo' })
    const pass = value(await admissionPass(world.deps))
    expect(pass.queue.map((e) => e.reason)).toEqual([])
    expect(pass.admitted.map((a) => a.issue)).toEqual([one])
    const response = await call('GET', '/v1/accounts', READER)
    expect(response.status).toBe(200)
    // oxlint-disable-next-line typescript/no-explicit-any -- the test reads fields of an answer the contract already guarantees
    const body = (await response.json()) as any
    // the Console still reads this URL as the cards' list: the answer is a superset of it
    expect(() => ReadAccountList.parse(body)).not.toThrow()
    expect(body).toMatchObject({ schema: 1, machine: expect.any(String), default_account: 'iu' })
    expect(body.lanes).toContain('bulk')
    const a = body.accounts.find((row: { id: string }) => row.id === 'a')
    expect(a).toMatchObject({
      id: 'a',
      plan: 'max',
      enabled: true,
      seats: { cap: 2, taken: 1, free: 1 },
      leads: [one],
      account: 'a',
      fresh: true,
    })
    expect(a.lanes.bulk).toMatchObject({ open: true })
    // an account in the package's registry that no poll has stored is listed with its seats and no card fields
    expect(body.accounts.find((row: { id: string }) => row.id === 'd')).toMatchObject({
      seats: { cap: 2, taken: 0, free: 2 },
      leads: [],
      fresh: false,
      rank: null,
    })
  })
})

describe('POST and DELETE /v1/accounts/:id/mode', () => {
  const modeOf = async (id: string) =>
    // oxlint-disable-next-line typescript/no-explicit-any -- the test reads fields of an answer the contract already guarantees
    ((await (await call('GET', '/v1/accounts', OWNER)).json()) as any).accounts.find(
      (row: { id: string }) => row.id === id,
    )

  test('the owner sets a mode that claude-account sees, and clears it again', async () => {
    const set = await call('POST', '/v1/accounts/b/mode', OWNER, {
      mode: 'paused',
      until: '2026-11-20T12:00:00Z',
      why: 'a test',
    })
    expect(set.status).toBe(200)
    expect(await set.json()).toMatchObject({
      account: 'b',
      mode: { kind: 'paused', source: 'override', until: '2026-11-20T12:00:00Z', why: 'a test' },
    })
    expect((await modeOf('b')).lanes.bulk).toMatchObject({ open: false, closed: 'paused' })
    const seen = liveAccounts(loadRegistry(paths.registry), NOW.getTime(), paths).views
    expect(seen.b?.mode.kind).toBe('paused')
    const cleared = await call('DELETE', '/v1/accounts/b/mode', OWNER)
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toMatchObject({ account: 'b', mode: { kind: 'normal', source: 'registry' } })
    expect((await modeOf('b')).lanes.bulk).toMatchObject({ open: true })
  })

  test('the stored verdict follows the override at once: no lead on an account just paused', async () => {
    const desk = packageAccountDesk({ paths })
    const deps = { ...world.deps, accounts: deskAccountSource(desk), desk }
    const openOf = async () =>
      (
        await world.db.sql`SELECT bulk_open FROM factory.capacity_readings WHERE account = 'c' ORDER BY id DESC LIMIT 1`
      )[0]?.bulk_open
    value(await refreshAccounts(deps)) // a poll stores every account of the fixture as the package judges it
    expect(await openOf()).toBe(true)
    value(await setAccountMode(deps, 'c', { mode: 'paused', until: '2026-11-20T12:00:00Z' }))
    expect(await openOf()).toBe(false)
    value(await clearAccountMode(deps, 'c'))
    expect(await openOf()).toBe(true)
  })

  test('a request the package refuses is 422 with its words', async () => {
    const past = await call('POST', '/v1/accounts/a/mode', OWNER, { mode: 'paused', until: '2026-11-01T00:00:00Z' })
    expect(past.status).toBe(422)
    expect(await past.json()).toMatchObject({ code: 'refused', error: expect.stringContaining('already past') })
    expect((await call('POST', '/v1/accounts/nope/mode', OWNER, { mode: 'paused' })).status).toBe(422)
    expect((await call('POST', '/v1/accounts/a/mode', OWNER, { mode: 'sleep' })).status).toBe(422)
  })

  test('a lead and the read token may not set or clear a mode', async () => {
    for (const token of [AGENT, READER]) {
      expect((await call('POST', '/v1/accounts/a/mode', token, { mode: 'paused' })).status).toBe(403)
      expect((await call('DELETE', '/v1/accounts/a/mode', token)).status).toBe(403)
    }
  })
})
