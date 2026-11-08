import type { FrictionCount } from '@software-factory/contract'

/** The weekly pass reads this many days of counts. */
export const FRICTION_WINDOW_DAYS = 7

/** A pass is due when no pass was recorded within this long. */
export const FRICTION_PASS_EVERY_MS = FRICTION_WINDOW_DAYS * 24 * 3_600_000

/** One pass files at most this many signals; the patterns left out are named in the pass record. */
export const MAX_SIGNALS_PER_PASS = 5

/** Evidence Issue refs shown in one signal. */
export const MAX_EVIDENCE = 5

/** The groups whose counts are findings; `decision_settled` is informational and has no row. */
type Judged = Exclude<FrictionCount['group'], 'decision_settled'>

/** The count within the window at which a pattern is a finding, with the reason in one line. */
export const THRESHOLDS: Record<Judged, { min: number; why: string }> = {
  refusal: { min: 3, why: 'one refusal is a typo, three of the same reason is a rule or a prompt that is wrong' },
  stall: { min: 2, why: 'a stall twice in a week is a cause, not weather' },
  lead_gone: { min: 2, why: 'a lead lost twice in a week points at the host or the harness' },
  undelivered_note: { min: 1, why: 'a note that never reached its lead is a broken promise' },
  unreviewed_ship: { min: 2, why: 'one unreviewed ship is a skip, two is a habit or a broken review path' },
  regression: { min: 1, why: 'a shipped change that regressed always needs a look' },
  avoidable_touch: {
    min: 3,
    why: 'the owner stepping in three times for the same thing means the factory should have',
  },
  signal: { min: 3, why: 'three held signals from one source is a route or a trust rule to settle' },
}

/** Groups whose events map to Issues; the others (an undelivered note, a held signal) carry no Issue refs. */
const WITHOUT_ISSUES = new Set<FrictionCount['group']>(['undelivered_note', 'signal'])

export interface Pattern {
  key: string
  group: FrictionCount['group']
  label: string
  count: number
  perIssue: number | null
  threshold: number
  why: string
}

/** `refusal:total` and the like add up the detail keys beside them; filing them too would double every finding. */
const isAggregate = (key: string): boolean => key.endsWith(':total')

/** The patterns over their threshold, most frequent first (ties by key). */
export function patternsOver(counts: readonly FrictionCount[]): Pattern[] {
  const over: Pattern[] = []
  for (const c of counts) {
    if (c.group === 'decision_settled' || isAggregate(c.key)) continue
    const rule = THRESHOLDS[c.group]
    if (c.count < rule.min) continue
    over.push({
      key: c.key,
      group: c.group,
      label: c.label,
      count: c.count,
      perIssue: c.perIssue,
      threshold: rule.min,
      why: rule.why,
    })
  }
  return over.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** The first `MAX_SIGNALS_PER_PASS` patterns are filed; the rest are named, never dropped. */
export function withinBudget(patterns: readonly Pattern[]): { file: Pattern[]; overBudget: Pattern[] } {
  return { file: patterns.slice(0, MAX_SIGNALS_PER_PASS), overBudget: patterns.slice(MAX_SIGNALS_PER_PASS) }
}

export const hasIssueRefs = (pattern: Pattern): boolean => !WITHOUT_ISSUES.has(pattern.group)

/** Stable per pattern: the fingerprint drops digits and punctuation, and the count is not in it, so a repeat dedups. */
export const signalTitle = (pattern: Pattern): string => `Friction: ${pattern.label}`.slice(0, 512)

export interface PassFacts {
  from: string
  to: string
  days: number
  issues: number
}

const rate = (pattern: Pattern): string =>
  pattern.perIssue === null ? 'no Issue was filed in the window' : `${pattern.perIssue.toFixed(2)} per Issue filed`

/** The signal's text: what was counted, over what, against which threshold, which Issues show it, and how to look again. */
export function signalText(pattern: Pattern, facts: PassFacts, refs: readonly string[]): string {
  const evidence = !hasIssueRefs(pattern)
    ? 'Evidence: this count has no Issue behind it (it counts notes or held signals, not Issue events), so there are no refs.'
    : refs.length === 0
      ? 'Evidence: no Issue ref could be read for this count.'
      : `Evidence (the most recent Issues, up to ${MAX_EVIDENCE}): ${refs.slice(0, MAX_EVIDENCE).join(', ')}`
  return [
    `Pattern: ${pattern.label} (${pattern.key})`,
    `Window: ${facts.from} to ${facts.to} (${facts.days} days)`,
    `Count: ${pattern.count} (${rate(pattern)}); Issues filed in the window: ${facts.issues}`,
    `Threshold: ${pattern.threshold} in the window. ${pattern.why}.`,
    evidence,
    `Reproduce: factory read friction --days ${facts.days}`,
  ].join('\n')
}

/** `<key> (<count>)` for the pass line and the record. */
export const named = (items: readonly { key: string; count: number }[]): string =>
  items.map((item) => `${item.key} (${item.count})`).join(', ')
