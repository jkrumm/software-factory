import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { RETRO_MARKER } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { postgresLoopStore } from '../../src/adapters/postgres/loop-store.ts'
import { throughputPass, throughputSummary } from '../../src/app/loops/throughput.ts'
import type { UnitOfWork } from '../../src/app/unit-of-work.ts'
import type { LoopStore } from '../../src/domains/loops/ports.ts'
import { loadLoopSettings } from '../../src/app/loops/settings.ts'
import { planSelfwatch } from '../../src/domains/loops/selfwatch.ts'
import { subjectKeyOf } from '../../src/domains/loops/selfwatch-model.ts'
import {
  budgetFindings,
  figureOf,
  movedDown,
  rankCandidates,
  type WindowFacts,
} from '../../src/domains/loops/throughput.ts'
import { budgetsOf, parseProject } from '../../src/domains/planning/project.ts'
import { ok } from '../../src/kernel/result.ts'
import { readBudgetFacts, readIssueFates, readWindowFacts } from '../../src/read/throughput-loop.ts'
import { readRetro } from '../../src/read/retro.ts'

/**
 * The throughput loop: the ranking of a window's costs, the improvement filed per project with its measured before, the
 * ledger reading the after three days past a ship (and bringing a finding that did not move back), and a budget breach as
 * one self-watch signal until it clears. Real Postgres, seeded `step_costs`, Issues and events.
 */
let db: TestCluster
const T0 = new Date('2026-11-14T03:00:00Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR
let now = T0
const clock = { now: () => now }

const uow: UnitOfWork<{ loops: LoopStore }> = {
  run: (work) => work({ loops: postgresLoopStore(db.sql) }),
  inTransaction: () => false,
}

beforeAll(async () => {
  db = await startTestCluster()
  await migrate(db.sql, await loadMigrations())
})
afterAll(() => db.stop())

const ago = (ms: number): Date => new Date(T0.getTime() - ms)

async function step(input: { repo: string; name?: string; at: Date; ms: number; exit?: number; peak?: number }) {
  await db.sql`
    INSERT INTO factory.step_costs (at, name, repo, duration_ms, wait_ms, exit_code, peak_rss_mib)
    VALUES (${input.at}, ${input.name ?? `${input.repo} check`}, ${`/work/${input.repo}`}, ${input.ms}, 0, ${input.exit ?? 0}, ${input.peak ?? null})`
}

let eventNo = 0
async function event(issue: string, kind: string, at: Date, over: { version: number; to?: string; outcome?: string }) {
  eventNo++
  await db.sql`
    INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, to_state, outcome)
    VALUES (${`ev_${eventNo}`}, ${issue}, ${`k_${eventNo}`}, ${kind}, '{}'::jsonb, 'factory', ${at}, 'applied', ${over.version}, ${over.to ?? null}, ${over.outcome ?? null})`
}

describe('the ranking', () => {
  const facts = (over: Partial<WindowFacts> = {}): WindowFacts => ({
    days: 7,
    runs: [],
    perIssue: [],
    steps: [],
    processes: [],
    queued: [],
    ...over,
  })

  test('costs are minutes, largest first, and below their thresholds nothing is a finding', () => {
    const ranked = rankCandidates(
      facts({
        runs: [
          { project: 'a', runs: 10, failedRuns: 4, failedMinutes: 80, minutes: 200 },
          { project: 'b', runs: 10, failedRuns: 1, failedMinutes: 10, minutes: 100 },
        ],
        perIssue: [
          { project: 'a', minutes: 300, closed: 3, baselineMedian: 50 },
          { project: 'b', minutes: 100, closed: 2, baselineMedian: 50 },
          { project: 'c', minutes: 100, closed: 1, baselineMedian: 10 },
        ],
        steps: [{ project: 'a', tier: 'full', runs: 4, peakP90Mib: 3000, budgetMib: 2048, overMinutes: 40 }],
        processes: [
          { name: 'fseventsd', class: 'system', project: 'software-factory', grownMib: 4096, minutes: 300 },
          { name: 'small', class: 'other', project: 'a', grownMib: 100, minutes: 900 },
        ],
        queued: [{ project: 'b', minutes: 20, admissions: 2 }],
      }),
    )
    expect(ranked.map((c) => [c.project, c.kpi, c.costMinutes])).toEqual([
      ['software-factory', 'process_growth_mib', 300],
      ['a', 'slot_minutes_per_issue', 150],
      ['a', 'failed_run_minutes', 80],
      ['a', 'step_peak_mib', 40],
    ])
    const failed = ranked.find((c) => c.kpi === 'failed_run_minutes')
    expect(failed).toMatchObject({ value: 11.4, target: 5.7, unit: 'slot-minutes/day' })
    expect(ranked.find((c) => c.kpi === 'step_peak_mib')).toMatchObject({ value: 3000, target: 2048, subject: 'full' })
  })

  test('an after is the same figure over another window; a project with nothing in it has none', () => {
    const f = facts({
      days: 3,
      runs: [{ project: 'a', runs: 4, failedRuns: 1, failedMinutes: 30, minutes: 60 }],
      steps: [{ project: 'a', tier: 'full', runs: 4, peakP90Mib: 3000, budgetMib: 2048, overMinutes: 40 }],
    })
    expect(figureOf(f, { project: 'a', kpi: 'failed_run_minutes', subject: '*' })).toBe(10)
    expect(figureOf(f, { project: 'b', kpi: 'failed_run_minutes', subject: '*' })).toBeNull()
    expect(figureOf(f, { project: 'a', kpi: 'step_peak_mib', subject: 'full' })).toBe(3000)
    expect(figureOf(f, { project: 'a', kpi: 'process_growth_mib', subject: 'x' })).toBe(0)
  })

  test('moved, flat or worse against the before, ten percent being flat', () => {
    expect(movedDown(100, 80)).toBe('moved')
    expect(movedDown(100, 95)).toBe('flat')
    expect(movedDown(100, 112)).toBe('worse')
    expect(movedDown(0, 0)).toBe('flat')
  })
})

describe('budgets in project.yaml', () => {
  const parse = (budgets: unknown) =>
    parseProject({ apiVersion: 'factory/v2', name: 'app', ...(budgets === undefined ? {} : { budgets }) }, 'app')

  test('a duration, a size and a share are read, a project without any has none, a bad one is refused', () => {
    const ok = parse({ fast: '90s', peak: '2GiB', fail: '10%' })
    expect(ok.ok && budgetsOf(ok.project)).toEqual({ fastMs: 90_000, peakMib: 2048, failShare: 0.1 })
    const none = parse(undefined)
    expect(none.ok && budgetsOf(none.project)).toEqual({ fastMs: null, peakMib: null, failShare: null })
    expect(parse({ fast: 'quick' }).ok).toBe(false)
    expect(parse({ peak: '2' }).ok).toBe(false)
    expect(parse({ fail: '0%' }).ok).toBe(false)
    expect(parse({ speed: '1s' }).ok).toBe(false)
  })

  test('a stored project is read back through the schema with its budgets', () => {
    const first = parse({ fast: '2m' })
    if (!first.ok) throw new Error(first.message)
    const again = parseProject(JSON.parse(JSON.stringify(first.project)), 'app')
    expect(again.ok && budgetsOf(again.project).fastMs).toBe(120_000)
  })
})

describe('a seeded budget breach', () => {
  test('is one signal the day it happens, none while it stays, and files again after it cleared', async () => {
    // yesterday's fast runs of `shop` took 120 s each, the budget is 90 s; its peak and failure budgets hold
    for (const [i, ms] of [120_000, 130_000, 125_000].entries()) {
      await step({ repo: 'shop', name: 'shop check-fast', at: ago((i + 1) * HOUR), ms, peak: 500 })
    }
    const budgets = [{ project: 'shop', repo: 'shop', fastMs: 90_000, peakMib: 2048, failShare: 0.1 }]
    const facts = await readBudgetFacts(db.sql, { now: T0, budgets })
    expect(facts.map((f) => [f.budget, f.over])).toEqual([
      ['fast', true],
      ['peak', false],
      ['fail', false],
    ])
    const found = budgetFindings(facts)
    const breach = found[0]
    if (!breach) throw new Error('no breach found')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ kind: 'budget_breach', subject: 'shop:fast', repo: 'shop' })

    // the first pass files it; the second sees the same evidence and files nothing; once inside the budget it clears
    const first = planSelfwatch(found, [], T0)
    const hash = first.file[0]?.hash ?? ''
    expect(first.file.map((a) => a.finding.subject)).toEqual(['shop:fast'])
    const row = (cleared: Date | null) => ({
      subjectKey: subjectKeyOf(breach),
      kind: 'budget_breach' as const,
      firstSeenAt: T0,
      lastSeenAt: T0,
      evidenceHash: hash,
      lastFiledAt: T0,
      signalId: 'sig_1',
      clearedAt: cleared,
    })
    expect(planSelfwatch(found, [row(null)], T0).file).toHaveLength(0)
    const within = budgetFindings(
      await readBudgetFacts(db.sql, { now: T0, budgets: budgets.map((b) => ({ ...b, fastMs: 200_000 })) }),
    )
    expect(planSelfwatch(within, [row(null)], T0).clear).toEqual([subjectKeyOf(breach)])
    expect(planSelfwatch(found, [row(T0)], T0).file.map((a) => a.why)).toEqual(['reappeared'])
  })

  test('too few runs say nothing, and a budget left out is not judged', async () => {
    await step({ repo: 'few', name: 'few check-fast', at: ago(HOUR), ms: 600_000, peak: 100 })
    const facts = await readBudgetFacts(db.sql, {
      now: T0,
      budgets: [
        { project: 'few', repo: 'few', fastMs: 90_000, peakMib: null, failShare: null },
        { project: 'none', repo: 'none', fastMs: null, peakMib: null, failShare: null },
      ],
    })
    expect(facts.map((f) => [f.project, f.over])).toEqual([['few', false]])
  })
})

describe('the daily pass', () => {
  const issues: string[] = []
  const filedBodies: { title: string; text: string; repo: string }[] = []
  let counter = 0
  const file = async (body: { title: string; text: string; repo?: string; from: string }) => {
    counter++
    const id = `issue_${900 + counter}`
    issues.push(id)
    filedBodies.push({ title: body.title, text: body.text, repo: body.repo ?? '' })
    await db.sql`INSERT INTO factory.issues (id, repo, state, version) VALUES (${id}, ${body.repo ?? ''}, 'queued', 1)`
    await db.sql`INSERT INTO factory.intake_signals (id, key, source, kind, origin, trust, repo, fingerprint, title, text, received_at, state, issue_id)
      VALUES (${`sig_${counter}`}, ${`k_sig_${counter}`}, ${body.from}, 'request', 'factory', 'agent', ${body.repo ?? ''}, ${`fp_${counter}`}, ${body.title}, ${body.text.replaceAll('\n', ' ')}, ${now}, 'filed', ${id})`
    return ok({
      outcome: 'filed' as const,
      detail: 'filed' as never,
      issue: id as never,
      signal: `sig_${counter}`,
      reason: null,
    })
  }
  const deps = () => ({
    uow,
    clock,
    projects: async () =>
      ['alpha', 'beta', 'software-factory'].map((project) => ({
        project,
        repo: project,
        peakMib: null as number | null,
      })),
    facts: (
      window: { from: Date; to: Date },
      options: { baseline: boolean; peakBudgetMib: ReadonlyMap<string, number> },
    ) => readWindowFacts(db.sql, { ...window, ...options }),
    fates: (ids: readonly string[]) => readIssueFates(db.sql, ids),
    file: file as never,
  })

  beforeAll(async () => {
    // alpha: 4 of 10 runs failed at 20 minutes: 80 slot-minutes
    for (let i = 0; i < 10; i++) {
      await step({ repo: 'alpha', at: ago((i + 1) * 10 * HOUR), ms: 20 * 60_000, exit: i < 4 ? 1 : 0 })
    }
    // beta: a full check peaking at 4 GiB, five runs of 10 minutes: 50 minutes over the default budget of 2 GiB
    for (let i = 0; i < 5; i++) await step({ repo: 'beta', at: ago((i + 1) * 12 * HOUR), ms: 10 * 60_000, peak: 4096 })
    // the queue is the factory's: an Issue of any project an Issue waited three hours between filing and its admission
    await db.sql`INSERT INTO factory.issues (id, repo, state, outcome, version) VALUES ('issue_700', 'gamma', 'closed', 'done', 3)`
    await event('issue_700', 'filed', ago(30 * HOUR), { version: 1, to: 'queued' })
    await event('issue_700', 'admitted', ago(27 * HOUR), { version: 2, to: 'working' })
  })

  test('files the largest cost of each project with its measured before, the target and the query', async () => {
    const pass = await throughputPass(deps())
    expect(pass.ok).toBe(true)
    if (!pass.ok) return
    expect(pass.value.filed.map((f) => [f.project, f.kpi, f.costMinutes])).toEqual([
      ['software-factory', 'queued_minutes', 180],
      ['alpha', 'failed_run_minutes', 80],
      ['beta', 'step_peak_mib', 50],
    ])
    expect(throughputSummary(pass.value)).toContain('filed 3')
    const rows =
      await db.sql`SELECT project, kpi, subject, before::float8, target::float8, status, issue_id, query FROM factory.throughput_findings ORDER BY project`
    expect(
      rows.map((r: { project: string; before: number; target: number; status: string }) => [
        r.project,
        r.before,
        r.target,
        r.status,
      ]),
    ).toEqual([
      ['alpha', 11.4, 5.7, 'open'],
      ['beta', 4096, 2048, 'open'],
      ['software-factory', 25.7, 12.9, 'open'],
    ])
    expect(
      rows.every((r: { issue_id: string | null; query: string }) => r.issue_id !== null && r.query.length > 10),
    ).toBe(true)
    const alpha = filedBodies.find((b) => b.repo === 'alpha')
    expect(alpha?.text).toContain('Measured before: 11.4 slot-minutes/day')
    expect(alpha?.text).toContain('Target: 5.7 slot-minutes/day')
    expect(alpha?.text).toContain('Query: ')
    // the retro's ledger reads the marker the text ends with
    const marker = RETRO_MARKER.exec(alpha?.text ?? '')
    expect(marker?.slice(1)).toEqual(['2026-11-14', 'failed_run_minutes', '11.4', 'down'])
  })

  test('a second pass the same day files nothing: each project has an improvement open', async () => {
    const before = filedBodies.length
    const pass = await throughputPass(deps())
    expect(pass.ok && pass.value.filed).toEqual([])
    expect(pass.ok && pass.value.held.toSorted()).toEqual(['alpha', 'beta', 'software-factory'])
    expect(filedBodies.length).toBe(before)
  })

  test('the ledger marks a ship, and reads the after three days past it: moved, or flat and filed again', async () => {
    const rows = await db.sql`SELECT project, issue_id FROM factory.throughput_findings`
    const issueOf = (project: string): string => rows.find((r: { project: string }) => r.project === project).issue_id
    const shipAt = new Date(T0.getTime() + HOUR)
    let version = 10
    for (const project of ['alpha', 'beta']) {
      const id = issueOf(project)
      await event(id, 'shipped', shipAt, { version: version++, to: 'watching' })
      await db.sql`UPDATE factory.issues SET state = 'closed', outcome = 'done' WHERE id = ${id}`
    }
    // the queue finding's Issue closed without a ship
    await db.sql`UPDATE factory.issues SET state = 'closed', outcome = 'dropped' WHERE id = ${issueOf('software-factory')}`
    // the three days after the ship: alpha's runs all passed, beta's step still peaks at 4 GiB
    for (let i = 0; i < 4; i++)
      await step({ repo: 'alpha', at: new Date(shipAt.getTime() + (i + 1) * 10 * HOUR), ms: 20 * 60_000 })
    for (let i = 0; i < 4; i++) {
      await step({ repo: 'beta', at: new Date(shipAt.getTime() + (i + 1) * 10 * HOUR), ms: 10 * 60_000, peak: 4096 })
    }

    now = new Date(T0.getTime() + 2 * HOUR)
    const marked = await throughputPass(deps())
    expect(marked.ok && marked.value.ledger.map((l) => [l.project, l.status]).toSorted()).toEqual([
      ['alpha', 'shipped'],
      ['beta', 'shipped'],
      ['software-factory', 'dropped'],
    ])

    // not yet three days: nothing is read
    now = new Date(T0.getTime() + 2 * DAY)
    const early = await throughputPass(deps())
    expect(early.ok && early.value.ledger).toEqual([])

    // three days and an hour past the ship
    now = new Date(shipAt.getTime() + 3 * DAY + HOUR)
    const before = filedBodies.length
    const read = await throughputPass(deps())
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.value.ledger.map((l) => [l.project, l.status, l.before, l.after])).toEqual([
      ['alpha', 'moved', 11.4, 0],
      ['beta', 'flat', 4096, 4096],
    ])
    const stored =
      await db.sql`SELECT project, status, after::float8, after_at, shipped_at FROM factory.throughput_findings WHERE status IN ('moved', 'flat') ORDER BY project`
    expect(
      stored.every(
        (r: { after_at: Date | null; shipped_at: Date | null }) => r.after_at !== null && r.shipped_at !== null,
      ),
    ).toBe(true)

    // beta's finding did not move: it is ranked again and filed with the earlier attempt named; alpha's moved and is left
    expect(read.value.filed.map((f) => [f.project, f.kpi])).toContainEqual(['beta', 'step_peak_mib'])
    expect(read.value.filed.map((f) => f.project)).not.toContain('alpha')
    const again = filedBodies.slice(before).find((b) => b.repo === 'beta')
    expect(again?.text).toContain('Comes back: an earlier improvement')
    expect(again?.text).toContain('did not move from 4096')
    const [reopened] =
      await db.sql`SELECT reopens FROM factory.throughput_findings WHERE project = 'beta' AND status = 'open'`
    expect(reopened?.reopens).toMatch(/^throughput:beta:step_peak_mib/)
  })

  test('the weekly retro’s ledger carries the loop’s own after as a clean window', async () => {
    const retro = await readRetro(db.sql, { now, days: 7 })
    const alpha = retro.ledger.find((e) => e.kpi === 'failed_run_minutes')
    expect(alpha).toMatchObject({ before: 11.4, now: 0, measured: 'after', moved: 'better' })
  })

  test('the loop runs once a day, and off when the tick is off', () => {
    expect(loadLoopSettings({}).intervalMs.throughput).toBe(24 * HOUR)
    expect(loadLoopSettings({ FACTORY_TICK_MS: '0' }).intervalMs.throughput).toBe(0)
    expect(loadLoopSettings({ FACTORY_LOOP_THROUGHPUT_MS: '60000' }).intervalMs.throughput).toBe(60_000)
  })
})
