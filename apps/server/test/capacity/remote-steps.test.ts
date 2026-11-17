import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { touchSlot } from '../../src/app/capacity-slots.ts'
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
    expect(value(await step('p unit')).why).toContain('has not answered its probe')
    probed = answer({ diskUsedBytes: 162 * GIB })
    expect(value(await step('p unit')).why).toContain('disk alert')
    probed = answer({ ioPressure: 25 })
    expect(value(await step('p unit')).why).toContain('stalled on io')
    probed = null
    expect(value(await step('p unit')).why).toContain('not answered its probe yet')
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

  test('a step red on the VPS and green on the mini stays home for 7 days', async () => {
    await world.db.sql`
      INSERT INTO factory.step_costs (at, name, repo, peak_rss_mib, cpu_seconds, duration_ms, wait_ms, exit_code, disagreed)
      VALUES (${new Date(AT.getTime() - 86_400_000)}, 'p unit', '/src/p', 900, 1, 1000, 0, 0, true)`
    await fillMini()
    expect(value(await step('p unit')).why).toContain('red on the VPS and green on the mini')
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
