import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { giveSlotBack, recordStepCost, type SignalFiler, touchSlot } from '../../src/app/capacity-slots.ts'
import type { RemoteProbeAnswer } from '../../src/domains/capacity/ports.ts'
import { startWorld, value, type World } from '../planning/support.ts'

const AT = new Date('2026-11-17T12:00:00Z')
const WORKTREE = '/src/p/.claude/worktrees/factory-1-1'
const GIB = 1024 ** 3

/** A VPS that answered now: 12 cores at load 2, 18 GiB available, a 177 GiB disk 70 % full, production calm. */
const answer = (over: Partial<RemoteProbeAnswer['reading']> = {}): RemoteProbeAnswer => ({
  reading: {
    at: AT,
    cores: 12,
    load1: 2,
    ramMib: 24_000,
    availableMib: 18_000,
    diskSizeBytes: 177 * GIB,
    diskUsedBytes: 124 * GIB,
    memoryPressure: 0,
    ioPressure: 0,
    ...over,
  },
  copies: [],
  steps: [],
})

const PROJECT = {
  apiVersion: 'factory/v2',
  name: 'p',
  steps: {
    unit: { make: 'test', remote: true, bun: '1.4.3', carry: ['packages/x/dist'] },
    e2e: { make: 'e2e', needs: ['network'], remote: true },
    lint: { make: 'lint' },
    sim: { make: 'sim', needs: ['apple'] },
  },
}

describe('a declared step runs off the mini when the mini makes it wait', () => {
  let world: World
  let probed: RemoteProbeAnswer | null
  beforeAll(async () => {
    world = await startWorld()
  })
  afterAll(async () => {
    await world.stop()
  })
  beforeEach(async () => {
    await world.reset()
    world.clock.set(AT)
    probed = answer()
    await world.db.sql`
      INSERT INTO factory.planning_projects (name, repo, source, project)
      VALUES ('p', '/src/p', 'file', ${JSON.stringify(PROJECT)}::text::jsonb)`
    await world.db.sql`
      INSERT INTO factory.host_samples (at, load, memory_used_pct, swap_used_pct, swapout_mb_per_300s, pressure_level)
      VALUES (${AT}, 5, 40, 30, 0, 1)`
  })

  const deps = (projects: string[] = ['p']) => ({
    ...world.deps,
    slots: 1,
    slotsMax: 1,
    slotExtraLoad: 12,
    slotAim: 'off' as const,
    cores: 12,
    loadCeiling: 36,
    remote: { target: 'step-host', projects, probe: { latest: () => probed } },
  })
  /** the mini's one slot taken by another project's step */
  const fillMini = async () =>
    expect(value(await touchSlot(deps(), { id: 'held', name: 'q check' })).granted).toBe(true)
  const step = (name: string, extra: Parameters<typeof touchSlot>[1] extends infer I ? Partial<I> : never = {}) =>
    touchSlot(deps(), { id: 'c', name, cwd: WORKTREE, remote: true, ...extra })

  test('the mini full: the step is granted on the VPS with how to run it there', async () => {
    await fillMini()
    const granted = value(await step('p unit'))
    expect(granted.granted).toBe(true)
    expect(granted.host).toBe('vps')
    expect(granted.remote).toEqual({
      target: 'step-host',
      repo: 'factory-steps/p.git',
      dir: 'factory-steps/p/1',
      bun: '1.4.3',
      dockerfile: null,
      carry: ['packages/x/dist'],
      network: false,
      memoryMib: 3072,
      cores: 10,
    })
    // its renewal keeps the VPS slot, and the mini's slot stays the other step's
    const renewed = value(await step('p unit', { holding: true }))
    expect(renewed).toMatchObject({ granted: true, host: 'vps', remote: null })
    const rows = await world.db.sql`SELECT id, host, slot FROM factory.capacity_slots ORDER BY id`
    expect(rows.map((r: { id: string; host: string | null }) => [r.id, r.host])).toEqual([
      ['c', 'vps'],
      ['held', null],
    ])
  })

  test('a step that needs the network gets it', async () => {
    await fillMini()
    expect(value(await step('p e2e')).remote?.network).toBe(true)
  })

  test('the mini free: the step runs on the mini', async () => {
    const granted = value(await step('p unit'))
    expect(granted).toMatchObject({ granted: true, host: 'mini', remote: null })
  })

  test('an apple step is never placed off the mini, not even pinned there', async () => {
    await fillMini()
    const apple = value(await step('p sim'))
    expect(apple.granted).toBe(false)
    expect(apple.why).toContain('only the mini has')
    const pinned = value(await step('p sim', { pin: 'vps' }))
    expect(pinned.granted).toBe(false)
    expect(pinned.host).toBe('mini')
    const named = value(await touchSlot(deps(), { id: 'd', name: 'iris-apple', cwd: WORKTREE, remote: true }))
    expect(named.granted).toBe(false)
  })

  test('a step stays on the mini when it is not declared remote, its project is not admitted, or the CLI cannot', async () => {
    await fillMini()
    expect(value(await step('p lint')).why).toContain('not declared remote: true')
    expect(value(await touchSlot(deps([]), { id: 'd', name: 'p unit', cwd: WORKTREE, remote: true })).why).toContain(
      'not admitted',
    )
    expect(value(await touchSlot(deps(), { id: 'e', name: 'p unit', cwd: WORKTREE })).granted).toBe(false)
  })

  test('an unreachable VPS, a full disk or production under pressure keeps the step on the mini', async () => {
    await fillMini()
    probed = answer({ at: new Date(AT.getTime() - 5 * 60_000) })
    const stale = value(await step('p unit')).why
    expect(stale).toContain('the VPS has not answered its probe lately')
    // the reason carries no figure that moves, so the waiting CLI prints it once, not once a second
    world.clock.set(new Date(AT.getTime() + 1000))
    expect(value(await step('p unit')).why).toBe(stale)
    probed = answer({ at: new Date(AT.getTime() + 1000), diskUsedBytes: 162 * GIB })
    expect(value(await step('p unit')).why).toContain('near the line its alert pages on')
    probed = answer({ at: new Date(AT.getTime() + 1000), ioPressure: 25 })
    expect(value(await step('p unit')).why).toContain('under pressure')
    probed = null
    expect(value(await step('p unit')).why).toContain('has not answered its probe lately')
  })

  test('a VPS holder whose lapsed row another caller dropped is taken back on the VPS, never on the mini', async () => {
    await fillMini()
    expect(value(await step('p unit')).host).toBe('vps')
    // the server was away past the lease: another caller's save drops the lapsed VPS row
    world.clock.set(new Date(AT.getTime() + 60_000))
    expect(value(await touchSlot(deps(), { id: 'held', name: 'q check', holding: true })).granted).toBe(true)
    const [gone] = await world.db.sql`SELECT count(*)::int AS n FROM factory.capacity_slots WHERE id = 'c'`
    expect(gone).toEqual({ n: 0 })
    const back = value(await step('p unit', { holding: true, runningOn: { host: 'vps', slot: 1 } }))
    expect(back).toMatchObject({ granted: true, host: 'vps', slot: 1 })
    const rows = await world.db.sql`SELECT id, host FROM factory.capacity_slots ORDER BY id`
    expect(rows.map((r: { id: string; host: string | null }) => [r.id, r.host])).toEqual([
      ['c', 'vps'],
      ['held', null],
    ])
  })

  test('the VPS failing a step puts it back in the mini line at its old place', async () => {
    await fillMini()
    const first = value(await step('p unit'))
    expect(first.host).toBe('vps')
    world.clock.set(new Date(AT.getTime() + 5000))
    const back = value(await step('p unit', { notOn: ['vps'] }))
    expect(back.granted).toBe(false)
    const [row] = await world.db.sql`SELECT requested_at, host, slot FROM factory.capacity_slots WHERE id = 'c'`
    expect(row).toMatchObject({ host: null, slot: null })
    expect((row as { requested_at: Date }).requested_at.getTime()).toBe(AT.getTime())
  })

  const disagreedAt = (ms: number) =>
    world.db.sql`
      INSERT INTO factory.step_costs (at, name, repo, peak_rss_mib, cpu_seconds, duration_ms, wait_ms, exit_code, disagreed)
      VALUES (${new Date(AT.getTime() + ms)}, 'p unit', '/src/p', 900, 1, 1000, 0, 0, true)`
  const placements = async () =>
    (await world.db.sql`SELECT host, reason FROM factory.step_placements ORDER BY id`).map(
      (r: { host: string; reason: string }) => `${r.host}:${r.reason}`,
    )

  test('a step red on the VPS and green on the mini stays home for an hour, and the wait line says until when', async () => {
    await disagreedAt(-30 * 60_000)
    await fillMini()
    expect(value(await step('p unit')).why).toContain(
      'it was red on the VPS and green on the mini; it stays on the mini for 1 h, until 2026-11-17T12:30:00.000Z',
    )
    expect(await placements()).toEqual([])
  })

  test('the hold doubles with a second disagreement within a week and is over when it ends', async () => {
    await disagreedAt(-3 * 3_600_000)
    await disagreedAt(-30 * 60_000)
    await fillMini()
    expect(value(await step('p unit')).why).toContain('stays on the mini for 2 h, until 2026-11-17T13:30:00.000Z')
    world.clock.set(new Date(AT.getTime() + 91 * 60_000))
    probed = answer({ at: new Date(AT.getTime() + 91 * 60_000) })
    // the other step still holds the mini's slot: its lease is renewed
    expect(value(await touchSlot(deps(), { id: 'held', name: 'q check', holding: true })).granted).toBe(true)
    expect(value(await step('p unit')).host).toBe('vps')
  })

  test('a step held on the mini and granted there is placed as held', async () => {
    await disagreedAt(-30 * 60_000)
    expect(value(await step('p unit')).host).toBe('mini')
    expect(await placements()).toEqual(['mini:held'])
  })

  test('where a declared step ran and why: the VPS, a free slot, no room, not sooner', async () => {
    expect(value(await step('p unit', { id: 'free' })).host).toBe('mini')
    await giveSlotBack(world.deps, 'free')
    await fillMini()
    expect(value(await step('p unit', { id: 'vps' })).host).toBe('vps')
    await giveSlotBack(world.deps, 'vps')
    // no room: the VPS answers 5 minutes late; the mini frees later and takes the waiting step
    probed = answer({ at: new Date(AT.getTime() - 5 * 60_000) })
    expect(value(await step('p unit', { id: 'noroom' })).granted).toBe(false)
    await giveSlotBack(world.deps, 'held')
    expect(value(await step('p unit', { id: 'noroom' })).host).toBe('mini')
    await giveSlotBack(world.deps, 'noroom')
    // not sooner: its learned run on the VPS is far longer than the mini's wait plus run
    probed = answer()
    await world.db.sql`
      INSERT INTO factory.step_costs (at, name, repo, peak_rss_mib, cpu_seconds, duration_ms, wait_ms, exit_code, host)
      VALUES (${new Date(AT.getTime() - 3_600_000)}, 'p unit', '/src/p', 900, 1, 60000, 0, 0, 'mini'),
             (${new Date(AT.getTime() - 3_600_000)}, 'p unit', '/src/p', 900, 1, 6000000, 0, 0, 'vps')`
    await fillMini()
    expect(value(await step('p unit', { id: 'slow' })).granted).toBe(false)
    await giveSlotBack(world.deps, 'held')
    expect(value(await step('p unit', { id: 'slow' })).host).toBe('mini')
    expect(await placements()).toEqual(['mini:free', 'vps:vps', 'mini:no_room', 'mini:not_sooner'])
  })

  test('the pressure line is 1 % until a day of samples with no step running exists, then just above their p99', async () => {
    probed = answer({ ioPressure: 0.7 })
    await fillMini()
    expect(value(await step('p unit', { id: 'a' })).host).toBe('vps')
    await giveSlotBack(world.deps, 'a')
    // 300 calm samples over 25 h with no step running, and a busy one with a step running that is no baseline
    await world.db.sql`
      INSERT INTO factory.remote_samples (at, memory_pressure, io_pressure, steps_running)
      SELECT ${new Date(AT.getTime() - 25 * 3_600_000)}::timestamptz + (n * interval '5 minutes'), 0, 0, 0
      FROM generate_series(0, 299) AS n`
    await world.db.sql`
      INSERT INTO factory.remote_samples (at, memory_pressure, io_pressure, steps_running)
      VALUES (${new Date(AT.getTime() - 3_601_000)}, 30, 30, 2)`
    const refused = value(await step('p unit', { id: 'b' }))
    expect(refused.granted).toBe(false)
    expect(refused.why).toContain('under pressure')
  })

  test('each probe reading is stored once with the step containers running then', async () => {
    probed = { ...answer({ memoryPressure: 0.2, ioPressure: 0.1 }), steps: [{ id: 'x', startedMs: 1 }] }
    await step('p unit')
    await step('p unit')
    const rows = await world.db.sql`SELECT memory_pressure, io_pressure, steps_running FROM factory.remote_samples`
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ memory_pressure: 0.2, io_pressure: 0.1, steps_running: 1 })
  })

  test('a test that disagrees a second time is filed once to its repo, with its remote duration and timeout', async () => {
    const filed: Parameters<SignalFiler>[0][] = []
    const file: SignalFiler = async (body) => {
      filed.push(body)
      return { ok: true }
    }
    const red = {
      name: 'p unit',
      cwd: WORKTREE,
      peakRssMib: 900,
      cpuSeconds: 1,
      durationMs: 1000,
      waitMs: 0,
      exitCode: 0,
      disagreed: true,
      disagreement: { tests: [{ name: 'a.test.ts > slow one', durationMs: 5200, timeoutMs: 5000 }], tail: null },
    }
    expect(value(await recordStepCost(world.deps, red, file))).toBe(true)
    expect(filed).toEqual([])
    await recordStepCost(world.deps, red, file)
    expect(filed).toHaveLength(1)
    expect(filed[0]).toMatchObject({
      repo: 'p',
      title: 'Test "a.test.ts > slow one" fails on the step host and passes on the mini',
    })
    expect(filed[0]?.text).toContain('Its duration there: 5.2 s. Its timeout: 5 s.')
    // a third time is the same signal's business, not a new one
    await recordStepCost(world.deps, red, file)
    expect(filed).toHaveLength(1)
    // names stored with the row: what disagreed is readable
    const [row] = await world.db
      .sql`SELECT disagreement FROM factory.step_costs WHERE disagreed ORDER BY id DESC LIMIT 1`
    expect(row.disagreement.tests[0].name).toBe('a.test.ts > slow one')
  })

  test('pinned to the VPS, a declared step waits there and never takes the mini', async () => {
    probed = answer({ availableMib: 1000 })
    const pinned = value(await step('p unit', { pin: 'vps' }))
    expect(pinned.granted).toBe(false)
    expect(pinned.why).toContain('not on the VPS')
    probed = answer()
    expect(value(await step('p unit', { pin: 'vps' })).host).toBe('vps')
  })
})
