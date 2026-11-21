import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  accountOf,
  admissionPass,
  claimStalled,
  moveWalled,
  queueView,
  releaseClaim,
  resumeClaim,
} from '../../src/app/capacity-admit.ts'
import { capacityForLeads } from '../../src/app/capacity-leads.ts'
import { loopReads } from '../../src/read/loops.ts'
import { queueMovedAt } from '../../src/read/queue.ts'
import { setQueueState, setRelearn } from '../../src/app/capacity-queue.ts'
import { setPrio } from '../../src/app/planning-chain.ts'
import { syncProjects } from '../../src/app/planning-sync.ts'
import { issueId, issueNumber } from '../../src/kernel/ids.ts'
import { key } from '../../src/kernel/keys.ts'
import { err, ok, portError } from '../../src/kernel/result.ts'
import { account, closedAccount, startWorld, value, type World } from '../planning/support.ts'

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

describe('the lead aim', () => {
  const sample = (level: number | null, ageMs = 0) =>
    world.db.sql`
      INSERT INTO factory.host_samples (at, load, memory_used_pct, kernel_free_pct, swap_used_pct, swapout_mb_per_300s, pressure_level)
      VALUES (${new Date(world.clock.now().getTime() - ageMs)}, 4, 80, 57, 3.5, 0, ${level})`
  const aim = async (target: number) => {
    await world.db.sql`DELETE FROM factory.slot_aim`
    await world.db.sql`
      INSERT INTO factory.slot_aim (id, target, quiet_since, changed_at, lead_target)
      VALUES (1, 2, NULL, ${world.clock.now()}, ${target})`
  }

  test('no stored count, an unread pressure or a count the running leads reach holds a new lead; room and a normal pressure admit it', async () => {
    world.accounts.rows = [account('a')]
    const one = await world.queued({ repo: 'app' })
    await world.db.sql`DELETE FROM factory.slot_aim`
    await world.db.sql`DELETE FROM factory.host_samples`
    await sample(1)
    const start = value(await admissionPass(world.deps))
    expect(start.admitted).toEqual([])
    expect(start.queue.find((e) => e.issue === one)?.reason).toMatchObject({ kind: 'memory', part: 'aim' })

    await aim(1)
    await world.db.sql`DELETE FROM factory.host_samples`
    await sample(null)
    const unread = value(await admissionPass(world.deps))
    expect(unread.queue.find((e) => e.issue === one)?.reason?.message).toContain('pressure is not read')

    await world.db.sql`DELETE FROM factory.host_samples`
    await sample(1)
    const open = value(await admissionPass(world.deps))
    expect(open.admitted.map((a) => a.issue)).toEqual([one])
    // the claim it took is a lead running: with a count of one a second lead of the repo waits for the aim, not the claim
    const two = await world.queued({ repo: 'app' })
    nextSample()
    await world.db.sql`DELETE FROM factory.host_samples`
    await sample(1)
    const full = value(await admissionPass(world.deps))
    expect(full.queue.find((e) => e.issue === two)?.reason).toMatchObject({ kind: 'memory', part: 'aim' })
  })
})

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

  test('a repo that states no leads has no cap of its own: with memory and load free, six Issues start where the old default of four stopped at four (NL32)', async () => {
    world.accounts.rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => account(name))
    world.source.add('open', {
      project: { state: 'text', sha: 'sha-open', value: { apiVersion: 'factory/v2', name: 'open' } },
    })
    value(await syncProjects(world.deps, { fetch: false }))
    const issues = []
    for (let n = 0; n < 6; n++) issues.push(await world.queued({ repo: 'open' }))
    const result = await pass()
    expect(result.admitted.map((a) => a.issue)).toEqual(issues)
    expect(result.queue.filter((e) => e.reason?.kind === 'claim')).toEqual([])
  })

  test("a red doctor keeps the project's Issues queued with its lines, leaves other projects alone, and the next green reading admits them", async () => {
    world.accounts.rows = [account('a'), account('b'), account('c')]
    world.source.add('gated', {
      project: {
        state: 'text',
        sha: 'sha-gated',
        value: { apiVersion: 'factory/v2', name: 'gated', doctor: 'make doctor' },
      },
    })
    value(await syncProjects(world.deps, { fetch: false }))
    const asked: string[] = []
    let reading: { ok: boolean; lines: string[]; at: Date } | null = {
      ok: false,
      lines: ['lab seed missing; fix: rsync it'],
      at: world.clock.now(),
    }
    world.deps.doctor = {
      async read({ project, command }) {
        asked.push(`${project}: ${command}`)
        return reading
      },
    }
    try {
      const [blocked, free] = [await world.queued({ repo: 'gated' }), await world.queued({ repo: 'app' })]
      const first = await pass()
      expect(first.admitted.map((a) => a.issue)).toEqual([free])
      expect(first.queue.find((e) => e.issue === blocked)?.reason).toMatchObject({
        kind: 'doctor',
        message: 'gated cannot run on this host: lab seed missing; fix: rsync it',
      })
      // only the project that declares a doctor is asked
      expect([...new Set(asked)]).toEqual(['gated: make doctor'])
      expect(await state(issueNumber(blocked))).toBe('queued')

      // a doctor that cannot run says nothing about the host: the project is admitted
      reading = null
      nextSample()
      expect((await pass()).admitted.map((a) => a.issue)).toEqual([blocked])
    } finally {
      delete world.deps.doctor
    }
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

  test("a repo's lead peaks: from the relearn point, the last six hours of an attempt, and ended or 30 minutes in", async () => {
    const now = world.clock.now()
    const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000)
    const sample = async (worktree: string, minutesAgo: number, rssMib: number, repo = 'sim') => {
      await world.db.sql`
        INSERT INTO factory.lead_samples (at, worktree, repo, issue, attempt, rss_mib, procs)
        VALUES (${at(minutesAgo)}, ${worktree}, ${repo}, 1, 1, ${rssMib}, 3)`
    }
    // a long-lived worktree: 9000 MiB eight hours before its last sample, 2000 since: only the last six hours count
    await sample('/wt/long', 600, 9000)
    await sample('/wt/long', 31, 2000)
    await sample('/wt/long', 1, 2100)
    // an attempt that has just begun (running 2 minutes) is not settled; one that ran 40 minutes is, and one that ended is
    await sample('/wt/new', 2, 500)
    await sample('/wt/new', 1, 500)
    await sample('/wt/run', 41, 700)
    await sample('/wt/run', 1, 700)
    await sample('/wt/ended', 120, 800)
    const [peaks] = value(
      await world.deps.uow.run(async ({ capacity }) => ({ ok: true as const, value: await capacity.leadPeaks(now) })),
    )
    expect(peaks?.attempts).toBe(4)
    expect(Object.fromEntries(peaks?.peaksNewestFirst.map((p) => [p.peakMib, p.settled]) ?? [])).toEqual({
      500: false,
      700: true,
      800: true,
      2100: true,
    })
    // a relearn point 90 minutes ago drops the sample before it: the ended attempt has none left and leaves the figure
    await world.db
      .sql`INSERT INTO factory.lead_relearn (repo, at, set_at, set_by) VALUES ('sim', ${at(90)}, ${now}, 'owner')`
    const after = value(
      await world.deps.uow.run(async ({ capacity }) => ({ ok: true as const, value: await capacity.leadPeaks(now) })),
    )
    expect(after[0]?.attempts).toBe(3)
    expect(after[0]?.peaksNewestFirst.map((p) => p.peakMib).sort((a, b) => a - b)).toEqual([500, 700, 2100])
  })

  test('six queued Issues of one repo with room for three by learned size: three are admitted, the rest follow as memory is really free', async () => {
    world.accounts.rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => account(name))
    world.source.add('wide', { project: PROJECT('wide', 8) })
    value(await syncProjects(world.deps, { fetch: false }))
    const at = () => world.clock.now()
    // three settled attempts learn 1600 MiB for the repo
    for (const n of [1, 2, 3]) {
      await world.db.sql`
        INSERT INTO factory.lead_samples (at, worktree, repo, issue, attempt, rss_mib, procs)
        VALUES (${new Date(at().getTime() - n * 3_600_000)}, ${`/wt/wide-${n}`}, 'wide', ${900 + n}, 1, 1600, 3)`
    }
    // 32 GiB, 82.9 % used: 5 603 MiB free (the lead aim keeps no headroom: the pressure level is the margin): room for three leads of 1600 MiB, not four
    const sample = (usedPct: number) =>
      world.db.sql`
        INSERT INTO factory.host_samples (at, load, memory_used_pct, swap_used_pct, swapout_mb_per_300s, pressure_level)
        VALUES (${at()}, 1, ${usedPct}, 10, 0, 1)`
    await sample(82.9)
    const issues: Awaited<ReturnType<typeof world.queued>>[] = []
    for (let i = 0; i < 6; i++) issues.push(await world.queued({ repo: 'wide' }))
    const first = await pass()
    expect(first.admitted.map((a) => a.issue)).toEqual(issues.slice(0, 3))
    const waiting = first.queue.find((e) => e.issue === issues[3])?.reason
    expect(waiting).toMatchObject({ kind: 'memory', part: 'fit' })
    expect(waiting?.message).toContain('3 young leads still take 4.7 GiB more')
    // the leads have not grown and the host really has room: the others follow
    nextSample()
    await sample(40)
    expect((await pass()).admitted.map((a) => a.issue)).toEqual(issues.slice(3))
  })

  test('a relearn point drops a repo back to its lane prior until three attempts follow it, and queue order says so', async () => {
    world.accounts.rows = [account('a'), account('b'), account('c'), account('d')]
    const seed = async (hoursAgo: number, rssMib: number) => {
      await world.db.sql`
        INSERT INTO factory.lead_samples (at, worktree, repo, issue, attempt, rss_mib, procs)
        VALUES (${new Date(world.clock.now().getTime() - hoursAgo * 3_600_000)}, ${`/wt/sim-${hoursAgo}`}, 'sim', ${900 + hoursAgo}, 1, ${rssMib}, 3)`
    }
    for (const hours of [10, 11, 12]) await seed(hours, 100)
    const [one, two] = [
      await world.queued({ repo: 'sim', lane: 'apple' }),
      await world.queued({ repo: 'sim', lane: 'apple' }),
    ]
    // learned 100 MiB replaces the lane's 18 GiB: both fit
    expect((await pass()).admitted.map((a) => a.issue)).toEqual([one, two])
    for (const n of [one, two]) {
      await world.send(n, 'lead_started', 'lead_started', { attempt: 1, terminal: `t${n}` })
      await world.send(n, 'closed', 'closed', { attempt: 1, outcome: 'done', reason: 'done' }, 'lead')
    }
    nextSample()
    // the relearn point (now) leaves no attempt after it: the prior holds, one lead at a time
    value(await setRelearn(world.deps, { repo: 'sim', at: null, actor: 'owner' }))
    const [three, four] = [
      await world.queued({ repo: 'sim', lane: 'apple' }),
      await world.queued({ repo: 'sim', lane: 'apple' }),
    ]
    const held = await pass()
    expect(held.admitted.map((a) => a.issue)).toEqual([three])
    expect(held.queue.find((e) => e.issue === four)?.reason).toMatchObject({ kind: 'memory' })
    const view = value(await queueView(world.deps))
    expect(
      view.notes.some(
        (n) => n.includes('sim: lead cost learned from after the relearn point') && n.includes('fewer than three'),
      ),
    ).toBe(true)
    // a point in the future is refused
    const future = await setRelearn(world.deps, {
      repo: 'sim',
      at: new Date(world.clock.now().getTime() + 60_000),
      actor: 'owner',
    })
    expect(future.ok).toBe(false)
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
    world.accounts.rows = [
      account('a', { weeklyUsed: 10, fiveHourUsed: 80 }),
      account('b', { weeklyUsed: 50, fiveHourUsed: 80 }),
    ]
    await world.queued({ repo: 'app' })
    await world.queued({ repo: 'app' })
    const result = await pass()
    expect(result.admitted.map((a) => a.account)).toEqual(['a', 'b'])
    expect(value(await accountOf(world.deps, issueId(1), 1))).toBe('a')
    expect(value(await accountOf(world.deps, issueId(2), 1))).toBe('b')
    expect(value(await accountOf(world.deps, issueId(2), 2))).toBeNull()
  })

  test('with one account with its 5-hour window above 70 % and leads: 2, the second lead waits for the next sample (window)', async () => {
    world.accounts.rows = [account('me', { fiveHourUsed: 80 })]
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

  test('the load is read again before every admission: a host that got busy since the pass began admits no further lead (Issue 1742)', async () => {
    world.accounts.rows = [account('a'), account('b')]
    const [one, two] = [await world.queued({ repo: 'app' }), await world.queued({ repo: 'app' })]
    // readHost 10, before the first admission 10, before the second 75 (ceiling 60)
    world.host.loadQueue = [ok(10), ok(10), ok(75)]
    const result = await pass()
    expect(result.admitted.map((a) => a.issue)).toEqual([one])
    expect(reasons(result)[two]).toBe('load')
  })

  test('a load reading that fails after one that was over the ceiling keeps that reading: the lead is not admitted without it', async () => {
    const issue = await world.queued({ repo: 'app' })
    world.host.loadQueue = [ok(75), { ok: false, error: { kind: 'timeout', detail: 'slow' } }]
    const result = await pass()
    expect(result.admitted).toEqual([])
    expect(reasons(result)).toEqual({ [issue]: 'load' })
    expect(result.notes).toEqual([])
  })

  test('the load gate is the tripwire: five minutes on end over the ceiling keep a lead out, a peak or a reading back under it does not', async () => {
    const issue = await world.queued({ repo: 'app' })
    const now = world.clock.now()
    const minutes = async (loads: number[]) => {
      await world.db.sql`DELETE FROM factory.host_samples`
      for (const [i, load] of loads.entries())
        await world.db.sql`
          INSERT INTO factory.host_samples (at, load, memory_used_pct, swap_used_pct, swapout_mb_per_300s, pressure_level)
          VALUES (${new Date(now.getTime() - i * 60_000)}, ${load}, 40, 2, 0, 1)`
    }
    // a peak among quiet minutes, read at 75 over the ceiling of 60: admitted
    await minutes([75, 20, 20, 20, 20])
    world.host.loadValue = ok(75)
    expect((await pass()).admitted.map((a) => a.issue)).toEqual([issue])

    const next = await world.queued({ repo: 'app' })
    nextSample()
    await minutes([75, 70, 68, 66, 64])
    world.host.loadValue = ok(75)
    const shut = await pass()
    expect(shut.queue.find((e) => e.issue === next)?.reason?.message).toBe(
      'the machine is busy: load over 60 in each of the last 5 minutes (75, 70, 68, 66, 64)',
    )
    // the reading before the admission is back under the ceiling: the trip clears
    world.host.loadQueue = [ok(75), ok(30)]
    expect((await pass()).admitted.map((a) => a.issue)).toEqual([next])
  })

  test('a long test line keeps a new lead out and the pass reads it from the slots; it opens when the line drains', async () => {
    const issue = await world.queued({ repo: 'app' })
    const now = world.clock.now()
    const ago = (ms: number) => new Date(now.getTime() - ms)
    // a step took 30 s over the last day; one runs, three have waited five minutes
    await world.db.sql`
      INSERT INTO factory.step_costs (at, name, repo, peak_rss_mib, cpu_seconds, duration_ms, wait_ms, exit_code)
      VALUES (${ago(3_600_000)}, 'app unit', '/src/app', 500, 10, 30000, 0, 0)`
    await world.db.sql`
      INSERT INTO factory.capacity_slots (id, name, requested_at, seen_at, slot, leased_until, granted_at)
      VALUES ('h', 'app unit', ${ago(60_000)}, ${now}, 1, ${new Date(now.getTime() + 30_000)}, ${ago(60_000)})`
    for (const id of ['w1', 'w2', 'w3'])
      await world.db.sql`
        INSERT INTO factory.capacity_slots (id, name, requested_at, seen_at) VALUES (${id}, ${id}, ${ago(300_000)}, ${now})`
    const shut = await pass()
    expect(shut.admitted).toEqual([])
    expect(shut.queue.find((e) => e.issue === issue)?.reason).toMatchObject({
      kind: 'tests',
      message:
        'the test line is long: 3 steps wait for a slot beside 1 running, half of them for over 5 min, longer than the 0.5 min a step takes (median of the last day)',
    })
    await world.db.sql`DELETE FROM factory.capacity_slots WHERE id IN ('w2', 'w3')`
    expect((await pass()).admitted.map((a) => a.issue)).toEqual([issue])
  })

  test('a host that booted 5 min ago admits nothing new, whatever the load: the reason names the boot', async () => {
    const issue = await world.queued({ repo: 'app' })
    world.host.uptimeValue = ok(5 * 60_000)
    const result = await pass()
    expect(result.admitted).toEqual([])
    expect(result.queue.find((e) => e.issue === issue)?.reason).toMatchObject({ kind: 'boot' })
    expect(result.queue.find((e) => e.issue === issue)?.reason?.message).toContain('host booted 5 min ago')
    world.host.uptimeValue = { ok: false, error: { kind: 'unreadable', detail: 'no boottime' } }
    const unread = await pass()
    expect(unread.admitted.map((a) => a.issue)).toEqual([issue])
    expect(unread.notes).toContain('uptime reading failed (no boottime): the boot grace does not apply this pass')
    world.host.uptimeValue = ok(24 * 3_600_000)
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
    world.accounts.rows = [closedAccount('a')]
    const issue = await world.queued({ repo: 'app' })
    const result = await pass()
    const reason = result.queue.find((e) => e.issue === issue)?.reason
    expect(reason).toMatchObject({ kind: 'window', opensAt: new Date('2026-11-07T15:00:00Z') })
    expect(reason?.message).toContain('5 h window is at 100 %')
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
    world.accounts.rows = [account('me', { fiveHourUsed: 80 })]
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

  test("a claim taken inside a Decision wait (the Judge's back) stands past the pass until the lead settles; one from before the wait goes back", async () => {
    const one = await world.queued({ repo: 'solo' })
    const two = await world.queued({ repo: 'solo' })
    await pass()
    await asked()
    const claims = async () =>
      (await world.db.sql`SELECT issue_id FROM factory.capacity_claims ORDER BY issue_id`).map(
        (r: { issue_id: string }) => r.issue_id,
      )
    // the claim from before the wait is no one's: Issue 2 takes the place
    nextSample()
    await pass()
    expect(await claims()).toEqual([issueId(2)])
    await world.send(two, 'closed', 'closed', { attempt: 1, outcome: 'done', reason: 'done' }, 'lead')

    // the lead the Judge's back woke takes a claim after the wait began: it stands, and counts as a lead at work
    world.clock.advance(1_000)
    expect(value(await resumeClaim(world.deps, one))).toEqual({ result: 'taken' })
    nextSample()
    await pass()
    expect(await claims()).toEqual([one])
    const three = await world.queued({ repo: 'solo' })
    nextSample()
    expect(reasons(await pass())[three]).toBe('claim')

    // it settles: the Issue works again and keeps the place
    await world.send(one, 'answered', 'answered', { decision: 'd1', answer: 'the first' }, 'owner')
    nextSample()
    await pass()
    expect(await claims()).toEqual([one])
    expect(value(await releaseClaim(world.deps, one))).toBe(true)
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
    world.accounts.rows = [account('me', { fiveHourUsed: 80 })]
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
      message: 'every open account is at its lead cap: me 2 of 2',
    })
    expect(value(await resumeClaim(world.deps, one))).toEqual({ result: 'taken' })
    const [claim] = await world.db.sql`SELECT account FROM factory.capacity_claims WHERE issue_id = ${one}`
    expect(claim.account).toBe('me')
  })

  test('a woken lead resumes on its own account whatever the cap: the account cap never refuses a resume', async () => {
    world.accounts.rows = [account('me', { fiveHourUsed: 80 })]
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

describe('a walled lead moves to another account', () => {
  const wall = (issue: ReturnType<typeof issueId>) =>
    world.send(issue, 'wall', 'stalled', { attempt: 1, cause: 'wall', detail: 'the account ran out' }, 'factory')
  const claimOf = async (issue: ReturnType<typeof issueId>) =>
    (await world.db.sql`SELECT account FROM factory.capacity_claims WHERE issue_id = ${issue}`)[0]?.account
  const limits = { leadsPerAccount: 2, loadCeiling: 60, memoryCeilings: { swapoutMbPer300s: 2048, swapUsedPct: 75 } }

  test('the attempt and its claim go to the open account with room; the account it left is never the answer', async () => {
    world.accounts.rows = [account('me'), account('other', { weeklyUsed: 60 })]
    const one = await world.queued({ repo: 'solo' })
    expect((await pass()).admitted).toEqual([{ issue: one, attempt: 1, account: 'me', repo: 'solo' }])
    await wall(one)
    world.accounts.rows = [closedAccount('me'), account('other', { weeklyUsed: 60 })]
    nextSample()
    await pass()
    expect(value(await moveWalled(world.deps, limits, { issue: one, attempt: 1 }))).toEqual({ from: 'me', to: 'other' })
    expect(value(await accountOf(world.deps, one, 1))).toBe('other')
    expect(await claimOf(one)).toBe('other')
    // moved once: the same call finds no other account open and room (me is closed)
    expect(value(await moveWalled(world.deps, limits, { issue: one, attempt: 1 }))).toBeNull()
  })

  test('no other open account, a full one, or an Issue that is not on a wall: it stays where it is', async () => {
    world.accounts.rows = [account('me'), account('other', { weeklyUsed: 60 })]
    const one = await world.queued({ repo: 'solo' })
    await pass()
    // not waiting on a wall: nothing moves
    expect(value(await moveWalled(world.deps, limits, { issue: one, attempt: 1 }))).toBeNull()
    await wall(one)
    // the other account is at its cap
    expect(
      value(await moveWalled(world.deps, { ...limits, leadsPerAccount: 0 }, { issue: one, attempt: 1 })),
    ).toBeNull()
    // the other account is closed too
    world.accounts.rows = [closedAccount('me'), closedAccount('other')]
    nextSample()
    await pass()
    expect(value(await moveWalled(world.deps, limits, { issue: one, attempt: 1 }))).toBeNull()
    // an attempt that is no longer the Issue's newest
    expect(value(await moveWalled(world.deps, limits, { issue: one, attempt: 2 }))).toBeNull()
    expect(await claimOf(one)).toBe('me')
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

  test('the window of an account is when its newest reading says it opens again; an unknown account or reset has none', async () => {
    const port = capacityForLeads(world.deps)
    world.accounts.rows = [
      closedAccount('me'),
      // the wall came before the sample: the window nearest its limit is the one that closes
      account('behind', { fiveHourUsed: 97, weeklyUsed: 40, wallResetAt: new Date('2026-11-07T15:00:00Z') }),
      account('week', { fiveHourUsed: null, weeklyUsed: 98, wallResetAt: new Date('2026-11-10T00:00:00Z') }),
      account('open', { fiveHourResetsAt: null, weeklyResetsAt: null }),
    ]
    value(await admissionPass(world.deps))
    const hit = new Date(world.clock.now().getTime() + 1_000)
    expect(value(await port.windows.wall('me'))).toEqual({ resetAt: new Date('2026-11-07T15:00:00Z') })
    expect(value(await port.windows.wall('behind', hit))).toEqual({ resetAt: new Date('2026-11-07T15:00:00Z') })
    expect(value(await port.windows.wall('week', hit))).toEqual({ resetAt: new Date('2026-11-10T00:00:00Z') })
    // a sample taken after the wall that shows the account open: it is open
    expect(value(await port.windows.wall('behind', new Date(world.clock.now().getTime() - 60_000)))).toEqual({
      resetAt: null,
    })
    expect(value(await port.windows.wall('open', hit))).toEqual({ resetAt: null })
    expect(value(await port.windows.wall('nobody'))).toEqual({ resetAt: null })
  })

  test('the queue last moved when its newest event happened: none before there is one', async () => {
    expect(await queueMovedAt(world.db.sql)).toBeNull()
    await world.queued({ repo: 'solo' })
    expect(await queueMovedAt(world.db.sql)).toEqual(world.clock.now())
  })
})

describe("the package's order", () => {
  test('the open account first in the order is admitted though another has lower weekly use, and the order is stored', async () => {
    world.accounts.rows = [
      account('a', { weeklyUsed: 60, fiveHourUsed: 80 }),
      account('b', { weeklyUsed: 10, fiveHourUsed: 80 }),
    ]
    await world.queued({ repo: 'solo' })
    const result = await pass()
    expect(result.admitted.map((a) => a.account)).toEqual(['a'])
    expect(result.notes).toEqual([])
    const stored = await world.db
      .sql`SELECT account, bulk_open, bulk_position FROM factory.capacity_readings ORDER BY account`
    expect(stored.map((r: { account: string; bulk_position: number }) => [r.account, r.bulk_position])).toEqual([
      ['a', 1],
      ['b', 2],
    ])
  })

  test('a position the package names decides, not the order of the rows', async () => {
    world.accounts.rows = [account('a', { position: 2 }), account('b', { position: 1 })]
    await world.queued({ repo: 'solo' })
    expect((await pass()).admitted.map((a) => a.account)).toEqual(['b'])
  })

  test('an account the package closes takes no lead, and the refusal says why and when it opens', async () => {
    const opens = new Date('2026-11-07T15:00:00Z')
    world.accounts.rows = [account('a', { open: false, closedWhy: 'paused by its mode', opensAt: opens })]
    await world.queued({ repo: 'solo' })
    const result = await pass()
    expect(result.admitted).toEqual([])
    expect(result.queue[0]?.reason).toMatchObject({ kind: 'window', opensAt: opens })
    expect(result.queue[0]?.reason?.message).toContain('paused by its mode')
  })

  test('readings the poll stopped renewing go stale and admit nothing', async () => {
    world.accounts.rows = [account('a')]
    await world.queued({ repo: 'solo' })
    value(await admissionPass(world.deps, { limit: 0 }))
    world.accounts.fail = true
    world.clock.advance(11 * 60_000)
    const result = await pass()
    expect(result.admitted).toEqual([])
    expect(result.notes).toEqual([expect.stringContaining('account poll failed')])
  })
})
