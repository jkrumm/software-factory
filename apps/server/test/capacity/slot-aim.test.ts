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
import { startWorld, value, type World } from '../planning/support.ts'

const AT = new Date('2026-11-14T12:00:00Z')
const at = (min: number) => new Date(AT.getTime() + min * 60_000)
const signals = (over: Partial<AimSignals> = {}): AimSignals => ({
  at: AT,
  pressureLevel: 1,
  swapGrowing: false,
  load: 6,
  cores: 12,
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

  test('four quiet minutes, no waiter, the ceiling or load above twice the cores add nothing', () => {
    expect(aimStep(quiet(2, 4), signals(), 6).state.target).toBe(2)
    expect(aimStep(quiet(2), signals({ waiters: 0 }), 6).state.target).toBe(2)
    expect(aimStep(quiet(6), signals(), 6).state.target).toBe(6)
    expect(aimStep(quiet(2), signals({ load: 24.1 }), 6).state.target).toBe(2)
    expect(aimStep(quiet(2), signals({ load: 24 }), 6).state.target).toBe(3)
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
  })

  const aimDeps = (mode: 'off' | 'shadow' | 'on') => ({ ...world.deps, mode, slots: 2, slotsMax: 6, cores: 12 })
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

  test('off stores nothing', async () => {
    await sample(0)
    expect(value(await slotAimPass(aimDeps('off')))).toBe('slot aim is off')
    expect(await shadow()).toEqual([])
  })

  test('six quiet minutes with a waiter in line add a slot, one shadow row a minute beside the live base', async () => {
    for (let m = 0; m <= 6; m++) {
      await sample(m)
      if (m === 0) await waiter('w1')
      else await world.db.sql`UPDATE factory.capacity_slots SET seen_at = ${at(m)}`
      value(await slotAimPass(aimDeps('shadow')))
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
    value(await slotAimPass(aimDeps('shadow')))
    expect((await shadow()).map((r) => r.aim_slots)).toEqual([1])
    world.clock.set(at(30))
    value(await slotAimPass(aimDeps('shadow')))
    expect((await shadow()).map((r) => r.reason)).toEqual(['pressure level 2: halved', 'pressure not read: held'])
  })

  test('rows older than 14 days are pruned', async () => {
    await world.db.sql`
      INSERT INTO factory.slot_shadow (at, live_slots, live_max, aim_slots, holders, waiters, swap_growing, reason)
      VALUES (${new Date(AT.getTime() - 15 * 86_400_000)}, 2, 6, 2, 0, 0, false, 'old')`
    await sample(0)
    value(await slotAimPass(aimDeps('shadow')))
    expect((await shadow()).map((r) => r.reason)).not.toContain('old')
  })

  test('only under on does the aimed count govern the grant', async () => {
    await sample(0, { level: 2 })
    value(await slotAimPass(aimDeps('shadow'))) // the aim is now 1
    const slotDeps = (mode: 'shadow' | 'on') => ({
      ...world.deps,
      slots: 2,
      slotsMax: 6,
      slotExtraLoad: 12,
      slotAim: mode,
      cores: 12,
    })
    const first = value(await touchSlot(slotDeps('on'), { id: 'a', name: 'a' }))
    expect(first.granted).toBe(true)
    const second = value(await touchSlot(slotDeps('on'), { id: 'b', name: 'b' }))
    expect(second.granted).toBe(false)
    expect(second.why).toContain('all 1 slots are busy')
    // the same state under shadow: the live rule grants the second step (no learned peak, so within the base)
    const live = value(await touchSlot(slotDeps('shadow'), { id: 'b', name: 'b' }))
    expect(live.granted).toBe(true)
  })

  test('under on a slot beyond the live base still needs a learned peak and the load within twice the cores', async () => {
    await world.db.sql`
      INSERT INTO factory.slot_aim (id, target, quiet_since, changed_at) VALUES (1, 4, NULL, ${AT})`
    const deps = { ...world.deps, slots: 2, slotsMax: 6, slotExtraLoad: 12, slotAim: 'on' as const, cores: 12 }
    expect(value(await touchSlot(deps, { id: 'a', name: 'a' })).granted).toBe(true)
    expect(value(await touchSlot(deps, { id: 'b', name: 'b' })).granted).toBe(true)
    const third = value(await touchSlot(deps, { id: 'c', name: 'c' }))
    expect(third.granted).toBe(false)
    expect(third.why).toContain('no learned peak')
  })
})
