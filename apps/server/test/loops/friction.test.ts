import { expect, test } from 'bun:test'
import { MAX_SIGNALS_PER_PASS } from '../../src/kernel/signal-budget.ts'
import { type FrictionCount, type SignalRequest, THRESHOLDS } from '@software-factory/contract'
import {
  isRetired,
  type KpiReading,
  kpisOffTarget,
  MIN_CLOSED,
  named,
  patternsOver,
  signalText,
  signalTitle,
  withinBudget,
} from '../../src/domains/improve/friction.ts'
import type { LoopFinding } from '../../src/domains/intake/model.ts'
import type { FinderIssue } from '../../src/domains/improve/finders.ts'
import type { ClosedFinding, Judged } from '../../src/domains/improve/ledger.ts'
import type { FrictionPassRecord } from '../../src/domains/improve/ports.ts'
import type { LoopReads, LoopStore } from '../../src/app/loops/stores.ts'
import { frictionPass, frictionSummary, type FrictionDeps } from '../../src/app/loops/friction.ts'
import { RETRO_TITLE, type RetroOutcomes } from '../../src/domains/improve/retro.ts'
import { sequentialIds } from '../../src/kernel/ids.ts'
import { err, ok } from '../../src/kernel/result.ts'

/** 40 Issues closed: well past the minimum sample, and `n / 40` is each count's rate. */
const CLOSED = 40

const count = (key: string, group: FrictionCount['group'], n: number, label = key, closed = CLOSED): FrictionCount => ({
  key,
  group,
  label,
  count: n,
  perIssue: closed === 0 ? null : n / closed,
  previous: null,
})

const over = (counts: FrictionCount[], closed = CLOSED) => patternsOver(counts, closed)

test('aggregate keys and the decision_answered group are never findings', () => {
  expect(
    over([
      count('refusal:total', 'refusal', 50),
      count('ship_refused:total', 'refusal', 50),
      count('signal_held:total', 'signal', 50),
      count('decision_answered:owner', 'decision_answered', 50),
      count('decision_answered:judge', 'decision_answered', 50),
    ]),
  ).toEqual([])
})

test('a serious pattern is a finding by its count alone, at any sample', () => {
  const cases: [string, FrictionCount['group']][] = [
    ['stall:unreported', 'stall'],
    ['lead_gone', 'lead_gone'],
    ['undelivered_note', 'undelivered_note'],
  ]
  for (const [key, group] of cases) {
    const rule = THRESHOLDS.friction.groups[group as keyof typeof THRESHOLDS.friction.groups]
    expect(rule.rate).toBeNull()
    for (const closed of [0, 1, CLOSED]) {
      expect(over([count(key, group, rule.min, key, closed)], closed).map((p) => p.key)).toEqual([key])
      expect(over([count(key, group, rule.min - 1, key, closed)], closed)).toEqual([])
    }
  }
})

test('a rate-judged pattern needs its count, its rate and the minimum sample', () => {
  const cases: [string, FrictionCount['group']][] = [
    ['refusal:closed', 'refusal'],
    ['ship_refused:commit_not_on_base', 'refusal'],
    ['unreviewed_ship', 'unreviewed_ship'],
    ['unstated_acceptance', 'unstated_acceptance'],
    ['unproven_ci', 'unproven_ci'],
    ['regression', 'regression'],
    ['touch:woken', 'avoidable_touch'],
    ['signal_held:feedback', 'signal'],
  ]
  for (const [key, group] of cases) {
    const rule = THRESHOLDS.friction.groups[group as keyof typeof THRESHOLDS.friction.groups]
    if (rule.rate === null) throw new Error(`${group} has no rate`)
    const atRate = Math.ceil(rule.rate * CLOSED)
    const n = Math.max(rule.min, atRate)
    expect(
      over([count(key, group, n)]).map((p) => p.key),
      key,
    ).toEqual([key])
    // under the count, whatever the rate
    expect(over([count(key, group, rule.min - 1)]), key).toEqual([])
    // under the rate, whatever the count
    expect(over([count(key, group, rule.min + 1, key, 1000)], 1000), key).toEqual([])
    // under the minimum sample, a rate means nothing
    expect(over([count(key, group, 9, key, MIN_CLOSED - 1)], MIN_CLOSED - 1), key).toEqual([])
    expect(
      over([count(key, group, 9, key, MIN_CLOSED)], MIN_CLOSED).map((p) => p.key),
      key,
    ).toEqual([key])
  }
})

test('a regressed stall is judged by the regression rule: one Issue in twenty, from 3', () => {
  const key = 'stall:regressed'
  // 3 of 1310 closed: the week of 2026-11-20, weather
  expect(over([count(key, 'stall', 3, key, 1310)], 1310)).toEqual([])
  // 2 of 40 is under the count, 3 of 40 is over the rate
  expect(over([count(key, 'stall', 2, key, 40)], 40)).toEqual([])
  expect(over([count(key, 'stall', 3, key, 40)], 40).map((p) => p.key)).toEqual([key])
  // the same rule as the regression it is the stall of
  expect(THRESHOLDS.friction.keys[key]).toBe(THRESHOLDS.friction.groups.regression)
})

test('a block or a full window the steward ends itself is a finding by rate, not by count', () => {
  for (const key of ['stall:blocked', 'stall:wall']) {
    // 48 and 21 in a week of 1443 closed Issues: weather
    expect(over([count(key, 'stall', 48, key, 1443)], 1443), key).toEqual([])
    // one Issue's block loop, 77 of 1183 closed
    expect(
      over([count(key, 'stall', 77, key, 1183)], 1183).map((p) => p.key),
      key,
    ).toEqual([key])
    // 2 of 40 is under the count, 3 of 40 is over the rate
    expect(over([count(key, 'stall', 2)]), key).toEqual([])
    expect(
      over([count(key, 'stall', 3)]).map((p) => p.key),
      key,
    ).toEqual([key])
    // under the minimum sample a rate means nothing
    expect(over([count(key, 'stall', 9, key, MIN_CLOSED - 1)], MIN_CLOSED - 1), key).toEqual([])
  }
})

test('owner notes and cancels, the owner steering, need a far higher rate than another touch', () => {
  expect(over([count('touch:noted', 'avoidable_touch', 12)])).toEqual([]) // 0.30 per Issue closed
  expect(over([count('touch:cancelled', 'avoidable_touch', 12)])).toEqual([])
  expect(over([count('touch:woken', 'avoidable_touch', 12)]).map((p) => p.key)).toEqual(['touch:woken'])
  expect(over([count('touch:noted', 'avoidable_touch', 20)]).map((p) => p.key)).toEqual(['touch:noted'])
  expect(over([count('touch:cancelled', 'avoidable_touch', 16)]).map((p) => p.key)).toEqual(['touch:cancelled'])
})

test('a retired pattern, the review gate that is gone, is never a finding', () => {
  const key = 'ship_refused:review_gate_retired'
  expect(isRetired(key)).toBe(true)
  expect(isRetired('ship_refused:no_commit_named')).toBe(false)
  expect(over([count(key, 'refusal', 50)])).toEqual([])
  expect(over([count('ship_refused:no_commit_named', 'refusal', 50)])).toHaveLength(1)
})

test('patterns come most frequent first, ties by key', () => {
  const found = over([
    count('stall:unreported', 'stall', 2),
    count('regression', 'regression', 4),
    count('lead_gone', 'lead_gone', 2),
    count('undelivered_note', 'undelivered_note', 9),
  ])
  expect(found.map((p) => p.key)).toEqual(['undelivered_note', 'regression', 'lead_gone', 'stall:unreported'])
})

test('the budget files the first five and names the rest with their counts', () => {
  const many = Array.from({ length: 8 }, (_, i) => count(`stall:r${i}`, 'stall', 10 - i))
  const { file, overBudget } = withinBudget(over(many))
  expect(file).toHaveLength(MAX_SIGNALS_PER_PASS)
  expect(overBudget.map((p) => p.key)).toEqual(['stall:r5', 'stall:r6', 'stall:r7'])
  expect(named(overBudget)).toBe('stall:r5 (5), stall:r6 (4), stall:r7 (3)')
})

test('the title carries no count, so a repeat has the same fingerprint input', () => {
  const titles = [2, 7].flatMap((n) =>
    over([count('lead_gone', 'lead_gone', n, 'Leads that were lost')]).map(signalTitle),
  )
  expect(titles).toEqual(['Friction: Leads that were lost', 'Friction: Leads that were lost'])
})

const facts = {
  from: '2026-11-07T16:35:26.398Z',
  to: '2026-11-08T00:00:00.000Z',
  days: 7,
  since: '2026-11-07T16:35:26.398Z',
  issues: 10,
  closed: 8,
}

test('the text names window, import cut, count, rate, threshold, refs and the command', () => {
  const text = over([count('lead_gone', 'lead_gone', 3, 'Leads that were lost')])
    .map((p) => signalText(p, facts, ['issue_4', 'issue_2']))
    .join('')
  for (const part of [
    '2026-11-07T16:35',
    '2026-11-08',
    'cut at the counting epoch',
    'Count: 3',
    'per Issue closed',
    'closed: 8',
    'Threshold: 2 in the window',
    'issue_4, issue_2',
    'factory read friction --days 7',
  ]) {
    expect(text).toContain(part)
  }
  const rated = over([count('unreviewed_ship', 'unreviewed_ship', 12, 'Ships with no review of the change')])
    .map((p) => signalText(p, facts, []))
    .join('')
  expect(rated).toContain('Threshold: 3 in the window and 0.25 per Issue closed (judged from 10 closed)')
})

test('a pattern without Issues says so', () => {
  const note = over([count('undelivered_note', 'undelivered_note', 1, 'Notes that never reached the lead')])
    .map((p) => signalText(p, { ...facts, since: null }, []))
    .join('')
  expect(note).toContain('no Issue behind it')
  expect(note).not.toContain('cut at the counting epoch')
})

// ---- finders ------------------------------------------------------------------------------------------------------

const DAY = 86_400_000
const passNow = new Date('2026-11-20T12:00:00Z')

function frictionWorld(
  classes: Record<string, FinderIssue[]>,
  failRetro = false,
  extra: {
    last?: Date | null
    closed?: number
    outcomes?: RetroOutcomes
    retroFiled?: Date | null
    closedFindings?: ClosedFinding[]
    counts?: FrictionCount[]
    kpis?: () => Promise<KpiReading[]>
    since?: string | null
  } = {},
) {
  const recorded: { issue: string; class: string; key: string; figure: number | null }[] = []
  const verdicts: Judged[] = []
  const records: FrictionPassRecord[] = []
  const loops = {
    lastFrictionPassAt: async () => extra.last ?? null,
    recordFrictionPass: async (r: FrictionPassRecord) => void records.push(r),
    recordFinding: async (f: { issue: string; class: string; key: string; figure: number | null }) => {
      if (!recorded.some((r) => r.issue === f.issue)) recorded.push(f)
    },
    recordVerdicts: async (rows: readonly Judged[]) => void verdicts.push(...rows),
  } as unknown as LoopStore
  const loopReads = {
    classIssues: async () => classes,
    closedFindings: async () => extra.closedFindings ?? [],
  } as unknown as LoopReads
  let filed = 0
  const bodies: SignalRequest[] = []
  const finds: LoopFinding[] = []
  const deps: FrictionDeps = {
    uow: { run: async (work) => work({ loops, loopReads }), inTransaction: () => false },
    clock: { now: () => passNow },
    ids: sequentialIds(),
    friction: async () => ({
      at: passNow.toISOString(),
      days: 7,
      window: { from: new Date(passNow.getTime() - 7 * DAY).toISOString(), to: passNow.toISOString() },
      since: extra.since ?? null,
      issues: 40,
      closed: 40,
      counts: extra.counts ?? [count('lead_gone', 'lead_gone', 9), count('regression', 'regression', 9)],
    }),
    kpis: extra.kpis ?? (async () => []),
    evidence: async () => ({}),
    closedSince: async () => extra.closed ?? 0,
    retroFiledAt: async () => extra.retroFiled ?? null,
    retroOutcomes: async () => extra.outcomes ?? { days: 7, signals: 0, shipped: 0, done: 0, dropped: 0, open: 0 },
    file: async (body, finding) => {
      bodies.push(body)
      finds.push(finding)
      if (failRetro && body.title === RETRO_TITLE) return err({ kind: 'unreadable', detail: 'intake is down' }) as never
      return ok({ outcome: 'filed', detail: 'new', issue: `issue_${++filed}`, signal: null, reason: null }) as never
    },
  }
  return { deps, recorded, records, bodies, finds, verdicts }
}

const noisyFriction = (): FinderIssue[] =>
  Array.from({ length: 5 }, (_, i) => ({
    issue: `issue_${i + 100}`,
    filedAt: new Date(passNow.getTime() - (40 - i) * DAY),
    closedAt: new Date(passNow.getTime() - (2 + i) * DAY),
    outcome: 'dropped' as const,
  }))

test('a held friction class is named in overBudget and not filed; the others are filed and recorded', async () => {
  const w = frictionWorld({ lead_gone: noisyFriction() })
  expect((await frictionPass(w.deps)).ok).toBe(true)
  expect(w.records[0]?.filed.map((f) => f.key)).toEqual(['regression'])
  expect(w.records[0]?.overBudget.map((f) => f.key)).toEqual(['lead_gone'])
  expect(w.recorded.map((r) => [r.class, r.key])).toEqual([['regression', 'regression']])
})

test('with no history every class files', async () => {
  const w = frictionWorld({})
  await frictionPass(w.deps)
  expect(w.records[0]?.filed).toHaveLength(2)
  expect(w.records[0]?.overBudget).toEqual([])
  expect(w.recorded).toHaveLength(2)
})

test('every pass files the weekly retro signal once, and a failure to file it never stops the pass', async () => {
  const w = frictionWorld({})
  const pass = await frictionPass(w.deps)
  const retro = w.bodies.filter((b) => b.title === RETRO_TITLE)
  expect(retro).toHaveLength(1)
  expect(retro[0]).toMatchObject({ from: 'agent:software-factory', repo: 'software-factory', kind: 'request' })
  expect(retro[0]?.text).toContain('factory retro --days 7')
  expect(retro[0]?.text).toContain('Retro: 2026-11-20 kpi=<KPI, part or beside-figure, or capacity figure key>')
  // part 2c, after 2b and before the ledger: the build speed, its two figures and the guard that keeps the coverage
  const text = retro[0]?.text ?? ''
  expect(text.indexOf('2b. Capacity')).toBeLessThan(text.indexOf('2c. Build speed'))
  expect(text.indexOf('2c. Build speed')).toBeLessThan(text.indexOf('3. The ledger'))
  expect(text).toContain('kpi=check_minutes_per_issue')
  expect(text).toContain('kpi=ci_p50_minutes')
  expect(text).toContain('`build.repos`')
  expect(text).toContain('same coverage of what ships')
  expect(pass.ok && pass.value.due && frictionSummary(pass.value)).toContain('retro filed (new)')

  const down = frictionWorld({}, true)
  const failed = await frictionPass(down.deps)
  expect(failed.ok).toBe(true)
  expect(down.records).toHaveLength(1)
  expect(down.records[0]?.filed).toHaveLength(2)
  expect(failed.ok && failed.value.due && frictionSummary(failed.value)).toContain(
    'retro not filed: unreadable: intake is down',
  )
})

// ---- the pace: a day, or 200 closed Issues ---------------------------------------------------------------------------------

const HOUR = 3_600_000

test('a pass is not due within a day while fewer than 200 Issues closed, and then not read as a pass', async () => {
  const w = frictionWorld({}, false, { last: new Date(passNow.getTime() - 3 * HOUR), closed: 199 })
  const pass = await frictionPass(w.deps)
  expect(pass).toMatchObject({ ok: true, value: { due: false } })
  expect(w.records).toHaveLength(0)
  expect(w.bodies).toHaveLength(0)
})

test('200 Issues closed since the last pass make one due within the day, and the budget still holds', async () => {
  const w = frictionWorld({}, false, { last: new Date(passNow.getTime() - 3 * HOUR), closed: 200 })
  const pass = await frictionPass(w.deps)
  expect(pass).toMatchObject({ ok: true, value: { due: true, trigger: 'volume' } })
  expect(w.records).toHaveLength(1)
  expect(w.records[0]?.filed.length).toBeLessThanOrEqual(MAX_SIGNALS_PER_PASS)
  expect(pass.ok && pass.value.due && frictionSummary(pass.value)).toContain('volume pass: filed 2 signal(s)')
})

test('a day since the last pass makes one due on the clock, however few Issues closed', async () => {
  const w = frictionWorld({}, false, { last: new Date(passNow.getTime() - 25 * HOUR), closed: 3 })
  expect(await frictionPass(w.deps)).toMatchObject({ ok: true, value: { due: true, trigger: 'day' } })
})

test('the retro signal says what the earlier retros’ signals led to', async () => {
  const w = frictionWorld({}, false, {
    outcomes: { days: 7, signals: 6, shipped: 3, done: 1, dropped: 1, open: 0 },
  })
  await frictionPass(w.deps)
  const text = w.bodies.find((b) => b.title === RETRO_TITLE)?.text ?? ''
  expect(text).toContain(
    'Verified: the retros of the last 7 days filed 6 signal(s): 3 shipped, 1 closed done without a ship, 1 dropped or cancelled, 0 still open, 1 reached no Issue.',
  )
  const quiet = frictionWorld({})
  await frictionPass(quiet.deps)
  expect(quiet.bodies.find((b) => b.title === RETRO_TITLE)?.text).not.toContain('Verified:')
})

test('the retro asks the Report to open with the three largest sources of waste, by hours', async () => {
  const w = frictionWorld({})
  await frictionPass(w.deps)
  const text = w.bodies.find((b) => b.title === RETRO_TITLE)?.text ?? ''
  expect(text).toContain('0. The three largest sources of waste')
  expect(text.indexOf('0. The three')).toBeLessThan(text.indexOf('1. The numbers'))
})

// ---- the week: a pattern and the retro are filed once per window ------------------------------------------------------------

test('every pattern asks intake for a week counted from its Issue closing; the retro asks for none', async () => {
  const w = frictionWorld({})
  await frictionPass(w.deps)
  expect(w.finds).toHaveLength(3)
  expect(w.finds.filter((f) => f.class !== 'retro').map((f) => f.repeatWindowMs)).toEqual([7 * DAY, 7 * DAY])
  expect(w.finds.find((f) => f.class === 'retro')?.repeatWindowMs).toBeUndefined()
})

test('the retro is filed when none was filed in the last 7 days, and not before', async () => {
  const recent = frictionWorld({}, false, { retroFiled: new Date(passNow.getTime() - 6 * DAY) })
  const pass = await frictionPass(recent.deps)
  expect(recent.bodies.filter((b) => b.title === RETRO_TITLE)).toHaveLength(0)
  expect(recent.records[0]?.filed).toHaveLength(2)
  expect(pass.ok && pass.value.due && frictionSummary(pass.value)).toContain('retro not due (filed 2026-11-14')

  const old = frictionWorld({}, false, { retroFiled: new Date(passNow.getTime() - 7 * DAY) })
  await frictionPass(old.deps)
  expect(old.bodies.filter((b) => b.title === RETRO_TITLE)).toHaveLength(1)
})

test('a retro whose last filing cannot be read is named and not filed, and the pass goes on', async () => {
  const w = frictionWorld({})
  w.deps.retroFiledAt = async () => {
    throw new Error('no table')
  }
  const pass = await frictionPass(w.deps)
  expect(w.bodies.filter((b) => b.title === RETRO_TITLE)).toHaveLength(0)
  expect(w.records).toHaveLength(1)
  expect(pass.ok && pass.value.due && frictionSummary(pass.value)).toContain(
    'retro not filed: the last retro could not be read',
  )
})

// ---- the ledger -------------------------------------------------------------------------------------------------------------

const closedFinding = (over: Partial<ClosedFinding> = {}): ClosedFinding => ({
  issue: 'issue_7',
  loop: 'friction',
  repo: 'software-factory',
  key: 'regression',
  figure: 12,
  verdict: null,
  outcome: 'done',
  filedAt: new Date(passNow.getTime() - 10 * DAY),
  closedAt: new Date(passNow.getTime() - 3 * DAY),
  ...over,
})

test('a pattern is filed against its count; the next pass at 11 after a count of 12 records moved and says so in its signal', async () => {
  const first = frictionWorld({}, false, { counts: [count('regression', 'regression', 12)] })
  expect((await frictionPass(first.deps)).ok).toBe(true)
  expect(first.recorded.map((r) => [r.key, r.figure])).toEqual([['regression', 12]])
  expect(first.bodies.find((b) => b.text.includes('(regression)'))?.text).not.toContain('Last time')

  const next = frictionWorld({}, false, {
    counts: [count('regression', 'regression', 11)],
    closedFindings: [closedFinding()],
  })
  expect((await frictionPass(next.deps)).ok).toBe(true)
  expect(next.verdicts).toEqual([{ issue: 'issue_7', key: 'regression', verdict: 'moved', measured: 11 }])
  const text = next.bodies.find((b) => b.text.includes('(regression)'))?.text
  expect(text).toContain('Last time: Issue issue_7 at figure 12, now 11 (moved).')
})

test('a pattern no longer counted is at 0, a count that did not fall is flat or worse, noise is unmeasured, and a read verdict is kept', async () => {
  const w = frictionWorld({}, false, {
    counts: [count('regression', 'regression', 9)],
    closedFindings: [
      closedFinding({ issue: 'issue_1', key: 'gone', figure: 5 }),
      closedFinding({ issue: 'issue_2', key: 'regression', figure: 9 }),
      closedFinding({ issue: 'issue_3', key: 'worse', figure: 4 }),
      closedFinding({ issue: 'issue_4', key: 'noise', outcome: 'dropped' }),
      closedFinding({ issue: 'issue_5', key: 'kept', verdict: 'moved' }),
    ],
  })
  expect((await frictionPass(w.deps)).ok).toBe(true)
  expect(w.verdicts).toEqual([
    { issue: 'issue_1', key: 'gone', verdict: 'moved', measured: 0 },
    { issue: 'issue_2', key: 'regression', verdict: 'flat', measured: 9 },
    { issue: 'issue_3', key: 'worse', verdict: 'moved', measured: 0 },
    { issue: 'issue_4', key: 'noise', verdict: 'unmeasured', measured: null },
  ])
  expect(w.bodies.find((b) => b.text.includes('(regression)'))?.text).toContain(
    'Last time: Issue issue_2 at figure 9, now 9 (flat).',
  )
})

/** Avoidable touches above the target: notes are the largest kind, then cancels. */
const touchesOver = (value = 0.12): KpiReading => ({
  key: 'avoidable_touches',
  label: 'Avoidable touches per Issue',
  value,
  unit: 'per_issue',
  n: 200,
  count: Math.round(value * 200),
  measured: true,
  target: THRESHOLDS.kpis.avoidable_touches,
  parts: [
    { key: 'touch:cancelled', label: 'Issues the owner cancelled', value: 0.03, unit: 'per_issue' },
    { key: 'touch:noted', label: 'Notes the owner sent to a lead', value: 0.08, unit: 'per_issue' },
    {
      key: 'touch:decision_answered',
      label: 'Decisions the owner answered that were not worth asking',
      value: 0.01,
      unit: 'per_issue',
    },
  ],
})

test('a KPI off its target over a whole window is a finding that names its largest part', () => {
  const [pattern, ...rest] = kpisOffTarget([touchesOver()], { whole: true })
  expect(rest).toEqual([])
  expect(pattern?.key).toBe('kpi:avoidable_touches')
  expect(pattern?.group).toBe('kpi')
  expect(pattern?.label).toContain('Notes the owner sent to a lead')
  expect(pattern?.kpi?.largest?.key).toBe('touch:noted')
  // the figure is read so that lower is better: an at_most KPI's own value
  expect(pattern?.count).toBeCloseTo(0.12)
})

test('a KPI on its target, unmeasured, with no number yet, or over a window the epoch cut is no finding', () => {
  const target = THRESHOLDS.kpis.avoidable_touches.max ?? 0
  expect(kpisOffTarget([touchesOver(target)], { whole: true })).toEqual([])
  expect(kpisOffTarget([{ ...touchesOver(), measured: false, value: null }], { whole: true })).toEqual([])
  expect(kpisOffTarget([touchesOver()], { whole: false })).toEqual([])
  // three Issues are no sample for a rate: no friction rate is judged under ten either
  expect(kpisOffTarget([{ ...touchesOver(), n: 3 }], { whole: true })).toEqual([])
  const errands: KpiReading = {
    key: 'errands_reached_per_100',
    label: 'Errands that reached the owner per 100 Issues',
    value: 40,
    unit: 'per_100_issues',
    n: 100,
    count: 40,
    measured: true,
    target: THRESHOLDS.kpis.errands_reached_per_100,
    parts: [],
  }
  expect(kpisOffTarget([errands], { whole: true })).toEqual([])
})

test('a higher-is-better KPI under its target is a finding judged by its shortfall', () => {
  const passes: KpiReading = {
    key: 'first_verification_passes',
    label: 'First verification passes',
    value: 0.8,
    unit: 'share',
    n: 50,
    count: 40,
    measured: true,
    target: THRESHOLDS.kpis.first_verification_passes,
    parts: [{ key: 'ci', label: 'Regressed: CI', value: 0.15, unit: 'share' }],
  }
  const [pattern] = kpisOffTarget([passes], { whole: true })
  expect(pattern?.key).toBe('kpi:first_verification_passes')
  expect(pattern?.count).toBeCloseTo(0.2)
})

test('with avoidable touches above their target for a whole window the pass files a finding naming the largest touch kind', async () => {
  const w = frictionWorld({}, false, { counts: [], kpis: async () => [touchesOver()] })
  expect((await frictionPass(w.deps)).ok).toBe(true)
  expect(w.records[0]?.filed.map((f) => f.key)).toEqual(['kpi:avoidable_touches'])
  const body = w.bodies.find((b) => b.title !== RETRO_TITLE)
  expect(body?.title).toContain('Notes the owner sent to a lead')
  expect(body?.text).toContain('Largest part: Notes the owner sent to a lead (touch:noted, 0.08)')
  expect(body?.text).toContain('target at most 0.07')
  expect(w.finds.find((f) => f.subject === 'kpi:avoidable_touches')?.class).toBe('kpi')
})

test('a window the epoch cut judges no KPI, and a failed KPI read is named while the counts still file', async () => {
  const cut = frictionWorld({}, false, {
    counts: [],
    kpis: async () => [touchesOver()],
    since: '2026-11-15T00:00:00.000Z',
  })
  await frictionPass(cut.deps)
  expect(cut.records[0]?.filed).toEqual([])

  const failing = frictionWorld({}, false, {
    kpis: async () => {
      throw new Error('statement timeout')
    },
  })
  expect((await frictionPass(failing.deps)).ok).toBe(true)
  expect(failing.records[0]?.filed.map((f) => f.key)).toEqual(['lead_gone', 'regression'])
  expect(failing.records[0]?.failed).toEqual([
    { key: 'kpi', reason: 'the KPIs could not be read: Error: statement timeout' },
  ])
})

test('a closed KPI finding waits for the next pass when the KPIs could not be read', async () => {
  const w = frictionWorld({}, false, {
    counts: [],
    kpis: async () => {
      throw new Error('statement timeout')
    },
    closedFindings: [
      {
        issue: 'issue_7',
        loop: 'friction',
        repo: 'software-factory',
        key: 'kpi:avoidable_touches',
        figure: 0.12,
        verdict: null,
        outcome: 'done',
        filedAt: new Date(passNow.getTime() - 9 * DAY),
        closedAt: new Date(passNow.getTime() - 2 * DAY),
      },
    ],
  })
  await frictionPass(w.deps)
  expect(w.verdicts).toEqual([])
})

test('a closed KPI finding is judged against the KPI now, and one with no figure now is unmeasured', async () => {
  const closed = (issue: string, key: string): ClosedFinding => ({
    issue,
    loop: 'friction',
    repo: 'software-factory',
    key,
    figure: 0.12,
    verdict: null,
    outcome: 'done',
    filedAt: new Date(passNow.getTime() - 9 * DAY),
    closedAt: new Date(passNow.getTime() - 2 * DAY),
  })
  const w = frictionWorld({}, false, {
    counts: [],
    kpis: async () => [touchesOver(0.05)],
    closedFindings: [closed('issue_7', 'kpi:avoidable_touches'), closed('issue_8', 'kpi:cycle_p50')],
  })
  await frictionPass(w.deps)
  expect(w.verdicts).toEqual([
    { issue: 'issue_7', key: 'kpi:avoidable_touches', verdict: 'moved', measured: 0.05 },
    { issue: 'issue_8', key: 'kpi:cycle_p50', verdict: 'unmeasured', measured: null },
  ])
})
