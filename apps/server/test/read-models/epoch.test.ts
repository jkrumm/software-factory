import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { CapacityLoopModel, ThroughputModel } from '@software-factory/contract'
import { seedFinding } from '../seed-ledger.ts'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { postgresLoopStore } from '../../src/adapters/postgres/loop-store.ts'
import { loadEpoch } from '../../src/adapters/throughput-epoch.ts'
import { throughputPass } from '../../src/app/loops/throughput.ts'
import type { UnitOfWork } from '../../src/app/unit-of-work.ts'
import type { LoopStore } from '../../src/app/loops/stores.ts'
import { readCapacityLoop } from '../../src/read/capacity-loop.ts'
import { readThroughput } from '../../src/read/throughput.ts'
import { readWindowFacts } from '../../src/read/throughput-loop.ts'
import { countedFrom, epochNote } from '../../src/kernel/epoch.ts'
import { type FindingRow, readLedger } from '../../src/domains/improve/throughput.ts'
import { answersOf } from '../../src/read/throughput-answers.ts'
import { redactAnswers } from '../../src/read/throughput-redact.ts'

/**
 * The counting epoch: samples on both sides of it, and every read that counts them (the throughput model with its three
 * answers, the capacity loop, the loop's window facts with their medians over earlier days, the ranking pass).
 * Real Postgres. The clock is 2026-11-14 12:00; the epoch sits where each test puts it.
 */
let db: TestCluster
const NOW = new Date('2026-11-14T12:00:00Z')
const t = (iso: string): Date => new Date(`2026-${iso}:00Z`)
const EPOCH = t('11-12T00:00')

const constants = {
  leadsPerAccount: 3,
  accountLeads: {},
  loadCeiling: 8,
  slots: 2,
  slotsMax: 6,
  slotExtraLoad: 12,
  allowanceMaxBonus: 2,
  reaperGraceMs: 300_000,
  swapoutCeilingMb: 2048,
  swapCeilingPct: 80,
  loadPerCore: 3,
  processCap: 1800,
  cores: 12,
}

const uow: UnitOfWork<{ loops: LoopStore }> = {
  run: (work) => work({ loops: postgresLoopStore(db.sql) }),
  inTransaction: () => false,
}

let keys = 0
async function closed(id: string, at: Date, repo = 'app') {
  await db.sql`INSERT INTO factory.issues (id, repo, state, outcome, version) VALUES (${id}, ${repo}, 'closed', 'done', 2)
    ON CONFLICT DO NOTHING`
  await db.sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, from_state, to_state, outcome)
    VALUES (${`event_${++keys}`}, ${id}, ${`key_${keys}`}, 'closed', '{}'::jsonb, 'factory', ${at}, 'applied', 2, 'working', 'closed', 'done')`
}

beforeAll(async () => {
  db = await startTestCluster()
  await migrate(db.sql, await loadMigrations())
  const { sql } = db

  // host minutes: one before the epoch (critical, swap 90), two after (warning, then normal)
  for (const [at, level, swap] of [
    [t('11-11T10:00'), 4, 90],
    [t('11-13T10:00'), 2, 10],
    [t('11-13T10:01'), 1, 20],
  ] as const)
    await sql`INSERT INTO factory.host_samples (at, load, swap_used_pct, memory_used_pct, pressure_level)
      VALUES (${at}, 2, ${swap}, 50, ${level})`
  for (const [at, footprint] of [
    [t('11-11T10:00'), 9000],
    [t('11-13T10:00'), 1000],
    [t('11-13T10:01'), 1000],
  ] as const)
    await sql`INSERT INTO factory.host_class_samples (at, class, repo, tenant, footprint_mib, cpu_ms, procs)
      VALUES (${at}, 'lead', 'app', null, ${footprint}, 1, 1)`

  // queue waits: 12 h before the epoch, 6 h after, 3 h of one that crosses it, a 2 h claim after
  for (const id of ['issue_1', 'issue_2', 'issue_3'])
    await sql`INSERT INTO factory.issues (id, repo, state, version) VALUES (${id}, 'app', 'queued', 1)`
  for (const [issue, kind, from, to] of [
    ['issue_1', 'memory', t('11-11T08:00'), t('11-11T20:00')],
    ['issue_1', 'memory', t('11-13T00:00'), t('11-13T06:00')],
    ['issue_3', 'memory_fit', t('11-11T22:00'), t('11-12T03:00')],
    ['issue_2', 'claim', t('11-12T00:00'), t('11-12T02:00')],
  ] as const)
    await sql`INSERT INTO factory.queue_intervals (issue_id, project, kind, message, from_at, to_at)
      VALUES (${issue}, 'app', ${kind}, 'because', ${from}, ${to})`

  // the tenant class by the hour: 3000 MiB before the epoch, 7000 after
  for (const [hour, mib] of [
    [t('11-11T09:00'), 3000],
    [t('11-13T09:00'), 7000],
    [t('11-13T10:00'), 7000],
  ] as const)
    await sql`INSERT INTO factory.host_class_hours (hour, class, repo, tenant, mib_minutes, peak_mib, cpu_seconds, minutes)
      VALUES (${hour}, 'tenant', '', 'vm:one', ${mib * 60}, ${mib}, 0, 60)`

  for (const [id, project, filed] of [
    ['finding_old', 'app', '2026-11-10T08:00:00Z'],
    ['finding_new', 'lib', '2026-11-13T08:00:00Z'],
  ] as const)
    await seedFinding(sql, {
      id,
      project,
      kpi: 'failed_run_minutes',
      before: 60,
      target: 30,
      unit: 'minutes',
      costMinutes: id === 'finding_old' ? 500 : 80,
      filedAt: new Date(filed),
      status: 'open',
    })

  // closed Issues and steps per day, for the capacity read and the median per Issue: 100 slot-minutes before the epoch
  // 11-10, 10 after (days 11-12 and 11-13), one Issue a day
  for (const [day, minutes] of [
    ['11-05', 100],
    ['11-06', 100],
    ['11-07', 100],
    ['11-08', 100],
    ['11-09', 100],
    ['11-10', 10],
    ['11-11', 10],
    ['11-12', 10],
    ['11-13', 10],
    ['11-14', 10],
  ] as const) {
    await sql`INSERT INTO factory.step_costs (at, name, repo, duration_ms, wait_ms, exit_code, peak_rss_mib)
      VALUES (${t(`${day}T08:00`)}, 'app check', '/work/app', ${minutes * 60_000}, 0, 0, null)`
    await closed(`issue_${100 + Number(day.slice(3))}${day.slice(0, 2)}`, t(`${day}T09:00`))
  }
})
afterAll(() => db.stop())

describe('the throughput read counts nothing before the epoch', () => {
  const read = (epoch: Date | null, over: Record<string, unknown> = {}) =>
    readThroughput(db.sql, { now: NOW, hours: 120, epoch, ...over })

  test('a cut window starts at the epoch and says so; every figure ignores the earlier samples', async () => {
    const model = ThroughputModel.parse(await read(EPOCH))
    expect(model.window).toEqual({ from: EPOCH.toISOString(), to: NOW.toISOString() })
    expect(model.epoch).toEqual({ at: EPOCH.toISOString(), cut: true, countingSince: EPOCH.toISOString() })
    expect(model.host.minutes).toBe(2)
    expect(model.host.signals.pressureMinutes).toEqual({ normal: 1, warning: 1, critical: 0, unread: 0 })
    expect(model.host.signals.swapUsedPct.max).toBe(20)
    expect(model.host.byCause.find((c) => c.class === 'lead')).toMatchObject({ footprintMib: 1000, peakMib: 1000 })
    expect(model.host.timeline.points).toHaveLength(1)
  })

  test('without the epoch the earlier minute counts; an epoch before the window cuts nothing', async () => {
    const all = await read(null)
    expect(all.epoch).toBeNull()
    expect(all.host.minutes).toBe(3)
    expect(all.host.signals.pressureMinutes.critical).toBe(1)
    const early = await read(t('10-01T00:00'))
    expect(early.epoch).toEqual({ at: t('10-01T00:00').toISOString(), cut: false, countingSince: null })
    expect(early.window.from).toBe(new Date(NOW.getTime() - 120 * 3_600_000).toISOString())
    expect(early.host.minutes).toBe(3)
  })

  test('the answers: the queue binds on the hours after the epoch (an interval across it is clipped), the cost on the tenant class', async () => {
    const { answers } = await read(EPOCH, { tenantBudget: { project: 'dotfiles', budgetMib: 9000 } })
    expect(answers.host.level).toBe('normal')
    expect(answers.host.limit).toBe(false)
    expect(answers.host.sentence).toStartWith('No: memory pressure is normal now')
    // memory 6 h + 3 h of the crossing interval (memory_fit counts as memory), claim 2 h
    expect(answers.queue.binding).toEqual({ kind: 'memory', hours: 9, issues: 2 })
    expect(answers.queue.byReason.map((r) => [r.kind, r.hours])).toEqual([
      ['memory', 9],
      ['claim', 2],
    ])
    expect(answers.queue.perDay.find((d) => d.day === '2026-11-13')?.hours).toBe(6)
    expect(answers.queue.perDay.some((d) => d.day === '2026-11-11')).toBe(false)
    // the improvement filed before the epoch is unmeasured, so the open one after it is the largest
    expect(answers.cost.kind).toBe('improvement')
    expect(answers.cost.finding?.id).toBe('finding_new')
    expect(answers.cost.perDay).toEqual([])

    const unbounded = (await read(null, { tenantBudget: { project: 'dotfiles', budgetMib: 9000 } })).answers
    expect(unbounded.queue.binding).toEqual({ kind: 'memory', hours: 23, issues: 2 })
    expect(unbounded.cost.finding?.id).toBe('finding_old')
  })

  test('a tenant class over its budget outranks any finding, with its days since the epoch', async () => {
    await db.sql`INSERT INTO factory.host_class_samples (at, class, repo, tenant, footprint_mib, cpu_ms, procs)
      VALUES (${t('11-13T10:00')}, 'tenant', null, 'vm:one', 8000, 1, 1), (${t('11-13T10:01')}, 'tenant', null, 'vm:one', 8000, 1, 1)`
    try {
      const { answers } = await read(EPOCH, { tenantBudget: { project: 'dotfiles', budgetMib: 6144 } })
      expect(answers.cost.kind).toBe('tenant')
      expect(answers.cost.figure).toBe(8000 - 6144)
      expect(answers.cost.perDay).toEqual([{ day: '2026-11-13', mib: 7000 }])
    } finally {
      await db.sql`DELETE FROM factory.host_class_samples WHERE class = 'tenant'`
    }
  })

  test('an open finding filed before the epoch is unmeasured with its reason; one filed after it is not', async () => {
    const { improvements } = await read(EPOCH)
    const byId = new Map(improvements.map((f) => [f.id, f]))
    expect(byId.get('finding_old')).toMatchObject({ status: 'unmeasured', reason: 'filed before the counting epoch' })
    expect(byId.get('finding_new')).toMatchObject({ status: 'open', reason: null })
    expect((await read(null)).improvements.find((f) => f.id === 'finding_old')).toMatchObject({
      status: 'open',
      reason: null,
    })
  })
})

describe('the capacity loop and the loop windows', () => {
  test('the capacity loop counts the Issues closed since the epoch and reports its start', async () => {
    const days = (epoch: Date | null) => readCapacityLoop(db.sql, { now: NOW, days: 7, constants, epoch })
    const cut = CapacityLoopModel.parse(await days(EPOCH))
    expect(cut.window.from).toBe(EPOCH.toISOString())
    expect(cut.epoch).toEqual({ at: EPOCH.toISOString(), cut: true, countingSince: EPOCH.toISOString() })
    expect(cut.throughput.total).toBe(3)
    expect(cut.days).toBe(3)
    const all = CapacityLoopModel.parse(await days(null))
    expect(all.epoch).toBeNull()
    expect(all.days).toBe(7)
    expect(all.throughput.total).toBe(7)
    // 11-07T12:00 is the start of seven days: 11-08 to 11-14 close one Issue a day, 11-07 closed at 09:00 before it
    expect(all.window.from).toBe(t('11-07T12:00').toISOString())
  })

  const median = async (epoch: Date | null) =>
    (
      await readWindowFacts(db.sql, {
        from: new Date(NOW.getTime() - 24 * 3_600_000),
        to: NOW,
        baseline: true,
        peakBudgetMib: new Map(),
        epoch,
      })
    ).perIssue.find((p) => p.project === 'app')

  test('a median over earlier days ignores the days before the epoch, and is absent until 3 days remain', async () => {
    // the five 100-minute days before the epoch would make the median 100; the four after it make it 10
    expect((await median(t('11-10T00:00')))?.baselineMedian).toBe(10)
    expect((await median(null))?.baselineMedian).toBe(100)
    // a baseline the epoch cuts to 2 days (11-12, 11-13) has no median yet
    expect((await median(EPOCH))?.baselineMedian).toBeNull()
  })

  test('the window facts start at the epoch: days count only what is counted', async () => {
    const facts = await readWindowFacts(db.sql, {
      from: new Date(NOW.getTime() - 7 * 24 * 3_600_000),
      to: NOW,
      baseline: false,
      peakBudgetMib: new Map(),
      epoch: t('11-14T00:00'),
    })
    expect(facts.days).toBe(0.5)
    expect(facts.runs.map((r) => [r.project, r.runs])).toEqual([['app', 1]])
  })

  test('the ranking files nothing from a window the epoch cut under a day, and says why', async () => {
    const pass = await throughputPass({
      uow,
      clock: { now: () => NOW },
      tenants: { project: 'dotfiles', budgetMib: 6144 },
      epoch: t('11-14T00:00'),
      projects: async () => [{ project: 'app', repo: 'app', peakMib: null }],
      facts: (window, options) => readWindowFacts(db.sql, { ...window, ...options, epoch: t('11-14T00:00') }),
      fates: async () => new Map(),
      file: () => Promise.reject(new Error('nothing may be filed')),
    })
    expect(pass.ok && pass.value.filed).toEqual([])
    expect(pass.ok && pass.value.notes.join(' ')).toContain('ranking waits')
  })
})

describe('the epoch itself', () => {
  test('a window is cut only when the epoch is later than its start', () => {
    const from = t('11-10T00:00')
    expect(countedFrom(from, t('11-11T00:00'))).toEqual(t('11-11T00:00'))
    expect(countedFrom(from, t('11-09T00:00'))).toEqual(from)
    expect(countedFrom(from, null)).toEqual(from)
    expect(epochNote(from, null)).toBeNull()
  })

  test('the tracked file is one ISO time; a bad file is an error, never a fallback', async () => {
    expect(loadEpoch().getTime()).toBeGreaterThan(0)
    const dir = await Bun.$`mktemp -d`.text()
    const bad = `${dir.trim()}/throughput.json`
    await Bun.write(bad, '{"epoch":"yesterday"}')
    expect(() => loadEpoch(bad)).toThrow()
    expect(() => loadEpoch(`${dir.trim()}/missing.json`)).toThrow()
  })
})

describe('what the epoch leaves to the ledger and to a lead', () => {
  const row = (filedAt: Date): FindingRow => ({
    id: 'f',
    project: 'chat',
    kpi: 'failed_run_minutes',
    subject: '*',
    before: 60,
    target: 30,
    direction: 'down',
    unit: 'minutes',
    costMinutes: 90,
    signalId: null,
    issueId: 'issue_1',
    filedAt,
    shippedAt: t('11-11T00:00'),
    after: null,
    afterAt: null,
    status: 'shipped',
    reopens: null,
  })

  test('a shipped finding filed before the epoch is written unmeasured, never measured against a before from the other side', async () => {
    let measured = 0
    const measure = async () => {
      measured++
      return 10
    }
    const before = await readLedger([row(t('11-10T00:00'))], new Map(), NOW, measure, EPOCH)
    expect(before).toEqual([{ id: 'f', patch: { status: 'unmeasured', afterAt: NOW } }])
    expect(measured).toBe(0)
    const after = await readLedger([row(t('11-13T00:00'))], new Map(), NOW, measure, EPOCH)
    expect(after[0]?.patch.status).toBe('moved')
    expect(measured).toBe(1)
  })

  test('a lead is not told a work repo by the answers: the finding, its sentence and the queue wait text are rewritten', () => {
    const answers = answersOf({
      window: { from: EPOCH, to: NOW },
      pressure: { normal: 1, warning: 0, critical: 0, unread: 0 },
      newest: { level: 1, swapUsedPct: 5, memoryUsedPct: 40 },
      tenant: { budgetMib: 6144, footprintMib: 100, over: false },
      tenantDays: [],
      intervals: [],
      findings: [
        {
          id: 'f',
          project: 'chat',
          kpi: 'failed_run_minutes',
          subject: '*',
          before: 60,
          target: 30,
          after: null,
          direction: 'down',
          unit: 'minutes',
          costMinutes: 90,
          status: 'open',
          reason: null,
          issue: null,
          filedAt: EPOCH.toISOString(),
          shippedAt: null,
          afterAt: null,
        },
      ],
      queue: new Map([['issue_1', { kind: 'memory', message: 'memory: a lead of chat takes ~5 GiB', opensAt: null }]]),
    })
    expect(answers.cost.sentence).toContain('chat')
    expect(answers.host.sentence).toContain('a lead of chat')
    const seen = redactAnswers(answers, [{ name: 'argo', repo: 'argo' }])
    expect(JSON.stringify(seen)).not.toContain('chat')
    expect(seen.cost.finding).toMatchObject({ project: 'private', subject: '*' })
    expect(seen.host.waitingFor).toBeNull()
    expect(seen.host.sentence).toContain('an Issue waits for memory')
    // an open project's name stays
    expect(redactAnswers(answers, [{ name: 'chat', repo: 'chat' }]).cost.finding?.project).toBe('chat')
  })
})
