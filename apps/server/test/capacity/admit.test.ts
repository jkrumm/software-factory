import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  accountOf,
  admissionPass,
  claimStalled,
  queueView,
  releaseClaim,
  resumeClaim,
} from '../../src/app/capacity-admit.ts'
import { capacityForLeads } from '../../src/app/capacity-leads.ts'
import { standingPolicies } from '../../src/app/planning-policies.ts'
import { loopReads } from '../../src/read/loops.ts'
import { queueMovedAt } from '../../src/read/queue.ts'
import { setQueueState } from '../../src/app/capacity-queue.ts'
import { setPrio } from '../../src/app/planning-chain.ts'
import { syncProjects } from '../../src/app/planning-sync.ts'
import { issueId } from '../../src/kernel/ids.ts'
import { key } from '../../src/kernel/keys.ts'
import { err, ok, portError } from '../../src/kernel/result.ts'
import { account, startWorld, value, type World } from '../planning/support.ts'

let world: World

beforeAll(async () => {
  world = await startWorld()
})
afterAll(async () => {
  await world.stop()
})

const PROJECT = (name: string, leads = 1, lanes: Record<string, number | object> = {}) => ({
  state: 'text' as const,
  sha: `sha-${name}`,
  value: { apiVersion: 'factory/v2', name, leads, lanes },
})

beforeEach(async () => {
  await world.reset()
  world.source.add('app', { project: PROJECT('app', 2) })
  world.source.add('solo', { project: PROJECT('solo', 1) })
  world.source.add('lab', { project: PROJECT('lab', 2, { apple: 1 }) })
  world.source.add('sim', { project: PROJECT('sim', 3, { apple: { leads: 2, memory: '18GiB' } }) })
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
  test('leads: 2 admits two leads in one repo, a third waits for a claim, and a close frees it', async () => {
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

  test('lanes: {apple: 1} with leads: 2 starts one apple Issue and the lane-less one, and the second apple Issue waits until the first closes', async () => {
    world.accounts.rows = [account('a'), account('b'), account('c')]
    const [apple1, apple2, plain] = [
      await world.queued({ repo: 'lab', lane: 'apple' }),
      await world.queued({ repo: 'lab', lane: 'apple' }),
      await world.queued({ repo: 'lab' }),
    ]
    const first = await pass()
    expect(first.admitted.map((a) => a.issue)).toEqual([apple1, plain])
    expect(first.queue.find((e) => e.issue === apple2)?.reason).toMatchObject({
      kind: 'lane',
      message: 'lane apple is full (1 of 1): Issue 1',
    })
    expect(await state(2)).toBe('queued')
    // the cap is on the lane, not on the repo: a third lane-less place is not taken by it
    expect((await pass()).admitted).toEqual([])

    await world.send(apple1, 'lead_started', 'lead_started', { attempt: 1, terminal: 't1' })
    await world.send(apple1, 'closed', 'closed', { attempt: 1, outcome: 'done', reason: 'done' }, 'lead')
    nextSample()
    expect((await pass()).admitted.map((a) => a.issue)).toEqual([apple2])
    expect(await state(2)).toBe('working')
  })

  test("a heavy lane's memory counts as host memory: leads of the lane reserve it while they run, and every next lead meets it", async () => {
    world.accounts.rows = [account('a'), account('b'), account('c')]
    // RAM 32 GiB, swap 10%: one apple lead (18 GiB = 56%) fits under 75%, a second one on top (112%) does not
    const [one, two, plain] = [
      await world.queued({ repo: 'sim', lane: 'apple' }),
      await world.queued({ repo: 'sim', lane: 'apple' }),
      await world.queued({ repo: 'sim' }),
    ]
    const first = await pass()
    expect(first.admitted.map((a) => a.issue)).toEqual([one, plain])
    expect(first.queue.find((e) => e.issue === two)?.reason).toMatchObject({
      kind: 'memory',
      message: expect.stringContaining('36 GiB reserved by lanes (112.5% of RAM)'),
    })
    // the lane's leads: 2 would have let it in: the memory is what keeps it out
    await world.send(one, 'lead_started', 'lead_started', { attempt: 1, terminal: 't1' })
    await world.send(one, 'closed', 'closed', { attempt: 1, outcome: 'done', reason: 'done' }, 'lead')
    nextSample()
    expect((await pass()).admitted.map((a) => a.issue)).toEqual([two])
    // without a RAM reading nothing is reserved, and the pass says so
    world.host.ramMibValue = err(portError('gone', 'no sysctl'))
    await world.queued({ repo: 'sim', lane: 'apple' })
    nextSample()
    const blind = await pass()
    expect(blind.notes.some((n) => n.includes('RAM reading failed'))).toBe(true)
    expect(blind.admitted).toHaveLength(1)
  })

  test("a repo's learned lead cost replaces its lanes' memory: dropped with three attempts, kept with two", async () => {
    world.accounts.rows = [account('a'), account('b'), account('c')]
    const seed = async (...attempts: number[]) => {
      for (const n of attempts) {
        await world.db.sql`
          INSERT INTO factory.lead_samples (at, worktree, repo, issue, attempt, rss_mib, procs)
          VALUES (${new Date(world.clock.now().getTime() - n * 3_600_000)}, ${`/wt/sim-${n}`}, 'sim', ${900 + n}, 1, 100, 3)`
      }
    }
    await seed(1, 2)
    const [one, two] = [
      await world.queued({ repo: 'sim', lane: 'apple' }),
      await world.queued({ repo: 'sim', lane: 'apple' }),
    ]
    const prior = await pass()
    expect(prior.admitted.map((a) => a.issue)).toEqual([one])
    expect(prior.queue.find((e) => e.issue === two)?.reason).toMatchObject({ kind: 'memory' })
    await seed(3)
    nextSample()
    expect((await pass()).admitted.map((a) => a.issue)).toEqual([two])
  })

  test('a lane the project does not declare is unlimited within leads, and a fix is not held by a full lane', async () => {
    world.accounts.rows = [account('a'), account('b'), account('c')]
    const [one, two] = [
      await world.queued({ repo: 'lab', lane: 'web' }),
      await world.queued({ repo: 'lab', lane: 'web' }),
    ]
    expect((await pass()).admitted.map((a) => a.issue)).toEqual([one, two])
    const fix = await world.queued({ repo: 'lab', lane: 'apple', kind: 'incident' })
    const held = await world.queued({ repo: 'lab', lane: 'apple' })
    nextSample()
    // production of lab is red: only the fix runs, and the apple lane is empty anyway
    const result = await pass()
    expect(result.admitted.map((a) => a.issue)).toEqual([fix])
    expect(result.queue.find((e) => e.issue === held)?.reason?.kind).not.toBe('lane')
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
    const [{ claims }] = await world.db.sql`SELECT count(*)::int AS claims FROM factory.capacity_claims`
    expect(claims).toBe(1)
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

describe('claims and the claim on resume', () => {
  const asked = async () => {
    // a lead that asked the owner a question: the machine waits on a decision
    await world.send(issueId(1), 'lead_started', 'lead_started', { attempt: 1, terminal: 't' })
    await world.send(issueId(1), 'asked', 'asked', { attempt: 1, decision: { id: 'd1', summary: 'which?' } }, 'lead')
  }

  test('a wait that needs a person gives the claim back at the next pass; the next Issue of a full repo runs meanwhile', async () => {
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

  test('the answered lead takes a claim back before it is told: refused while the repo is full, then granted when it frees', async () => {
    const one = await world.queued({ repo: 'solo' })
    const two = await world.queued({ repo: 'solo' })
    await pass()
    await asked()
    nextSample()
    await pass() // gives Issue 1's claim back, admits Issue 2
    expect(await state(2)).toBe('working')

    await world.send(one, 'answered', 'answered', { decision: 'd1', answer: 'the first' }, 'owner')
    expect(await state(1)).toBe('working')
    const refused = await resumeClaim(world.deps, one)
    expect(refused).toMatchObject({ ok: false, error: { kind: 'refused' } })
    expect(!refused.ok && refused.error.detail).toContain('waits for a claim in solo')

    // the owed lead is served before any new one: a third Issue cannot take the place it waits for
    const three = await world.queued({ repo: 'solo' })
    await world.send(two, 'lead_started', 'lead_started', { attempt: 1, terminal: 't2' })
    await world.send(two, 'closed', 'closed', { attempt: 1, outcome: 'done', reason: 'done' }, 'lead')
    nextSample()
    const result = await pass()
    expect(result.admitted).toEqual([])
    expect(reasons(result)[three]).toBe('claim')
    expect(value(await resumeClaim(world.deps, one))).toEqual({ result: 'taken' })
    expect(value(await resumeClaim(world.deps, one))).toEqual({ result: 'held' })
  })

  test('a lead back from a wait takes its lane place back too: refused while another lead of a capped lane works, granted when it closes', async () => {
    world.accounts.rows = [account('a'), account('b')]
    const one = await world.queued({ repo: 'lab', lane: 'apple' })
    const two = await world.queued({ repo: 'lab', lane: 'apple' })
    expect((await pass()).admitted.map((a) => a.issue)).toEqual([one])
    await asked()
    nextSample()
    // Issue 1 gave its claim, and with it its lane place, back: Issue 2 runs in the lane meanwhile
    expect((await pass()).admitted.map((a) => a.issue)).toEqual([two])

    await world.send(one, 'answered', 'answered', { decision: 'd1', answer: 'the first' }, 'owner')
    const refused = await resumeClaim(world.deps, one)
    expect(refused).toMatchObject({ ok: false, error: { kind: 'refused' } })
    expect(!refused.ok && refused.error.detail).toContain('lane apple is full (1 of 1): Issue 2')

    await world.send(two, 'lead_started', 'lead_started', { attempt: 1, terminal: 't2' })
    await world.send(two, 'closed', 'closed', { attempt: 1, outcome: 'done', reason: 'done' }, 'lead')
    expect(value(await resumeClaim(world.deps, one))).toEqual({ result: 'taken' })
  })

  test('three owed leads and one free claim: the earliest wait end takes it, the others take the following ones, a replay takes nothing twice', async () => {
    const one = await world.queued({ repo: 'solo' })
    const two = await world.queued({ repo: 'solo' })
    const three = await world.queued({ repo: 'solo' })
    const issues = [one, two, three]
    // each lead is admitted in turn, asks the owner and so gives its claim back
    for (const [index, issue] of issues.entries()) {
      nextSample()
      expect((await pass()).admitted.map((a) => a.issue)).toEqual([issue])
      await world.send(issue, 'lead_started', 'lead_started', { attempt: 1, terminal: `t${index}` })
      await world.send(
        issue,
        'asked',
        'asked',
        { attempt: 1, decision: { id: `d${index}`, summary: 'which?' } },
        'lead',
      )
    }
    nextSample()
    await pass()
    // answered in the order 3, 1, 2: that is the order the waits ended in, not the Issue numbers
    for (const [index, issue] of [three, one, two].entries()) {
      world.clock.advance(1_000)
      const decision = `d${issues.indexOf(issue)}`
      await world.send(issue, `answered-${index}`, 'answered', { decision, answer: 'the first' }, 'owner')
    }
    const claims = async () =>
      (await world.db.sql`SELECT issue_id FROM factory.capacity_claims ORDER BY issue_id`).map(
        (row: { issue_id: string }) => row.issue_id,
      )

    // a herd waits its turn: only the first in order is a stall, the ones behind it are a rightful wait
    expect(value(await claimStalled(world.deps, [one, two, three]))).toEqual([{ issue: three, account: 'me' }])
    // no owed lead is refused while a claim is free for the first of them: the ones behind wait, the first takes it
    for (const behind of [one, two]) expect(await resumeClaim(world.deps, behind)).toMatchObject({ ok: false })
    expect(value(await resumeClaim(world.deps, three))).toEqual({ result: 'taken' })
    expect(value(await resumeClaim(world.deps, three))).toEqual({ result: 'held' })
    expect(await claims()).toEqual([three])
    expect(value(await claimStalled(world.deps, [one, two]))).toEqual([])
    const behind = await resumeClaim(world.deps, one)
    expect(behind).toMatchObject({ ok: false })
    expect(!behind.ok && behind.error.detail).toContain('resumes on account me, whose cap never holds a resume back')

    // the claim frees when its lead is done: the next in order takes it, and only it
    await world.send(three, 'cancelled-3', 'cancelled', { reason: 'x' }, 'owner')
    expect(await resumeClaim(world.deps, two)).toMatchObject({ ok: false })
    expect(value(await resumeClaim(world.deps, one))).toEqual({ result: 'taken' })
    expect(await claims()).toEqual([one])
    await world.send(one, 'cancelled-1', 'cancelled', { reason: 'x' }, 'owner')
    expect(value(await resumeClaim(world.deps, two))).toEqual({ result: 'taken' })
    expect(await claims()).toEqual([two])
  })

  test('the steward sees a note refused for a claim: the read, and the repos that have one free', async () => {
    const one = await world.queued({ repo: 'solo' })
    const two = await world.queued({ repo: 'solo' })
    await pass()
    await asked()
    nextSample()
    await pass()
    await world.send(one, 'answered', 'answered', { decision: 'd1', answer: 'the first' }, 'owner')
    // the repo's one place is Issue 2's
    expect(value(await claimStalled(world.deps, [one]))).toEqual([])
    const [note] = await world.db
      .sql`SELECT key FROM factory.issue_effects WHERE kind = 'note_lead' AND issue_id = ${one}`
    for (const minute of [0, 5]) {
      await world.db.sql`
        INSERT INTO factory.issue_effect_runs (effect_key, at, ok, error_kind, detail)
        VALUES (${note.key}, ${new Date(world.clock.now().getTime() + minute * 60_000)}, false, 'refused', 'Issue 1 waits for a claim in solo: the repo runs 1 of 1 leads (Issue 2)')`
    }
    const refused = await loopReads(world.db.sql).claimRefusals(10)
    expect(refused).toMatchObject([{ issue: one, repo: 'solo', refusals: 2 }])
    // a run of another kind after them (the lead was mid-turn) ends the run: the claim was taken
    await world.db.sql`
      INSERT INTO factory.issue_effect_runs (effect_key, at, ok, error_kind, detail)
      VALUES (${note.key}, ${world.clock.now()}, false, 'refused', 'the lead is mid-turn')`
    expect(await loopReads(world.db.sql).claimRefusals(10)).toEqual([])
    // Issue 2 closes: the place is free, and the refusal is a stall that names the account the lead resumes on
    await world.send(two, 'cancelled', 'cancelled', { reason: 'x' }, 'owner')
    expect(value(await claimStalled(world.deps, [one]))).toEqual([{ issue: one, account: 'me' }])
  })

  // one account, two leads at most (the test world), three repos
  const answered = async (issue: ReturnType<typeof issueId>) => {
    await world.send(issue, 'answered', 'answered', { decision: 'd1', answer: 'the first' }, 'owner')
  }

  test('a woken lead holds its account seat from the moment its wait ends: a new lead does not take it, and the resume then fits the cap', async () => {
    const one = await world.queued({ repo: 'app' })
    const two = await world.queued({ repo: 'solo' })
    expect((await pass()).admitted.map((a) => a.issue)).toEqual([one])
    nextSample()
    expect((await pass()).admitted.map((a) => a.issue)).toEqual([two])
    await asked()
    nextSample()
    await pass() // Issue 1 gave its claim back: the account carries one lead
    const three = await world.queued({ repo: 'lab' })
    // a long wait: more than the newest 200 assignments were written since Issue 1 was admitted
    await world.db.sql`
      INSERT INTO factory.capacity_assignments (issue_id, attempt, account, repo, assigned_at)
      SELECT ${two}, n, 'x', 'solo', ${world.clock.now()} FROM generate_series(2, 250) AS n`
    await answered(one) // Issue 1 is woken and owed: its seat on the account is taken again
    nextSample()
    const result = await pass()
    expect(result.admitted).toEqual([])
    expect(result.queue.find((e) => e.issue === three)?.reason).toMatchObject({
      kind: 'cap',
      message: 'every open account carries 2 leads already',
    })
    expect(value(await resumeClaim(world.deps, one))).toEqual({ result: 'taken' })
    const [claim] = await world.db.sql`SELECT account FROM factory.capacity_claims WHERE issue_id = ${one}`
    expect(claim.account).toBe('me')
  })

  test('a woken lead resumes on its own account whatever the cap: the account cap never refuses a resume', async () => {
    const one = await world.queued({ repo: 'app' })
    const two = await world.queued({ repo: 'solo' })
    const three = await world.queued({ repo: 'lab' })
    expect((await pass()).admitted.map((a) => a.issue)).toEqual([one])
    await asked()
    nextSample()
    await pass() // Issue 1 gave its claim back, and Issue 2 took the account's place
    nextSample()
    await pass() // Issue 3 takes the second: the account carries two leads, its cap
    expect((await pass()).queue).toEqual([])
    await answered(one)
    expect(value(await resumeClaim(world.deps, one))).toEqual({ result: 'taken' })
    const [{ n }] = await world.db.sql`SELECT count(*)::int AS n FROM factory.capacity_claims WHERE account = 'me'`
    expect(n).toBe(3)
    expect([two, three].every((issue) => issue !== one)).toBe(true)
  })

  test('the claim of a closed Issue goes back by the sweep or by finalize, idempotently', async () => {
    const one = await world.queued({ repo: 'solo' })
    await pass()
    expect(value(await releaseClaim(world.deps, one))).toBe(true)
    expect(value(await releaseClaim(world.deps, one))).toBe(false)
    // a working Issue without a claim is owed one: resume takes it
    expect(value(await resumeClaim(world.deps, one))).toEqual({ result: 'taken' })
    await world.send(one, 'cancelled', 'cancelled', { reason: 'x' }, 'owner')
    await pass()
    const [{ claims }] = await world.db.sql`SELECT count(*)::int AS claims FROM factory.capacity_claims`
    expect(claims).toBe(0)
  })
})

describe('the ports other packages take', () => {
  test('the leads get the account an attempt was admitted on, default when it was admitted outside capacity, and give a claim back once', async () => {
    const port = capacityForLeads(world.deps)
    const admitted = await world.queued({ repo: 'solo' })
    await pass()
    expect(value(await port.seats.seat({ issue: admitted, attempt: 1 }))).toEqual({ account: 'me' })
    expect(value(await port.seats.seat({ issue: admitted, attempt: 2 }))).toEqual({ account: 'default' })
    expect(value(await port.claims.release({ issue: admitted, attempt: 1 }))).toBeUndefined()
    expect(value(await port.claims.release({ issue: admitted, attempt: 1 }))).toBeUndefined()
    const [{ n }] = await world.db.sql`SELECT count(*)::int AS n FROM factory.capacity_claims`
    expect(n).toBe(0)
  })

  test('the window of an account is when its newest reading says it opens again; an open or unknown account has none', async () => {
    const port = capacityForLeads(world.deps)
    world.accounts.rows = [account('me', { fiveHourUsed: 90 }), account('open')]
    value(await admissionPass(world.deps))
    expect(value(await port.windows.wall('me'))).toEqual({ resetAt: new Date('2026-11-07T15:00:00Z') })
    expect(value(await port.windows.wall('open'))).toEqual({ resetAt: null })
    expect(value(await port.windows.wall('nobody'))).toEqual({ resetAt: null })
  })

  test("the checkpoints' standing policy is the project's policy: rules, none for a repo that is no project", async () => {
    world.source.add('policed', {
      project: {
        state: 'text',
        sha: 'p',
        value: {
          apiVersion: 'factory/v2',
          name: 'policed',
          policy: [{ when: 'which database', answer: 'postgres', reason: 'decided once' }],
        },
      },
    })
    value(await syncProjects(world.deps, { fetch: false }))
    const policies = standingPolicies(world.deps)
    expect(value(await policies.rulesFor('policed'))).toEqual([
      { when: 'which database', answer: 'postgres', reason: 'decided once' },
    ])
    expect(value(await policies.rulesFor('app'))).toEqual([])
    expect(value(await policies.rulesFor('unknown'))).toEqual([])
  })

  test('the queue last moved when its newest event happened: none before there is one', async () => {
    expect(await queueMovedAt(world.db.sql)).toBeNull()
    await world.queued({ repo: 'solo' })
    expect(await queueMovedAt(world.db.sql)).toEqual(world.clock.now())
  })
})

describe('the picker rank', () => {
  test('an ok rank is stored and orders the pick: its head is admitted though another account has lower weekly use', async () => {
    world.accounts.rows = [account('a', { weeklyUsed: 60 }), account('b', { weeklyUsed: 10 })]
    world.ranker.rows = [
      { account: 'a', reason: 'home', weight: 0.4 },
      { account: 'b', reason: 'home', weight: 0.1 },
    ]
    await world.queued({ repo: 'solo' })
    const result = await pass()
    expect(result.admitted.map((a) => a.account)).toEqual(['a'])
    expect(result.notes).toEqual([])
    const [stored] = await world.db.sql`SELECT lane, ordering FROM factory.capacity_ranks`
    expect(stored?.lane).toBe('bulk')
    const ordering = typeof stored?.ordering === 'string' ? JSON.parse(stored.ordering) : stored?.ordering
    expect(ordering.map((r: { account: string }) => r.account)).toEqual(['a', 'b'])
  })

  test('a failed rank read admits by lowest weekly use and puts a note in the pass notes', async () => {
    world.accounts.rows = [account('a', { weeklyUsed: 60 }), account('b', { weeklyUsed: 10 })]
    world.ranker.fail = true
    await world.queued({ repo: 'solo' })
    const result = await pass()
    expect(result.admitted.map((a) => a.account)).toEqual(['b'])
    expect(result.notes).toEqual([expect.stringContaining('account rank read failed')])
    expect(result.notes[0]).toContain('ordered by lowest weekly use')
    expect(await world.db.sql`SELECT lane FROM factory.capacity_ranks`).toHaveLength(0)
  })

  test('a rank the poll stopped renewing goes stale and no longer orders the pick', async () => {
    world.accounts.rows = [account('a', { weeklyUsed: 60 }), account('b', { weeklyUsed: 10 })]
    world.ranker.rows = [{ account: 'a', reason: 'home', weight: null }]
    await world.queued({ repo: 'solo' })
    value(await admissionPass(world.deps, { limit: 0 }))
    world.ranker.fail = true
    world.clock.advance(11 * 60_000)
    // the readings are renewed by the poll, the rank is not: it is 11 minutes old
    const result = await pass()
    expect(result.admitted.map((a) => a.account)).toEqual(['b'])
    expect(result.notes).toEqual([expect.stringContaining('account rank read failed')])
  })
})
