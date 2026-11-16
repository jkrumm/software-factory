import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { giveSlotBack, recordStepCost, touchSlot } from '../../src/app/capacity-slots.ts'
import { DEFAULT_PRIOR_MIB, stepKindOf, stepNameOf, stepPrior } from '../../src/domains/capacity/costs.ts'
import { startWorld, value, type World } from '../planning/support.ts'

const AT = new Date('2026-11-14T12:00:00Z')
const WORKTREE = '/src/p/.claude/worktrees/factory-1-1'

describe('the name a step is learned under', () => {
  test('a worktree word becomes the project, anything else stays', () => {
    expect(stepNameOf('factory-1-1 unit', WORKTREE, 'p')).toBe('p unit')
    expect(stepNameOf('factory-1-1 unit', `${WORKTREE}/apps/server`, 'p')).toBe('p unit')
    expect(stepNameOf('factory-1-1', WORKTREE, 'p')).toBe('p')
    expect(stepNameOf('p unit', WORKTREE, 'p')).toBe('p unit')
    expect(stepNameOf('factory-2-1 unit', WORKTREE, 'p')).toBe('factory-2-1 unit')
    expect(stepNameOf('factory-1-1 unit', '/src/p', 'p')).toBe('factory-1-1 unit')
    expect(stepNameOf('factory-1-1 unit', WORKTREE, undefined)).toBe('factory-1-1 unit')
    expect(stepNameOf('factory-1-1 unit', undefined, 'p')).toBe('factory-1-1 unit')
  })

  test('a step with nothing learned is sized by its kind, then its project, then the default', () => {
    const steps = new Map<string, number | null>([
      ['p unit', 6000],
      ['p layout', 2400],
      ['p lint', null],
    ])
    expect(stepKindOf('p make check-fast')).toBe('check-fast')
    expect(stepPrior('p other unit', steps)).toEqual({ mib: 6000, from: 'kind' })
    expect(stepPrior('p e2e', steps)).toEqual({ mib: 6000, from: 'project' })
    expect(stepPrior('p e2e', new Map())).toEqual({ mib: DEFAULT_PRIOR_MIB, from: 'default' })
    expect(stepPrior('p lint', new Map([['p lint', null]]))).toEqual({ mib: DEFAULT_PRIOR_MIB, from: 'default' })
  })
})

describe('a step is sized from its project', () => {
  let world: World
  beforeAll(async () => {
    world = await startWorld()
  })
  afterAll(async () => {
    await world.stop()
  })
  beforeEach(async () => {
    await world.reset()
    world.clock.set(AT)
    await world.db.sql`
      INSERT INTO factory.planning_projects (name, repo, source, project)
      VALUES ('p', '/src/p', 'file', '{"apiVersion":"factory/v2","name":"p"}'::jsonb)`
    await world.db.sql`
      INSERT INTO factory.host_samples (at, load, memory_used_pct, swap_used_pct, swapout_mb_per_300s, pressure_level)
      VALUES (${AT}, 5, 40, 30, 0, 1)`
  })

  const deps = () => ({
    ...world.deps,
    slots: 2,
    slotsMax: 6,
    slotExtraLoad: 12,
    slotAim: 'off' as const,
    cores: 12,
    loadCeiling: 36,
  })
  const learn = (name: string, peak: number, repo = '/src/p') =>
    world.db.sql`
      INSERT INTO factory.step_costs (at, name, repo, peak_rss_mib, cpu_seconds, duration_ms, wait_ms, exit_code)
      VALUES (${new Date(AT.getTime() - 60_000)}, ${name}, ${repo}, ${peak}, 1, 1000, 0, 0)`
  const hold = async () => {
    for (const id of ['a', 'b']) expect(value(await touchSlot(deps(), { id, name: id })).granted).toBe(true)
  }
  const worktreeStep = (id = 'c') => touchSlot(deps(), { id, name: 'factory-1-1 unit', cwd: WORKTREE })

  test("a worktree's step is granted beyond the base on its project's learned peak", async () => {
    await learn('p unit', 1000)
    await hold()
    expect(value(await worktreeStep()).granted).toBe(true)
  })

  test("and waits on that peak when it does not fit, whatever the worktree's own name never ran", async () => {
    await learn('p unit', 30_000)
    await hold()
    const waits = value(await worktreeStep())
    expect(waits.granted).toBe(false)
    expect(waits.why).toContain('needs 29.3 GiB (learned from the last runs)')
  })

  test("the rows an old worktree name left in the repo seed the project's figure", async () => {
    await learn('factory-9-1 unit', 30_000)
    await learn('factory-9-1 unit', 30_000, '/src/other')
    await hold()
    expect(value(await worktreeStep()).why).toContain('needs 29.3 GiB (learned from the last runs)')
  })

  test('a step nobody has run is granted beyond the base when its prior fits, and waits when it does not', async () => {
    await hold()
    expect(value(await touchSlot(deps(), { id: 'c', name: 'p lint', cwd: '/src/p' })).granted).toBe(true)
  })

  test("the prior is the project's largest step, and says it is a guess", async () => {
    await learn('p unit', 30_000)
    await hold()
    const guess = value(await touchSlot(deps(), { id: 'c', name: 'p lint', cwd: '/src/p' }))
    expect(guess.granted).toBe(false)
    expect(guess.why).toContain("a guess: the project's largest step")
    const kind = value(await touchSlot(deps(), { id: 'd', name: 'p more unit', cwd: '/src/p' }))
    expect(kind.why).toContain('a guess: the largest step of this kind')
  })

  test("a finished worktree step is stored under the project's name", async () => {
    value(
      await recordStepCost(world.deps, {
        name: 'factory-1-1 unit',
        cwd: WORKTREE,
        peakRssMib: 500,
        cpuSeconds: 1,
        durationMs: 1000,
        waitMs: 0,
        exitCode: 0,
      }),
    )
    const rows = await world.db.sql`SELECT name, repo FROM factory.step_costs`
    expect(rows.map((r: { name: string; repo: string }) => [r.name, r.repo])).toEqual([['p unit', '/src/p']])
  })

  test("a granted waiter's split is stored with its project, and a waiter that leaves is stored as gave_up", async () => {
    await learn('p unit', 30_000)
    await hold()
    expect(value(await worktreeStep('c')).granted).toBe(false)
    expect(value(await worktreeStep('d')).granted).toBe(false)
    world.clock.set(new Date(AT.getTime() + 4000))
    expect(value(await worktreeStep('c')).granted).toBe(false)
    expect(value(await worktreeStep('d')).granted).toBe(false)
    world.clock.set(new Date(AT.getTime() + 8000))
    value(await giveSlotBack(world.deps, 'd'))
    value(await giveSlotBack(world.deps, 'a'))
    // the holders end and memory frees: c is granted and its split lands in the ledger
    value(await giveSlotBack(world.deps, 'b'))
    world.clock.set(new Date(AT.getTime() + 9000))
    expect(value(await worktreeStep('c')).granted).toBe(true)
    const rows = await world.db
      .sql`SELECT name, repo, outcome, wait_ms, split FROM factory.slot_waits ORDER BY outcome DESC`
    expect(rows.map((r: { outcome: string; repo: string }) => [r.outcome, r.repo])).toEqual([
      ['granted', '/src/p'],
      ['gave_up', '/src/p'],
    ])
    const granted = rows[0] as { wait_ms: string | number; split: string | Record<string, number> }
    const split = typeof granted.split === 'string' ? JSON.parse(granted.split) : granted.split
    expect(Number(granted.wait_ms)).toBe(9000)
    expect(split).toEqual({ memory: 9000 })
  })
})
