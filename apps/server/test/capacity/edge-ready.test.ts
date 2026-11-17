import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { admissionPass } from '../../src/app/capacity-admit.ts'
import { syncProjects } from '../../src/app/planning-sync.ts'
import { account, startWorld, value, type World } from '../planning/support.ts'

let world: World

beforeAll(async () => {
  world = await startWorld()
})
afterAll(async () => {
  await world.stop()
})

const PROJECT = (name: string, leads: number) => ({
  state: 'text' as const,
  sha: `sha-${name}`,
  value: { apiVersion: 'factory/v2', name, leads, lanes: {} },
})

beforeEach(async () => {
  await world.reset()
  world.source.add('solo', { project: PROJECT('solo', 1) })
  world.source.add('lab', { project: PROJECT('lab', 2) })
  value(await syncProjects(world.deps, { fetch: false }))
  world.accounts.rows = [account('a'), account('b')]
})

const MIN = 60_000
const hold = (issue: string, after: string) =>
  world.db.sql`
    INSERT INTO factory.planning_edges (issue_id, after_issue, created_at, inferred_by)
    VALUES (${issue}, ${after}, ${world.clock.now()}, 'queue: same files')`
const edgeOf = async (issue: string) => {
  const [row] = await world.db.sql`
    SELECT ready_since, satisfied_at, inferred_by FROM factory.planning_edges WHERE issue_id = ${issue}`
  return row as { ready_since: Date | null; satisfied_at: Date | null; inferred_by: string | null }
}

describe('whether an edge held an Issue behind free capacity', () => {
  test('an Issue its edge holds while its repo has a free lead reads ready since the first look, and the value freezes when the edge is satisfied', async () => {
    const first = await world.queued({ repo: 'lab' })
    const second = await world.queued({ repo: 'lab' })
    await hold(second, first)
    const seen = world.clock.now()

    const pass = value(await admissionPass(world.deps))
    expect(pass.admitted.map((a) => a.issue)).toEqual([first])
    expect(pass.queue.find((q) => q.issue === second)).toMatchObject({
      reason: { kind: 'chain' },
      readyWithoutEdges: true,
    })
    expect((await edgeOf(second)).ready_since).toEqual(seen)

    // a later look keeps the first time
    world.clock.advance(10 * MIN)
    value(await admissionPass(world.deps))
    expect((await edgeOf(second)).ready_since).toEqual(seen)

    await world.send(first, 'lead_started', 'lead_started', { attempt: 1, terminal: 't1' })
    await world.send(first, 'closed', 'closed', { attempt: 1, outcome: 'done', reason: 'done' }, 'lead')
    const closed = world.clock.now()
    world.clock.advance(5 * MIN)
    expect(value(await admissionPass(world.deps)).admitted.map((a) => a.issue)).toEqual([second])
    expect(await edgeOf(second)).toEqual({ ready_since: seen, satisfied_at: closed, inferred_by: 'queue: same files' })
  })

  test('an Issue its edge holds behind the repo’s only lead is never ready, and one the look clears loses an earlier mark', async () => {
    const first = await world.queued({ repo: 'solo' })
    const second = await world.queued({ repo: 'solo' })
    await hold(second, first)

    const pass = value(await admissionPass(world.deps))
    expect(pass.admitted.map((a) => a.issue)).toEqual([first])
    expect(pass.queue.find((q) => q.issue === second)?.readyWithoutEdges).toBe(false)
    expect((await edgeOf(second)).ready_since).toBeNull()

    // a stale mark is cleared by a look that finds the Issue refused for another reason
    await world.db.sql`UPDATE factory.planning_edges SET ready_since = ${world.clock.now()} WHERE issue_id = ${second}`
    world.clock.advance(MIN)
    value(await admissionPass(world.deps))
    expect((await edgeOf(second)).ready_since).toBeNull()
  })

  test('an Issue no edge holds carries no readiness', async () => {
    await world.queued({ repo: 'solo' })
    const second = await world.queued({ repo: 'solo' })
    const pass = value(await admissionPass(world.deps))
    const entry = pass.queue.find((q) => q.issue === second)
    expect(entry?.reason?.kind).toBe('claim')
    expect(entry?.readyWithoutEdges).toBeUndefined()
  })
})
