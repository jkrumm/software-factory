import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { admissionPass } from '../../src/app/capacity-admit.ts'
import { syncProjects } from '../../src/app/planning-sync.ts'
import { setPrio } from '../../src/app/planning-chain.ts'
import type { IssueId } from '../../src/kernel/ids.ts'
import { key } from '../../src/kernel/keys.ts'
import { account, startWorld, value, type World } from '../planning/support.ts'

/**
 * The admission order for throughput, through the real admission pass and Postgres: within one project and one priority
 * what finishes sooner starts first, an Issue that waited long enough is not starved, the queue model's order breaks the
 * ties after that, and the owner's prio stays absolute.
 */
let world: World

beforeAll(async () => {
  world = await startWorld()
})
afterAll(async () => {
  await world.stop()
})

beforeEach(async () => {
  await world.reset()
  world.source.add('solo', {
    project: { state: 'text', sha: 'sha-solo', value: { apiVersion: 'factory/v2', name: 'solo', leads: 1, lanes: {} } },
  })
  value(await syncProjects(world.deps, { fetch: false }))
  world.accounts.rows = [account('a'), account('b')]
})

const HOUR = 3_600_000
const sized = async (size: 'small' | 'medium' | 'large' | null): Promise<string> => {
  const issue = await world.file({ repo: 'solo' })
  await world.send(issue, 'settled', 'settled', size ? { size } : {})
  return issue
}
const admitted = async (): Promise<string[]> => value(await admissionPass(world.deps)).admitted.map((a) => a.issue)
/** the order the pass found: what it admitted, then what stays queued */
const orderOf = async (): Promise<string[]> => {
  const pass = value(await admissionPass(world.deps))
  return [...pass.admitted.map((a) => a.issue), ...pass.queue.map((q) => q.issue)]
}

describe('the queue order within a priority', () => {
  test('a small Issue filed after a large one of the same prio starts first', async () => {
    const large = await sized('large')
    const small = await sized('small')
    expect(await admitted()).toEqual([small])
    expect(large).not.toBe(small)
  })

  test('the Issue number decides between equal sizes, and unsized counts as medium', async () => {
    const first = await sized(null)
    const second = await sized('medium')
    const third = await sized('small')
    const queue = await orderOf()
    expect(queue.slice(0, 3)).toEqual([third, first, second])
  })

  test('a large Issue that waited 12 hours is not starved by a fresh small one', async () => {
    const large = await sized('large')
    world.clock.set(new Date(world.clock.now().getTime() + 12 * HOUR))
    const small = await sized('small')
    expect(await admitted()).toEqual([large])
    expect(small).not.toBe(large)
  })

  test("the owner's prio is never overridden by size", async () => {
    const large = await sized('large')
    const small = await sized('small')
    value(await setPrio(world.deps, { issue: large as IssueId, value: 5, key: key('prio', 'large') }))
    expect(await admitted()).toEqual([large])
    expect(small).not.toBe(large)
  })

  test('the queue model’s order breaks a tie of equal size, never an unequal one', async () => {
    const a = await sized('medium')
    const b = await sized('medium')
    const big = await sized('large')
    const little = await sized('small')
    await world.db.sql`
      INSERT INTO factory.queue_asks (key, repo, shape, round, claimed_at, lease_until, outcome, answer, finished_at)
      VALUES ('queue:solo:1', 'solo', 'shape', 1, ${world.clock.now()}, ${world.clock.now()}, 'answered',
        ${JSON.stringify({ edges: [], order: [big, b, a, little], reason: 'r' })}::jsonb, ${world.clock.now()})`
    const queue = await orderOf()
    expect(queue.slice(0, 4)).toEqual([little, b, a, big])
  })
})
