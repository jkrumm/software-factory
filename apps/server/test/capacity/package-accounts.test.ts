import { afterAll, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { type AccountPaths, liveAccounts, loadRegistry, rank, setModeOverride } from '@software-factory/accounts'
import { deskAccountSource, packageAccountDesk, readingOf } from '../../src/adapters/planning/accounts-source.ts'
import { orderOf, pickAccount } from '../../src/domains/capacity/accounts.ts'
import { value } from '../planning/support.ts'
import { accountsFixture, cleanFixtures, NOW } from './accounts-fixture.ts'

afterAll(cleanFixtures)
let paths: AccountPaths
const world = (...args: Parameters<typeof accountsFixture>) => {
  paths = accountsFixture(...args)
}

async function onSnapshot() {
  const source = deskAccountSource(packageAccountDesk({ paths }))
  const readings = value(await source.read(NOW))
  const picked = pickAccount({
    readings,
    loaded: new Set(),
    leads: new Map(),
    leadsPerAccount: 5,
    now: NOW,
  })
  const { reg, cache } = liveAccounts(loadRegistry(paths.registry), NOW.getTime(), paths)
  const order = rank({ reg, cache, lane: 'bulk', nowMs: NOW.getTime() }).map((e) => e.account)
  return { readings, picked, order }
}

describe("the server admits on the package's verdict, in process", () => {
  test("a drain, a reserve and a paused account: the admitted account is the first open one of the package's bulk rank", async () => {
    world({ a: { w: 20 }, b: { w: 60 }, c: { w: 5 }, d: { w: 5 } }, { d: { kind: 'reserve', for: 'fable' } })
    setModeOverride('b', { kind: 'drain', until: 'reset' }, { nowMs: NOW.getTime(), paths, machine: 'mini' })
    setModeOverride(
      'c',
      { kind: 'paused', until: '2026-11-20T12:00:00Z', why: 'owner' },
      { nowMs: NOW.getTime(), paths, machine: 'mini' },
    )
    const { readings, picked, order } = await onSnapshot()
    expect(order.length).toBeGreaterThan(0)
    expect(order).not.toContain('c')
    expect(picked.picked?.account).toBe(order[0])
    // the same order, as `factory capacity get` shows it, and the closed account says why and when it opens
    expect(orderOf(readings).map((r) => r.account)).toEqual(order)
    const paused = readings.find((r) => r.account === 'c')
    expect(paused).toMatchObject({ open: false, position: null })
    expect(paused?.closedWhy).toContain('paused')
    expect(paused?.opensAt?.toISOString()).toBe('2026-11-20T12:00:00.000Z')
  })

  test('the best account at its 5-hour limit is closed and the next one is admitted', async () => {
    world({ a: { w: 10, s: 95 }, b: { w: 30 }, c: { w: 60 }, d: { w: 90 } })
    const { readings, picked, order } = await onSnapshot()
    expect(readings.find((r) => r.account === 'a')).toMatchObject({ open: false })
    expect(picked.picked?.account).toBe(order[0])
    expect(picked.picked?.account).not.toBe('a')
  })

  test('with every account closed nothing is admitted and the first opening is named', async () => {
    world({ a: { w: 99 }, b: { w: 99 }, c: { w: 99 }, d: { w: 99 } })
    const { picked, order } = await onSnapshot()
    expect(order).toEqual([])
    expect(picked).toMatchObject({ picked: null })
    expect(picked.picked === null && picked.opensAt).not.toBeNull()
  })

  test('the reset a lead that hit a wall waits for is the window nearest its ceiling, only when it is close', async () => {
    world({ a: { w: 20, s: 85 }, b: { w: 20, s: 40 }, c: { w: 20 }, d: { w: 20 } })
    const { readings } = await onSnapshot()
    expect(readings.find((r) => r.account === 'a')?.wallResetAt?.getTime()).toBe(NOW.getTime() + 2 * 3_600_000)
    expect(readings.find((r) => r.account === 'b')?.wallResetAt).toBeNull()
  })

  test('a mode override set through the desk is what claude-account reads, and clearing it restores the registry mode', () => {
    world({ a: { w: 20 }, b: { w: 20 }, c: { w: 20 }, d: { w: 20 } })
    const desk = packageAccountDesk({ paths })
    const set = value(desk.setMode('b', { mode: 'paused', until: '2026-11-20T12:00:00Z' }, NOW))
    expect(set).toMatchObject({ kind: 'paused', source: 'override', until: '2026-11-20T12:00:00Z' })
    const views = liveAccounts(loadRegistry(paths.registry), NOW.getTime(), paths).views
    expect(views.b?.mode.kind).toBe('paused')
    expect(views.b?.source).toBe('override')
    const status = value(desk.status(NOW))
    expect(status.accounts.find((a) => a.id === 'b')?.lanes.bulk).toMatchObject({ open: false, closed: 'paused' })
    const cleared = value(desk.clearMode('b', new Date(NOW.getTime() + 1000)))
    expect(cleared).toMatchObject({ kind: 'normal', source: 'registry' })
  })

  test('a refused request is a port error that says what is wrong', () => {
    world({ a: { w: 20 }, b: { w: 20 }, c: { w: 20 }, d: { w: 20 } })
    const desk = packageAccountDesk({ paths })
    expect(desk.setMode('nope', { mode: 'paused' }, NOW)).toMatchObject({ ok: false, error: { kind: 'refused' } })
    expect(desk.setMode('a', { mode: 'paused', until: '2026-11-01T00:00:00Z' }, NOW)).toMatchObject({
      ok: false,
      error: { kind: 'refused', detail: expect.stringContaining('already past') },
    })
    expect(desk.setMode('a', { mode: 'reserve' }, NOW)).toMatchObject({ ok: false, error: { kind: 'refused' } })
  })

  test('an unreadable registry is an unreadable port error, never a throw', async () => {
    world({ a: { w: 20 }, b: { w: 20 }, c: { w: 20 }, d: { w: 20 } })
    writeFileSync(paths.registry as string, '{ not json')
    const read = await deskAccountSource(packageAccountDesk({ paths })).read(NOW)
    expect(read).toMatchObject({ ok: false, error: { kind: 'unreadable' } })
  })

  test('a reading carries the windows as the sample shows them', async () => {
    world({ a: { w: 33, s: 12 }, b: { w: 20 }, c: { w: 20 }, d: { w: 20 } })
    const status = value(packageAccountDesk({ paths }).status(NOW))
    const row = status.accounts.find((a) => a.id === 'a')
    if (!row) throw new Error('account a is not in the status')
    const reading = readingOf(row, NOW)
    expect(reading).toMatchObject({ account: 'a', fiveHourUsed: 12, weeklyUsed: 33, enabled: true, authOk: true })
    expect(reading.sampledAt?.getTime()).toBe(NOW.getTime() - 60_000)
  })
})
