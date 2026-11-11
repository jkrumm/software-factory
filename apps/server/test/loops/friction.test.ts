import { expect, test } from 'bun:test'
import type { FrictionCount, SignalRequest } from '@software-factory/contract'
import {
  isRetired,
  MAX_SIGNALS_PER_PASS,
  MIN_CLOSED,
  named,
  patternsOver,
  signalText,
  signalTitle,
  THRESHOLDS,
  withinBudget,
} from '../../src/domains/loops/friction.ts'
import type { ClassIssue } from '../../src/domains/loops/classes.ts'
import type { FrictionPassRecord, LoopReads, LoopStore } from '../../src/domains/loops/ports.ts'
import { frictionPass, frictionSummary, type FrictionDeps } from '../../src/app/loops/friction.ts'
import { RETRO_TITLE } from '../../src/domains/loops/retro.ts'
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
})

const over = (counts: FrictionCount[], closed = CLOSED) => patternsOver(counts, closed)

test('aggregate keys and the decision_settled group are never findings', () => {
  expect(
    over([
      count('refusal:total', 'refusal', 50),
      count('ship_refused:total', 'refusal', 50),
      count('signal_held:total', 'signal', 50),
      count('decision_settled:owner', 'decision_settled', 50),
      count('decision_settled:judge', 'decision_settled', 50),
    ]),
  ).toEqual([])
})

test('a serious pattern is a finding by its count alone, at any sample', () => {
  const cases: [string, FrictionCount['group']][] = [
    ['stall:wall', 'stall'],
    ['lead_gone', 'lead_gone'],
    ['undelivered_note', 'undelivered_note'],
    ['regression', 'regression'],
  ]
  for (const [key, group] of cases) {
    const rule = THRESHOLDS[group as keyof typeof THRESHOLDS]
    expect(rule.rate).toBeNull()
    for (const closed of [0, 1, CLOSED]) {
      expect(over([count(key, group, rule.min, key, closed)], closed).map((p) => p.key)).toEqual([key])
      expect(over([count(key, group, rule.min - 1, key, closed)], closed)).toEqual([])
    }
  }
})

test('a rate-judged pattern needs its count, its rate and the minimum sample', () => {
  const cases: [string, FrictionCount['group']][] = [
    ['refusal:noted:why', 'refusal'],
    ['ship_refused:why', 'refusal'],
    ['unreviewed_ship', 'unreviewed_ship'],
    ['unstated_acceptance', 'unstated_acceptance'],
    ['unproven_ci', 'unproven_ci'],
    ['touch:woken', 'avoidable_touch'],
    ['signal_held:feedback', 'signal'],
  ]
  for (const [key, group] of cases) {
    const rule = THRESHOLDS[group as keyof typeof THRESHOLDS]
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

test('owner notes and cancels, the owner steering, need a far higher rate than another touch', () => {
  expect(over([count('touch:noted', 'avoidable_touch', 12)])).toEqual([]) // 0.30 per Issue closed
  expect(over([count('touch:cancelled', 'avoidable_touch', 12)])).toEqual([])
  expect(over([count('touch:woken', 'avoidable_touch', 12)]).map((p) => p.key)).toEqual(['touch:woken'])
  expect(over([count('touch:noted', 'avoidable_touch', 20)]).map((p) => p.key)).toEqual(['touch:noted'])
  expect(over([count('touch:cancelled', 'avoidable_touch', 16)]).map((p) => p.key)).toEqual(['touch:cancelled'])
})

test('a retired pattern, the review gate that is gone, is never a finding', () => {
  const key = 'ship_refused:ship refused, review missing: review v4 at the tier `agw review route`…'
  expect(isRetired(key)).toBe(true)
  expect(isRetired('ship_refused:ship names no merged commit')).toBe(false)
  expect(over([count(key, 'refusal', 50)])).toEqual([])
  expect(over([count('ship_refused:ship names no merged commit', 'refusal', 50)])).toHaveLength(1)
})

test('patterns come most frequent first, ties by key', () => {
  const found = over([
    count('stall:wall', 'stall', 2),
    count('regression', 'regression', 4),
    count('lead_gone', 'lead_gone', 2),
    count('undelivered_note', 'undelivered_note', 9),
  ])
  expect(found.map((p) => p.key)).toEqual(['undelivered_note', 'regression', 'lead_gone', 'stall:wall'])
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
    'cut at the import',
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
  expect(note).not.toContain('cut at the import')
})

// ---- finding classes ------------------------------------------------------------------------------------------------------

const DAY = 86_400_000
const passNow = new Date('2026-11-20T12:00:00Z')

function frictionWorld(classes: Record<string, ClassIssue[]>, failRetro = false) {
  const recorded: { issue: string; class: string; key: string }[] = []
  const records: FrictionPassRecord[] = []
  const loops = {
    lastFrictionPassAt: async () => null,
    recordFrictionPass: async (r: FrictionPassRecord) => void records.push(r),
    recordFinding: async (f: { issue: string; class: string; key: string }) => {
      if (!recorded.some((r) => r.issue === f.issue)) recorded.push(f)
    },
  } as unknown as LoopStore
  const loopReads = { classIssues: async () => classes } as unknown as LoopReads
  let filed = 0
  const bodies: SignalRequest[] = []
  const deps: FrictionDeps = {
    uow: { run: async (work) => work({ loops, loopReads }), inTransaction: () => false },
    clock: { now: () => passNow },
    ids: sequentialIds(),
    friction: async () => ({
      at: passNow.toISOString(),
      days: 7,
      window: { from: new Date(passNow.getTime() - 7 * DAY).toISOString(), to: passNow.toISOString() },
      since: null,
      issues: 40,
      closed: 40,
      counts: [count('lead_gone', 'lead_gone', 9), count('regression', 'regression', 9)],
    }),
    evidence: async () => ({}),
    file: async (body) => {
      bodies.push(body)
      if (failRetro && body.title === RETRO_TITLE) return err({ kind: 'unreadable', detail: 'intake is down' }) as never
      return ok({ outcome: 'filed', detail: 'new', issue: `issue_${++filed}`, signal: null, reason: null }) as never
    },
  }
  return { deps, recorded, records, bodies }
}

const noisyFriction = (): ClassIssue[] =>
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
  expect(retro[0]?.text).toContain('Retro: 2026-11-20 kpi=<KPI key>')
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
