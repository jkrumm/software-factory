import { expect, test } from 'bun:test'
import type { FrictionCount } from '@software-factory/contract'
import {
  MAX_SIGNALS_PER_PASS,
  named,
  patternsOver,
  signalText,
  signalTitle,
  THRESHOLDS,
  withinBudget,
} from '../../src/domains/loops/friction.ts'

const count = (key: string, group: FrictionCount['group'], n: number, label = key): FrictionCount => ({
  key,
  group,
  label,
  count: n,
  perIssue: n / 10,
})

test('aggregate keys and the decision_settled group are never findings', () => {
  const over = patternsOver([
    count('refusal:total', 'refusal', 50),
    count('ship_refused:total', 'refusal', 50),
    count('signal_held:total', 'signal', 50),
    count('decision_settled:owner', 'decision_settled', 50),
    count('decision_settled:judge', 'decision_settled', 50),
  ])
  expect(over).toEqual([])
})

test('a count at its threshold is a finding, one below is not', () => {
  const cases: [string, FrictionCount['group']][] = [
    ['refusal:noted:why', 'refusal'],
    ['ship_refused:why', 'refusal'],
    ['stall:wall', 'stall'],
    ['lead_gone', 'lead_gone'],
    ['undelivered_note', 'undelivered_note'],
    ['unreviewed_ship', 'unreviewed_ship'],
    ['regression', 'regression'],
    ['touch:noted', 'avoidable_touch'],
    ['signal_held:feedback', 'signal'],
  ]
  for (const [key, group] of cases) {
    const min = THRESHOLDS[group as keyof typeof THRESHOLDS].min
    expect(patternsOver([count(key, group, min)]).map((p) => p.key)).toEqual([key])
    expect(patternsOver([count(key, group, min - 1)])).toEqual([])
  }
})

test('patterns come most frequent first, ties by key', () => {
  const over = patternsOver([
    count('stall:wall', 'stall', 2),
    count('regression', 'regression', 4),
    count('lead_gone', 'lead_gone', 2),
    count('undelivered_note', 'undelivered_note', 9),
  ])
  expect(over.map((p) => p.key)).toEqual(['undelivered_note', 'regression', 'lead_gone', 'stall:wall'])
})

test('the budget files the first five and names the rest with their counts', () => {
  const many = Array.from({ length: 8 }, (_, i) => count(`stall:r${i}`, 'stall', 10 - i))
  const { file, overBudget } = withinBudget(patternsOver(many))
  expect(file).toHaveLength(MAX_SIGNALS_PER_PASS)
  expect(overBudget.map((p) => p.key)).toEqual(['stall:r5', 'stall:r6', 'stall:r7'])
  expect(named(overBudget)).toBe('stall:r5 (5), stall:r6 (4), stall:r7 (3)')
})

test('the title carries no count, so a repeat has the same fingerprint input', () => {
  const titles = [2, 7].flatMap((n) =>
    patternsOver([count('lead_gone', 'lead_gone', n, 'Leads that were lost')]).map(signalTitle),
  )
  expect(titles).toEqual(['Friction: Leads that were lost', 'Friction: Leads that were lost'])
})

test('the text names window, count, threshold, refs and the command; a pattern without Issues says so', () => {
  const facts = { from: '2026-11-01T00:00:00.000Z', to: '2026-11-08T00:00:00.000Z', days: 7, issues: 10 }
  const text = patternsOver([count('lead_gone', 'lead_gone', 3, 'Leads that were lost')])
    .map((p) => signalText(p, facts, ['issue_4', 'issue_2']))
    .join('')
  for (const part of [
    '2026-11-01',
    '2026-11-08',
    'Count: 3',
    'Threshold: 2',
    'issue_4, issue_2',
    'factory read friction --days 7',
  ]) {
    expect(text).toContain(part)
  }
  const note = patternsOver([count('undelivered_note', 'undelivered_note', 1, 'Notes that never reached the lead')])
    .map((p) => signalText(p, facts, []))
    .join('')
  expect(note).toContain('no Issue behind it')
})
