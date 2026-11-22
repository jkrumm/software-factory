import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { admissionPass, queueView, resumeClaim } from '../../src/app/capacity-admit.ts'
import { getQueueStates, setProjectPrio, setQueueState } from '../../src/app/capacity-queue.ts'
import { setPrio } from '../../src/app/planning-chain.ts'
import { syncProjects } from '../../src/app/planning-sync.ts'
import { issueId } from '../../src/kernel/ids.ts'
import { key } from '../../src/kernel/keys.ts'
import { account, startWorld, value, type World } from '../planning/support.ts'

/**
 * A project's priority, the owner's setting of the moment: among queued Issues of one Issue priority a higher project goes
 * first; the Issue's own priority outranks it; owed leads and the fix of a stopped line keep their places. Through the real
 * queue order and Postgres.
 */
let world: World

beforeAll(async () => {
  world = await startWorld()
})
afterAll(async () => {
  await world.stop()
})

const PROJECT = (name: string, leads = 1) => ({
  state: 'text' as const,
  sha: `sha-${name}`,
  value: { apiVersion: 'factory/v2', name, leads, lanes: {} },
})

beforeEach(async () => {
  await world.reset()
  world.source.add('low', { project: PROJECT('low') })
  world.source.add('high', { project: PROJECT('high') })
  value(await syncProjects(world.deps, { fetch: false }))
  world.accounts.rows = [account('a'), account('b')]
})

const order = async () => value(await queueView(world.deps)).queue
const issuesOf = async () => (await order()).map((entry) => entry.issue)
const prio = (project: string, n: number) => setProjectPrio(world.deps, { project, prio: n }).then(value)

describe('the order of projects', () => {
  test('of equal Issue priority the higher project goes first, though its Issue is the later one', async () => {
    const lowIssue = await world.queued({ repo: 'low' })
    const highIssue = await world.queued({ repo: 'high' })
    expect(await issuesOf()).toEqual([lowIssue, highIssue])
    await prio('high', 5)
    const queue = await order()
    expect(queue.map((e) => e.issue)).toEqual([highIssue, lowIssue])
    expect(queue.map((e) => [e.projectPrio, e.byProjectPrio])).toEqual([
      [5, true],
      [0, false],
    ])
  })

  test('a project priority below zero sends its Issues behind the unset ones', async () => {
    const first = await world.queued({ repo: 'low' })
    const second = await world.queued({ repo: 'high' })
    await prio('low', -3)
    expect(await issuesOf()).toEqual([second, first])
  })

  test("the Issue's own priority outranks its project's", async () => {
    const lowIssue = await world.queued({ repo: 'low' })
    const highIssue = await world.queued({ repo: 'high' })
    await prio('high', 500)
    value(await setPrio(world.deps, { issue: lowIssue, value: 1, key: key('prio', 'low') }))
    const queue = await order()
    expect(queue.map((e) => e.issue)).toEqual([lowIssue, highIssue])
    expect(queue.map((e) => e.byProjectPrio)).toEqual([false, false])
  })

  test('equal project priorities change nothing: the Issue number decides', async () => {
    const lowIssue = await world.queued({ repo: 'low' })
    const highIssue = await world.queued({ repo: 'high' })
    await prio('high', 7)
    await prio('low', 7)
    const queue = await order()
    expect(queue.map((e) => e.issue)).toEqual([lowIssue, highIssue])
    expect(queue.map((e) => e.byProjectPrio)).toEqual([false, false])
  })

  test('the fix of a stopped line stays first in a project of lower priority', async () => {
    const feature = await world.queued({ repo: 'high' })
    const fix = await world.queued({ repo: 'low', kind: 'incident' })
    await prio('high', 900)
    expect(await issuesOf()).toEqual([fix, feature])
  })

  test('an owed lead keeps its place in its repo whatever the project priorities say', async () => {
    const one = await world.queued({ repo: 'low' })
    const two = await world.queued({ repo: 'low' })
    value(await admissionPass(world.deps))
    await world.send(one, 'lead_started', 'lead_started', { attempt: 1, terminal: 't' })
    await world.send(one, 'asked', 'asked', { attempt: 1, decision: { id: 'd1', summary: 'which?' } }, 'lead')
    world.clock.advance(61_000)
    value(await admissionPass(world.deps)) // gives the claim back, admits Issue 2
    await world.send(one, 'answered', 'answered', { decision: 'd1', answer: 'the first' }, 'owner')
    await world.send(two, 'lead_started', 'lead_started', { attempt: 1, terminal: 't2' })
    await world.send(two, 'closed', 'closed', { attempt: 1, outcome: 'done', reason: 'done' }, 'lead')
    await prio('low', -900)
    await prio('high', 900)
    const rival = await world.queued({ repo: 'low' })
    world.clock.advance(61_000)
    const pass = value(await admissionPass(world.deps))
    expect(pass.admitted).toEqual([])
    expect(pass.queue.find((e) => e.issue === rival)?.reason?.kind).toBe('claim')
    expect(value(await resumeClaim(world.deps, one))).toEqual({ result: 'taken' })
    expect(one).toBe(issueId(1))
  })
})

describe('the stored priority', () => {
  test('setting it leaves the state, setting the state leaves it', async () => {
    await prio('high', 4)
    value(await setQueueState(world.deps, { project: 'high', state: 'drain' }))
    const states = value(await getQueueStates(world.deps))
    expect(states.projects.get('high')).toBe('drain')
    expect(states.prios.get('high')).toBe(4)
    await prio('high', 0)
    expect(value(await getQueueStates(world.deps)).projects.get('high')).toBe('drain')
  })

  test('a priority outside -1000 to 1000 is refused', async () => {
    expect(await setProjectPrio(world.deps, { project: 'high', prio: 1001 })).toMatchObject({
      ok: false,
      error: { kind: 'refused' },
    })
    expect(await setProjectPrio(world.deps, { project: 'high', prio: 1.5 })).toMatchObject({ ok: false })
  })
})
