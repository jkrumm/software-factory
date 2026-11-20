import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { admissionPass } from '../../src/app/capacity-admit.ts'
import { syncProjects } from '../../src/app/planning-sync.ts'
import { type AdmissionInputs, checkAdmission } from '../../src/domains/capacity/admission.ts'
import { planWaits, waitKindOf } from '../../src/domains/capacity/waits.ts'
import { MEMORY_FIT_KIND } from '../../src/kernel/throughput-limits.ts'
import { improvementTitle, rankCandidates } from '../../src/domains/loops/throughput.ts'
import { ok } from '../../src/kernel/result.ts'
import { readWindowFacts } from '../../src/read/throughput-loop.ts'
import { account, startWorld, value, type World } from '../planning/support.ts'

let world: World

beforeAll(async () => {
  world = await startWorld()
})
afterAll(async () => {
  await world.stop()
})

const PROJECT = (name: string, leads = 1, lanes: Record<string, number> = {}) => ({
  state: 'text' as const,
  sha: `sha-${name}`,
  value: { apiVersion: 'factory/v2', name, leads, lanes },
})

beforeEach(async () => {
  await world.reset()
  world.source.add('solo', { project: PROJECT('solo', 1) })
  world.source.add('lab', { project: PROJECT('lab', 2, { apple: 1 }) })
  value(await syncProjects(world.deps, { fetch: false }))
})

const MIN = 60_000
const SHORT = { swapoutMbPer300s: 0, swapUsedPct: 99 }
const intervalsOf = async (issue: string) =>
  (await world.db.sql`
    SELECT kind, project, from_at, to_at FROM factory.queue_intervals WHERE issue_id = ${issue} ORDER BY from_at, id`) as {
    kind: string
    project: string
    from_at: Date
    to_at: Date | null
  }[]

describe('queue intervals', () => {
  test('an Issue that waits 30 minutes for memory and then 10 for its repo’s claim reads back as two intervals', async () => {
    world.accounts.rows = [account('a'), account('b')]
    const first = await world.queued({ repo: 'solo' })
    const second = await world.queued({ repo: 'solo' })
    const start = world.clock.now()

    world.host.memoryValue = ok(SHORT)
    value(await admissionPass(world.deps))
    // a pass that finds the same reason opens nothing new
    world.clock.advance(10 * MIN)
    value(await admissionPass(world.deps))
    expect((await intervalsOf(second)).map((i) => [i.kind, i.to_at])).toEqual([['memory', null]])

    world.clock.advance(20 * MIN)
    world.host.memoryValue = ok({ swapoutMbPer300s: 0, swapUsedPct: 10 })
    await world.calm()
    const opened = world.clock.now()
    const admitted = value(await admissionPass(world.deps))
    expect(admitted.admitted.map((a) => a.issue)).toEqual([first])

    world.clock.advance(10 * MIN)
    value(await admissionPass(world.deps))
    await world.send(first, 'lead_started', 'lead_started', { attempt: 1, terminal: 't1' })
    await world.send(first, 'closed', 'closed', { attempt: 1, outcome: 'done', reason: 'done' }, 'lead')
    const closed = world.clock.now()
    await world.calm()
    const last = value(await admissionPass(world.deps))
    expect(last.admitted.map((a) => a.issue)).toEqual([second])

    const waits = await intervalsOf(second)
    expect(waits.map((i) => [i.kind, i.project])).toEqual([
      ['memory', 'solo'],
      ['claim', 'solo'],
    ])
    expect(waits[0]?.from_at).toEqual(start)
    expect(waits[0]?.to_at).toEqual(opened)
    expect(waits[1]?.from_at).toEqual(opened)
    // the claim wait ends at the pass that admitted the Issue
    expect(waits[1]?.to_at).toEqual(closed)
    expect((waits[1]?.to_at?.getTime() ?? 0) - opened.getTime()).toBe(10 * MIN)

    // the first Issue waited for memory only, and its interval ended when it was admitted
    expect((await intervalsOf(first)).map((i) => [i.kind, i.to_at])).toEqual([['memory', opened]])
    // nothing is open any more
    const [open] = await world.db.sql`SELECT count(*)::int AS n FROM factory.queue_intervals WHERE to_at IS NULL`
    expect(open?.n).toBe(0)
  })
})

describe('what the intervals are told by', () => {
  test('a refusal of the learned fit is its own kind under memory', () => {
    const inputs = (over: Partial<AdmissionInputs>): AdmissionInputs => ({
      now: new Date('2026-11-07T12:00:00Z'),
      state: 'run',
      leads: 4,
      holders: [],
      owed: [],
      candidate: { issue: 'issue_1' as never, urgent: false, since: null },
      lane: null,
      reserved: null,
      load: 3,
      loadCeiling: 60,
      memory: { swapoutMbPer300s: 0, swapUsedPct: 10 },
      memoryCeilings: { swapoutMbPer300s: 2048, swapUsedPct: 75 },
      accounts: [],
      loaded: new Set(),
      leadsByAccount: new Map(),
      leadsPerAccount: 2,
      ...over,
    })
    const fit = checkAdmission(
      inputs({
        leadFit: { repo: 'heavy', candidateMib: 28_000, attempts: 5, freeMib: 30_000, headroomMib: 2_621, running: 1 },
      }),
    )
    const host = checkAdmission(inputs({ memory: SHORT }))
    expect(!fit.admit && fit.refusal).toMatchObject({ kind: 'memory', part: 'fit' })
    expect(!host.admit && host.refusal).toMatchObject({ kind: 'memory' })
    expect(!host.admit && host.refusal.part).toBeUndefined()
    if (fit.admit || host.admit) throw new Error('both refuse')
    expect(waitKindOf(fit.refusal)).toBe(MEMORY_FIT_KIND)
    expect(waitKindOf(host.refusal)).toBe('memory')
    expect(waitKindOf({ kind: 'claim' })).toBe('claim')
  })

  test('a plan closes an interval when the kind changes or the Issue leaves, and opens one only on a change', () => {
    const seen = (issue: string, kind: string) => ({ issue, project: 'p', kind, message: 'm' })
    const plan = planWaits(
      [
        { id: 1, issue: 'issue_1', kind: 'memory' },
        { id: 2, issue: 'issue_2', kind: 'claim' },
        { id: 3, issue: 'issue_3', kind: 'lane' },
      ],
      [seen('issue_1', 'memory'), seen('issue_2', 'window'), seen('issue_4', 'cap')],
    )
    expect(plan.close).toEqual([2, 3])
    expect(plan.start.map((s) => [s.issue, s.kind])).toEqual([
      ['issue_2', 'window'],
      ['issue_4', 'cap'],
    ])
  })
})

describe('the throughput loop reads the waits by reason', () => {
  test('one fact per binding reason: memory and account on the factory, claim and lane on the repo with its leads and lanes', async () => {
    world.accounts.rows = [account('a')]
    const a = await world.queued({ repo: 'solo' })
    const b = await world.queued({ repo: 'lab', lane: 'apple' })
    const c = await world.queued({ repo: 'lab' })
    const t0 = world.clock.now()
    const at = (minutes: number) => new Date(t0.getTime() + minutes * MIN)
    const rows: [string, string, string, number, number | null][] = [
      [a, 'solo', 'memory', 0, 400],
      [b, 'lab', 'memory_fit', 0, 100],
      [b, 'lab', 'lane', 100, 160],
      [c, 'lab', 'claim', 0, 60],
      [a, 'solo', 'window', 400, 440],
      [c, 'lab', 'chain', 60, 5000], // an after edge is no cost of the factory: left out
      [c, 'lab', 'spec', 5000, null],
      [a, 'solo', 'load', 440, 460], // not ranked either
    ]
    for (const [issue, project, kind, from, to] of rows)
      await world.db.sql`INSERT INTO factory.queue_intervals (issue_id, project, kind, message, from_at, to_at)
        VALUES (${issue}, ${project}, ${kind}, 'because', ${at(from)}, ${to === null ? null : at(to)})`

    const shapes = new Map([
      ['solo', { leads: 1, lanes: new Map<string, number | null>() }],
      ['lab', { leads: 2, lanes: new Map<string, number | null>([['apple', 1]]) }],
    ])
    const facts = await readWindowFacts(world.db.sql, {
      from: t0,
      to: at(7 * 24 * 60),
      baseline: false,
      peakBudgetMib: new Map(),
      shapes,
    })
    const key = (w: { reason: string; project: string }) => `${w.reason}@${w.project}`
    expect(facts.waits.map((w) => [key(w), w.minutes, w.issues]).toSorted()).toEqual([
      ['account@software-factory', 40, 1],
      ['claim@lab', 60, 1],
      ['lane@lab', 60, 1],
      ['memory@software-factory', 500, 2],
    ])
    const memory = facts.waits.find((w) => w.reason === 'memory')
    expect(memory).toMatchObject({
      fitMinutes: 100,
      repos: [
        { project: 'solo', minutes: 400 },
        { project: 'lab', minutes: 100 },
      ],
    })
    expect(facts.waits.find((w) => w.reason === 'lane')).toMatchObject({
      leads: 2,
      lanes: [{ name: 'apple', leads: 1, minutes: 60 }],
    })

    const ranked = rankCandidates({ ...facts, days: 7 }).filter((r) => r.kpi === 'queued_minutes')
    // below 30 minutes nothing is filed; the largest first
    expect(ranked.map((r) => [r.project, r.subject, r.costMinutes])).toEqual([
      ['software-factory', 'memory', 500],
      ['lab', 'claim', 60],
      ['lab', 'lane', 60],
      ['software-factory', 'account', 40],
    ])
    expect(ranked[0]?.label).toContain('hit most: solo 400 min, lab 100 min')
    expect(ranked[0]?.label).toContain('100 min of it a lead that did not fit')
    const lane = ranked.find((r) => r.subject === 'lane')
    expect(lane?.label).toContain('leads: 2')
    expect(lane?.label).toContain('apple (leads: 1) 60 min')
    expect(improvementTitle({ project: 'lab', kpi: 'queued_minutes', subject: 'lane' })).toBe(
      'Throughput: cut the time Issues wait queued for a lane in lab',
    )
  })
})
