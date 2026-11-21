import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { slotAimPass } from '../../src/app/capacity-aim.ts'
import { touchSlot } from '../../src/app/capacity-slots.ts'
import {
  AIM_QUIET_MS,
  type AimSignals,
  type AimState,
  aimStep,
  swapGrowing,
} from '../../src/domains/capacity/slot-aim.ts'
import { ok } from '../../src/kernel/result.ts'
import { startWorld, value, type World } from '../planning/support.ts'

const AT = new Date('2026-11-14T12:00:00Z')
const at = (min: number) => new Date(AT.getTime() + min * 60_000)
const signals = (over: Partial<AimSignals> = {}): AimSignals => ({
  at: AT,
  pressureLevel: 1,
  swapGrowing: false,
  load: 6,
  loadTrip: { tripped: false },
  loadCeiling: 36,
  waiters: 1,
  ...over,
})

describe('the aim moves by AIMD on the host pressure', () => {
  const quiet = (target: number, minutes = 5): AimState => ({ target, quietSince: at(-minutes) })

  test('one slot more after five quiet minutes at level 1 with a waiter, and the quiet restarts', () => {
    const step = aimStep(quiet(2), signals(), 6)
    expect(step.state).toEqual({ target: 3, quietSince: AT })
    expect(aimStep(step.state, signals({ at: at(1) }), 6).state.target).toBe(3)
  })

  test('four quiet minutes, no waiter, the ceiling, an unread load or the tripped load tripwire add nothing', () => {
    expect(aimStep(quiet(2, 4), signals(), 6).state.target).toBe(2)
    expect(aimStep(quiet(2), signals({ waiters: 0 }), 6).state.target).toBe(2)
    expect(aimStep(quiet(6), signals(), 6).state.target).toBe(6)
    const tripped = aimStep(
      quiet(2),
      signals({ load: 50, loadTrip: { tripped: true, loads: [50, 41, 40, 39, 38] } }),
      6,
    )
    expect(tripped.state.target).toBe(2)
    expect(tripped.reason).toContain('load over 36 in each of the last 5 minutes')
    // one peak over the ceiling (the tripwire clear) still adds: a peak is no reason to hold back
    expect(aimStep(quiet(2), signals({ load: 60 }), 6).state.target).toBe(3)
    expect(aimStep(quiet(2), signals({ load: null }), 6).state.target).toBe(2)
  })

  test('the first quiet minute starts the clock', () => {
    expect(aimStep({ target: 2, quietSince: null }, signals(), 6).state).toEqual({ target: 2, quietSince: AT })
    expect(AIM_QUIET_MS).toBe(300_000)
  })

  test('level 2 or growing swap halves (never below 1) and ends the quiet', () => {
    expect(aimStep(quiet(6), signals({ pressureLevel: 2 }), 6).state).toEqual({ target: 3, quietSince: null })
    expect(aimStep(quiet(5), signals({ swapGrowing: true }), 6).state).toEqual({ target: 2, quietSince: null })
    expect(aimStep(quiet(1), signals({ pressureLevel: 2 }), 6).state.target).toBe(1)
  })

  test('level 4 drops to one slot', () => {
    expect(aimStep(quiet(6), signals({ pressureLevel: 4 }), 6).state).toEqual({ target: 1, quietSince: null })
  })

  test('an unread pressure holds the count and is not quiet', () => {
    expect(aimStep(quiet(4), signals({ pressureLevel: null }), 6).state).toEqual({ target: 4, quietSince: null })
  })

  test('a target above a lowered ceiling is clamped', () => {
    expect(aimStep(quiet(6), signals(), 3).state.target).toBe(3)
  })

  test('swap grows when the newest reading is half a point above the lowest of the older ones', () => {
    const s = (...pcts: (number | null)[]) => pcts.map((swapUsedPct) => ({ swapUsedPct }))
    expect(swapGrowing(s(40.5, 40, 40, 40))).toBe(true)
    expect(swapGrowing(s(40.4, 40, 40.2))).toBe(false)
    expect(swapGrowing(s(40.5))).toBe(false)
    expect(swapGrowing(s(null, 40, 41))).toBe(false)
    expect(swapGrowing(s(41, null, 40))).toBe(true)
    // only the newest five count: an old low reading says nothing
    expect(swapGrowing(s(41, 41, 41, 41, 41, 10))).toBe(false)
  })
})

describe('the aim pass and the grant', () => {
  let world: World
  beforeAll(async () => {
    world = await startWorld()
  })
  afterAll(async () => {
    await world.stop()
  })
  beforeEach(async () => {
    await world.reset()
    // the world's roomy aim and calm sample (admission's) are replaced by what each test seeds
    await world.db.sql`DELETE FROM factory.slot_aim`
    await world.db.sql`DELETE FROM factory.host_samples`
  })

  const aimDeps = () => ({
    ...world.deps,
    slots: 2,
    slotsMax: 6,
    loadCeiling: 36,
  })
  const sample = async (min: number, over: { level?: number | null; swap?: number; load?: number } = {}) => {
    await world.db.sql`
      INSERT INTO factory.host_samples (at, load, memory_used_pct, swap_used_pct, swapout_mb_per_300s, pressure_level)
      VALUES (${at(min)}, ${over.load ?? 5}, 40, ${over.swap ?? 30}, 0, ${over.level === undefined ? 1 : over.level})`
    world.clock.set(at(min))
  }
  const waiter = (id: string) => world.db.sql`
    INSERT INTO factory.capacity_slots (id, name, requested_at, seen_at) VALUES (${id}, ${id}, ${world.clock.now()}, ${world.clock.now()})`
  const shadow = async () =>
    (await world.db.sql`SELECT aim_slots, live_slots, waiters, reason FROM factory.slot_shadow ORDER BY at`) as {
      aim_slots: number
      live_slots: number
      waiters: number
      reason: string
    }[]

  test('six quiet minutes with a waiter in line add a slot, one shadow row a minute beside the live base', async () => {
    for (let m = 0; m <= 6; m++) {
      await sample(m)
      if (m === 0) await waiter('w1')
      else await world.db.sql`UPDATE factory.capacity_slots SET seen_at = ${at(m)}`
      value(await slotAimPass(aimDeps()))
    }
    const rows = await shadow()
    expect(rows.map((r) => r.aim_slots)).toEqual([2, 2, 2, 2, 2, 3, 3])
    expect(rows.every((r) => r.live_slots === 2 && r.waiters === 1)).toBe(true)
    expect(rows[5]?.reason).toContain('2 to 3')
    const [aim] = await world.db.sql`SELECT target FROM factory.slot_aim WHERE id = 1`
    expect(aim?.target).toBe(3)
  })

  test('level 2 halves the aim, and a stale host sample holds it', async () => {
    await sample(0, { level: 2 })
    value(await slotAimPass(aimDeps()))
    expect((await shadow()).map((r) => r.aim_slots)).toEqual([1])
    world.clock.set(at(30))
    value(await slotAimPass(aimDeps()))
    expect((await shadow()).map((r) => r.reason)).toEqual(['pressure level 2: halved', 'pressure not read: held'])
  })

  test('the lead aim is seeded and stored beside the slot aim, with the leads that waited for it', async () => {
    await sample(0)
    value(await slotAimPass({ ...aimDeps(), leadWaiters: async () => 3 }))
    const [aim] = await world.db.sql`SELECT lead_target, lead_since FROM factory.slot_aim WHERE id = 1`
    expect(aim?.lead_target).toBe(1)
    const [row] = await world.db.sql`SELECT lead_aim, leads_running FROM factory.slot_shadow`
    expect(row).toMatchObject({ lead_aim: 1, leads_running: 0 })
  })

  test('swapouts over the ceiling for five minutes halve the slot aim', async () => {
    for (let m = 0; m <= 2; m++) {
      await world.db.sql`
        INSERT INTO factory.host_samples (at, load, memory_used_pct, swap_used_pct, swapout_mb_per_300s, pressure_level)
        VALUES (${at(m)}, 5, 40, 30, 5000, 1)`
      world.clock.set(at(m))
      value(await slotAimPass({ ...aimDeps(), swapoutCeilingMb: 2048 }))
    }
    expect((await shadow()).map((r) => r.reason)).toContain('swapouts over the ceiling: halved')
  })

  test('rows older than 14 days are pruned', async () => {
    await world.db.sql`
      INSERT INTO factory.slot_shadow (at, live_slots, live_max, aim_slots, holders, waiters, swap_growing, reason)
      VALUES (${new Date(AT.getTime() - 15 * 86_400_000)}, 2, 6, 2, 0, 0, false, 'old')`
    await sample(0)
    value(await slotAimPass(aimDeps()))
    expect((await shadow()).map((r) => r.reason)).not.toContain('old')
  })

  test('the aimed count governs the grant', async () => {
    await sample(0, { level: 2 })
    value(await slotAimPass(aimDeps())) // the aim is now 1
    const slotDeps = {
      ...world.deps,
      slots: 2,
      slotsMax: 6,
      slotExtraLoad: 12,
      cores: 12,
      loadCeiling: 36,
    }
    const first = value(await touchSlot(slotDeps, { id: 'a', name: 'a' }))
    expect(first.granted).toBe(true)
    const second = value(await touchSlot(slotDeps, { id: 'b', name: 'b' }))
    expect(second.granted).toBe(false)
    expect(second.why).toContain('all 1 slots are busy')
  })

  test('while the newest host samples show swap rising, a second step waits; a stale reading is ignored', async () => {
    const deps = {
      ...world.deps,
      slots: 2,
      slotsMax: 6,
      slotExtraLoad: 12,
      cores: 12,
      loadCeiling: 36,
    }
    for (const [min, swap] of [
      [0, 10],
      [1, 10.1],
      [2, 10.2],
      [3, 10.3],
      [4, 11],
    ] as const)
      await sample(min, { swap })
    expect(value(await touchSlot(deps, { id: 'a', name: 'a' })).granted).toBe(true)
    const second = value(await touchSlot(deps, { id: 'b', name: 'b' }))
    expect(second.granted).toBe(false)
    expect(second.why).toContain('swap in use is growing')
    world.clock.set(at(20))
    expect(value(await touchSlot(deps, { id: 'a', name: 'a' })).granted).toBe(true)
    expect(value(await touchSlot(deps, { id: 'b', name: 'b' })).granted).toBe(true)
  })

  test('a slot beyond the base still needs a free-memory reading (a step with no peak is sized by a prior)', async () => {
    await world.db.sql`
      INSERT INTO factory.slot_aim (id, target, quiet_since, changed_at) VALUES (1, 4, NULL, ${AT})`
    const deps = {
      ...world.deps,
      slots: 2,
      slotsMax: 6,
      slotExtraLoad: 12,
      cores: 12,
      loadCeiling: 36,
    }
    expect(value(await touchSlot(deps, { id: 'a', name: 'a' })).granted).toBe(true)
    expect(value(await touchSlot(deps, { id: 'b', name: 'b' })).granted).toBe(true)
    const third = value(await touchSlot(deps, { id: 'c', name: 'c' }))
    expect(third.granted).toBe(false)
    expect(third.why).toContain('no recent free-memory reading')
  })

  test('a refusal on load names where its number comes from: the tripwire, or the load ceiling with too few samples', async () => {
    const slotDeps = {
      ...world.deps,
      slots: 2,
      slotsMax: 6,
      slotExtraLoad: 12,
      cores: 12,
      loadCeiling: 36,
    }
    const wait = async (load: number, minutes: readonly number[] = []) => {
      await world.reset()
      await world.db.sql`DELETE FROM factory.slot_aim`
      await world.db.sql`DELETE FROM factory.host_samples`
      for (const [i, sampled] of minutes.entries()) await sample(i - minutes.length + 1, { load: sampled })
      world.clock.set(AT)
      await world.db.sql`
        INSERT INTO factory.slot_aim (id, target, quiet_since, changed_at) VALUES (1, 4, NULL, ${AT})`
      world.host.loadValue = ok(load)
      for (const id of ['a', 'b']) value(await touchSlot(slotDeps, { id, name: id }))
      return value(await touchSlot(slotDeps, { id: 'c', name: 'c' }))
    }
    // too few minute samples for the tripwire: the instant against the load ceiling
    expect((await wait(40)).why).toContain('load 40 is over 36 (the load ceiling, too few minute samples')
    // five minutes on end over the ceiling: the tripwire
    // (it holds a base slot too: one step at a time, so the second waits as the third does)
    expect((await wait(40, [41, 40, 39, 38, 37])).why).toContain(
      'load over 36 in each of the last 5 minutes (37, 38, 39, 40, 41): one step at a time until it settles',
    )
    // one peak among quiet minutes trips nothing: the slot beyond the base is held back by something else, not the load
    const peak = await wait(60, [10, 10, 10, 10, 60])
    expect(peak.why ?? '').not.toContain('load')
  })
})
