import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { accountOf, admissionPass, queueView, releaseSeat, resumeSeat } from '../../src/app/capacity-admit.ts'
import { setQueueState } from '../../src/app/capacity-queue.ts'
import { setPrio } from '../../src/app/planning-chain.ts'
import { syncProjects } from '../../src/app/planning-sync.ts'
import { issueId } from '../../src/kernel/ids.ts'
import { key } from '../../src/kernel/keys.ts'
import { ok } from '../../src/kernel/result.ts'
import { account, startWorld, value, type World } from '../planning/support.ts'

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
  value: { apiVersion: 'factory/v2', name, leads },
})

beforeEach(async () => {
  await world.reset()
  world.source.add('app', { project: PROJECT('app', 2) })
  world.source.add('solo', { project: PROJECT('solo', 1) })
  value(await syncProjects(world.deps, { fetch: false }))
})

const pass = async () => value(await admissionPass(world.deps))
/** The picker is polled once a minute and an account takes one new lead per sample: a later pass sees a later sample. */
const nextSample = () => world.clock.advance(61_000)
const state = async (n: number) => {
  const [row] = await world.db.sql`SELECT state FROM factory.issues WHERE id = ${`issue_${n}`}`
  return row?.state as string
}
const reasons = (result: Awaited<ReturnType<typeof pass>>) =>
  Object.fromEntries(result.queue.map((e) => [e.issue, e.reason?.kind ?? null]))

describe('admission', () => {
  test('leads: 2 admits two leads in one repo, a third waits for a seat, and a close frees it', async () => {
    world.accounts.rows = [account('a'), account('b')]
    const [one, two, three] = [
      await world.queued({ repo: 'app' }),
      await world.queued({ repo: 'app' }),
      await world.queued({ repo: 'app' }),
    ]
    const first = await pass()
    expect(first.admitted.map((a) => a.issue)).toEqual([one, two])
    expect(first.queue.find((e) => e.issue === three)?.reason).toMatchObject({ kind: 'claim' })
    expect(await state(3)).toBe('queued')

    // nothing starts twice, and the third still waits
    expect((await pass()).admitted).toEqual([])
    await world.send(one, 'lead_started', 'lead_started', { attempt: 1, terminal: 't1' })
    await world.send(one, 'closed', 'closed', { attempt: 1, outcome: 'done', reason: 'done' }, 'lead')
    nextSample()
    const after = await pass()
    expect(after.admitted.map((a) => a.issue)).toEqual([three])
    expect(await state(3)).toBe('working')
  })

  test('each lead is admitted on an account; one account takes one new lead per sample', async () => {
    world.accounts.rows = [account('a', { weeklyUsed: 10 }), account('b', { weeklyUsed: 50 })]
    await world.queued({ repo: 'app' })
    await world.queued({ repo: 'app' })
    const result = await pass()
    expect(result.admitted.map((a) => a.account)).toEqual(['a', 'b'])
    expect(value(await accountOf(world.deps, issueId(1), 1))).toBe('a')
    expect(value(await accountOf(world.deps, issueId(2), 1))).toBe('b')
    expect(value(await accountOf(world.deps, issueId(2), 2))).toBeNull()
  })

  test('with one account and leads: 2, the second lead waits for the next sample (window)', async () => {
    await world.queued({ repo: 'app' })
    const two = await world.queued({ repo: 'app' })
    const result = await pass()
    expect(result.admitted).toHaveLength(1)
    expect(result.queue.find((e) => e.issue === two)?.reason).toMatchObject({
      kind: 'window',
      message: expect.stringContaining('took a lead since their last sample'),
    })
  })

  test('a memory ceiling keeps a queued Issue out, and the reason says memory and the numbers', async () => {
    const issue = await world.queued({ repo: 'app' })
    world.host.memoryValue = ok({ swapoutMbPer300s: 3100, swapUsedPct: 80 })
    const result = await pass()
    expect(result.admitted).toEqual([])
    expect(result.queue.find((e) => e.issue === issue)?.reason).toMatchObject({
      kind: 'memory',
      message: 'the host is short of memory: swapouts 3100 MiB/300s (ceiling 2048), swap 80% of RAM (ceiling 75%)',
    })
    expect(await state(1)).toBe('queued')
    world.host.memoryValue = ok({ swapoutMbPer300s: 10, swapUsedPct: 40 })
    expect((await pass()).admitted.map((a) => a.issue)).toEqual([issue])
  })

  test('the load ceiling, a reading that fails (admitted without it, with a note) and a drain', async () => {
    const issue = await world.queued({ repo: 'app' })
    world.host.loadValue = ok(75)
    expect(reasons(await pass())).toEqual({ [issue]: 'load' })
    world.host.loadValue = { ok: false, error: { kind: 'unreadable', detail: 'no loadavg' } }
    value(await setQueueState(world.deps, { project: 'app', state: 'drain' }))
    expect(reasons(await pass())).toEqual({ [issue]: 'drain' })
    value(await setQueueState(world.deps, { project: 'app', state: 'run' }))
    const result = await pass()
    expect(result.admitted.map((a) => a.issue)).toEqual([issue])
    expect(result.notes).toEqual(['load reading failed (no loadavg): new leads are admitted without it'])
  })

  test('a drain of the whole queue keeps every project out; nothing running is touched', async () => {
    const a = await world.queued({ repo: 'app' })
    await pass()
    const b = await world.queued({ repo: 'solo' })
    value(await setQueueState(world.deps, { project: null, state: 'drain' }))
    expect(reasons(await pass())).toEqual({ [b]: 'drain' })
    expect(await state(1)).toBe('working')
    expect(a).toBe(issueId(1))
  })

  test('every account closed: never spills, and the reason names when the first one opens', async () => {
    world.accounts.rows = [account('a', { fiveHourUsed: 90 })]
    const issue = await world.queued({ repo: 'app' })
    const result = await pass()
    const reason = result.queue.find((e) => e.issue === issue)?.reason
    expect(reason).toMatchObject({ kind: 'window', opensAt: new Date('2026-11-07T15:00:00Z') })
    expect(reason?.message).toContain('5-hour window at 90%')
  })

  test('prio orders the queue, higher first, before age', async () => {
    world.accounts.rows = [account('a'), account('b'), account('c')]
    await world.queued({ repo: 'app' })
    const second = await world.queued({ repo: 'app' })
    const third = await world.queued({ repo: 'app' })
    value(await setPrio(world.deps, { issue: third, value: 50, key: key('prio', 'p') }))
    const result = await pass()
    expect(result.admitted.map((a) => a.issue)).toEqual([third, issueId(1)])
    expect(result.queue.map((e) => e.issue)).toContain(second)
  })

  test('stop the line: with an incident queued, only the fix is admitted in its project', async () => {
    world.accounts.rows = [account('a'), account('b')]
    const feature = await world.queued({ repo: 'solo' })
    const fix = await world.queued({ repo: 'solo', kind: 'incident' })
    const other = await world.queued({ repo: 'app' })
    const result = await pass()
    expect(result.admitted.map((a) => a.issue)).toEqual([fix, other])
    expect(reasons(result)[feature]).toBe('line')
    // the fix is working: the line stays stopped until it is not queued or working
    expect(reasons(await pass())[feature]).toBe('line')
    await world.send(fix, 'lead_started', 'lead_started', { attempt: 1, terminal: 't' })
    await world.send(fix, 'closed', 'closed', { attempt: 1, outcome: 'done', reason: 'fixed' }, 'lead')
    nextSample()
    expect((await pass()).admitted.map((a) => a.issue)).toEqual([feature])
  })

  test('an Issue with an open blocker is not admitted and says what it waits for', async () => {
    const blocker = await world.file({ repo: 'app' })
    const dependent = await world.file({ repo: 'app' })
    const { settleIssue } = await import('../../src/app/planning-chain.ts')
    value(await settleIssue(world.deps, { issue: dependent, after: [blocker] }))
    value(await settleIssue(world.deps, { issue: blocker, after: [] }))
    const result = await pass()
    expect(result.admitted.map((a) => a.issue)).toEqual([blocker])
    expect(result.queue.find((e) => e.issue === dependent)?.reason).toMatchObject({
      kind: 'chain',
      message: 'waits for Issue 1 to close',
    })
    await world.send(blocker, 'lead_started', 'lead_started', { attempt: 1, terminal: 't' })
    await world.send(blocker, 'closed', 'closed', { attempt: 1, outcome: 'dropped', reason: 'not needed' }, 'lead')
    nextSample()
    value(await admissionPass(world.deps))
    expect(await state(2)).toBe('working')
  })

  test('an Issue whose repo is no project the factory has read stays queued with that reason', async () => {
    const issue = await world.queued({ repo: '/src/unknown' })
    expect(reasons(await pass())).toEqual({ [issue]: 'unknown_project' })
  })

  test('the pass is replay-safe: the same pass again admits nothing twice, concurrent passes admit once', async () => {
    world.accounts.rows = [account('a'), account('b')]
    await world.queued({ repo: 'solo' })
    await Promise.all([admissionPass(world.deps), admissionPass(world.deps)])
    const [{ n }] = await world.db.sql`SELECT count(*)::int AS n FROM factory.issue_events WHERE kind = 'admitted'`
    expect(n).toBe(1)
    const [{ seats }] = await world.db.sql`SELECT count(*)::int AS seats FROM factory.capacity_seats`
    expect(seats).toBe(1)
    const effects = await world.db.sql`SELECT key FROM factory.issue_effects WHERE kind = 'start_lead'`
    expect(effects.map((e: { key: string }) => e.key)).toEqual(['start_lead:issue_1:1'])
  })

  test('the queue view shows the order and the reasons without admitting anything', async () => {
    await world.queued({ repo: 'app' })
    const second = await world.queued({ repo: 'app' })
    const view = value(await queueView(world.deps))
    expect(view.queue.map((e) => [e.issue, e.reason?.kind ?? null])).toEqual([
      [issueId(1), null],
      [second, 'window'],
    ])
    expect(await state(1)).toBe('queued')
  })
})

describe('seats and the claim on resume', () => {
  const asked = async () => {
    // a lead that asked the owner a question: the machine waits on a decision
    await world.send(issueId(1), 'lead_started', 'lead_started', { attempt: 1, terminal: 't' })
    await world.send(issueId(1), 'asked', 'asked', { attempt: 1, decision: { id: 'd1', summary: 'which?' } }, 'lead')
  }

  test('a wait that needs a person gives the seat back at the next pass; the next Issue of a full repo runs meanwhile', async () => {
    const one = await world.queued({ repo: 'solo' })
    const two = await world.queued({ repo: 'solo' })
    await pass()
    expect(await state(1)).toBe('working')
    expect(reasons(await admissionPass(world.deps).then(value))[two]).toBe('claim')
    await asked()
    nextSample()
    const next = await pass()
    expect(next.admitted.map((a) => a.issue)).toEqual([two])
    expect(one).toBe(issueId(1))
  })

  test('the answered lead takes a seat back before it is told: refused while the repo is full, then granted when it frees', async () => {
    const one = await world.queued({ repo: 'solo' })
    const two = await world.queued({ repo: 'solo' })
    await pass()
    await asked()
    nextSample()
    await pass() // gives Issue 1's seat back, admits Issue 2
    expect(await state(2)).toBe('working')

    await world.send(one, 'answered', 'answered', { decision: 'd1', answer: 'the first' }, 'owner')
    expect(await state(1)).toBe('working')
    const refused = await resumeSeat(world.deps, one)
    expect(refused).toMatchObject({ ok: false, error: { kind: 'refused' } })
    expect(!refused.ok && refused.error.detail).toContain('waits for a seat in solo')

    // the owed lead is served before any new one: a third Issue cannot take the place it waits for
    const three = await world.queued({ repo: 'solo' })
    await world.send(two, 'lead_started', 'lead_started', { attempt: 1, terminal: 't2' })
    await world.send(two, 'closed', 'closed', { attempt: 1, outcome: 'done', reason: 'done' }, 'lead')
    nextSample()
    const result = await pass()
    expect(result.admitted).toEqual([])
    expect(reasons(result)[three]).toBe('claim')
    expect(value(await resumeSeat(world.deps, one))).toEqual({ result: 'taken' })
    expect(value(await resumeSeat(world.deps, one))).toEqual({ result: 'held' })
  })

  test('the seat of a closed Issue goes back by the sweep or by finalize, idempotently', async () => {
    const one = await world.queued({ repo: 'solo' })
    await pass()
    expect(value(await releaseSeat(world.deps, one))).toBe(true)
    expect(value(await releaseSeat(world.deps, one))).toBe(false)
    // a working Issue without a seat is owed one: resume takes it
    expect(value(await resumeSeat(world.deps, one))).toEqual({ result: 'taken' })
    await world.send(one, 'cancelled', 'cancelled', { reason: 'x' }, 'owner')
    await pass()
    const [{ seats }] = await world.db.sql`SELECT count(*)::int AS seats FROM factory.capacity_seats`
    expect(seats).toBe(0)
  })
})
