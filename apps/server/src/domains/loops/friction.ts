import type { FrictionCount } from '@software-factory/contract'

/** The weekly pass reads this many days of counts. */
export const FRICTION_WINDOW_DAYS = 7

/** A pass is due when no pass was recorded within this long. */
export const FRICTION_PASS_EVERY_MS = FRICTION_WINDOW_DAYS * 24 * 3_600_000

/** One pass files at most this many signals; the patterns left out are named in the pass record. */
export const MAX_SIGNALS_PER_PASS = 5

/** Evidence Issue refs shown in one signal. */
export const MAX_EVIDENCE = 5

/** The groups whose counts are findings; `decision_settled` and `api_transient` (an edge incident the factory answered itself) are informational and have no row. */
type Judged = Exclude<FrictionCount['group'], 'decision_settled' | 'api_transient'>

/**
 * What makes a count a finding, with the reason in one line. `min` is the least count; `rate` is the share of Issues
 * closed in the window that must show it (`perIssue`), judged only once `MIN_CLOSED` Issues closed. A `null` rate marks a
 * pattern that is serious at any rate, so its count alone decides.
 */
export interface Rule {
  min: number
  rate: number | null
  why: string
}

/** A rate stands on at least this many Issues closed in the window; under it, no rate-judged pattern is a finding. */
export const MIN_CLOSED = 10

export const THRESHOLDS: Record<Judged, Rule> = {
  refusal: {
    min: 3,
    rate: 0.1,
    why: 'the same refusal on one in ten closed Issues is a rule or a prompt that is wrong',
  },
  stall: { min: 2, rate: null, why: 'a stall twice in a week is a cause, not weather' },
  lead_gone: { min: 2, rate: null, why: 'a lead lost twice in a week points at the host or the harness' },
  undelivered_note: { min: 1, rate: null, why: 'a note that never reached its lead is a broken promise' },
  unreviewed_ship: {
    min: 3,
    rate: 0.25,
    why: 'ships with no review on one in four closed Issues is a habit or a broken review path',
  },
  unstated_acceptance: {
    min: 3,
    rate: 0.25,
    why: 'ships that state nothing against the acceptance on one in four closed Issues is a habit or a brief that never asks',
  },
  unproven_ci: {
    min: 3,
    rate: 0.25,
    why: 'ships whose pull request CI was red or missing on one in four closed Issues is a lead that lands before CI says so, or a repo with no CI',
  },
  regression: { min: 1, rate: null, why: 'a shipped change that regressed always needs a look' },
  avoidable_touch: {
    min: 3,
    rate: 0.15,
    why: 'the owner stepping in on one in seven closed Issues for the same thing means the factory should have',
  },
  orchestrator_steer: {
    min: 5,
    rate: 0.5,
    why: "the orchestrator steering leads on one in two closed Issues is the factory's real avoidable-touch rate: its leads are not briefed or unblocked well enough to work alone",
  },
  signal: {
    min: 3,
    rate: 0.2,
    why: 'held signals from one source on one in five closed Issues is a route or a trust rule to settle',
  },
}

/** Touches the owner uses to steer and to triage: they file only at a higher rate than a touch that is a failure. */
const STEERING: Record<string, Rule> = {
  'touch:noted': {
    min: 5,
    rate: 0.5,
    why: 'owner notes on one in two closed Issues (free-form `issue note` calls, not the orchestrator steering) means the leads are not briefed well enough to work alone',
  },
  'touch:cancelled': {
    min: 3,
    rate: 0.4,
    why: 'owner cancels on two in five closed Issues means the intake files work nobody wanted',
  },
}

/** Patterns whose mechanism is gone: the review gate that refused a ship (NL23). Never a finding. */
const RETIRED: readonly RegExp[] = [/^ship_refused:ship refused, review /]

export const isRetired = (key: string): boolean => RETIRED.some((pattern) => pattern.test(key))

const ruleOf = (key: string, group: Judged): Rule => STEERING[key] ?? THRESHOLDS[group]

/** Groups whose events map to Issues; the others (an undelivered note, a held signal) carry no Issue refs. */
const WITHOUT_ISSUES = new Set<FrictionCount['group']>(['undelivered_note', 'signal'])

export interface Pattern {
  key: string
  group: FrictionCount['group']
  label: string
  count: number
  perIssue: number | null
  threshold: number
  /** the least `perIssue` (per Issue closed), or null when the count alone decides */
  rate: number | null
  why: string
}

/** `refusal:total` and the like add up the detail keys beside them; filing them too would double every finding. */
const isAggregate = (key: string): boolean => key.endsWith(':total')

/**
 * The patterns over their threshold, most frequent first (ties by key). A pattern with a rate is judged on the Issues
 * closed in the window and stays quiet under `MIN_CLOSED`; a retired pattern is never judged.
 */
export function patternsOver(counts: readonly FrictionCount[], closed: number): Pattern[] {
  const over: Pattern[] = []
  for (const c of counts) {
    if (c.group === 'decision_settled' || c.group === 'api_transient' || isAggregate(c.key) || isRetired(c.key))
      continue
    const rule = ruleOf(c.key, c.group)
    if (c.count < rule.min) continue
    if (rule.rate !== null && (closed < MIN_CLOSED || c.perIssue === null || c.perIssue < rule.rate)) continue
    over.push({
      key: c.key,
      group: c.group,
      label: c.label,
      count: c.count,
      perIssue: c.perIssue,
      threshold: rule.min,
      rate: rule.rate,
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
  /** the import marker the window was cut at, when it was */
  since: string | null
  issues: number
  closed: number
}

const rate = (pattern: Pattern): string =>
  pattern.perIssue === null ? 'no Issue closed in the window' : `${pattern.perIssue.toFixed(2)} per Issue closed`

const thresholdOf = (pattern: Pattern): string =>
  pattern.rate === null
    ? `${pattern.threshold} in the window`
    : `${pattern.threshold} in the window and ${pattern.rate.toFixed(2)} per Issue closed (judged from ${MIN_CLOSED} closed)`

/** The signal's text: what was counted, over what, against which threshold, which Issues show it, and how to look again. */
export function signalText(pattern: Pattern, facts: PassFacts, refs: readonly string[]): string {
  const evidence = !hasIssueRefs(pattern)
    ? 'Evidence: this count has no Issue behind it (it counts notes or held signals, not Issue events), so there are no refs.'
    : refs.length === 0
      ? 'Evidence: no Issue ref could be read for this count.'
      : `Evidence (the most recent Issues, up to ${MAX_EVIDENCE}): ${refs.slice(0, MAX_EVIDENCE).join(', ')}`
  return [
    `Pattern: ${pattern.label} (${pattern.key})`,
    `Window: ${facts.from} to ${facts.to} (${facts.days} days${facts.since ? `, cut at the import ${facts.since}` : ''})`,
    `Count: ${pattern.count} (${rate(pattern)}); Issues filed in the window: ${facts.issues}, closed: ${facts.closed}`,
    `Threshold: ${thresholdOf(pattern)}. ${pattern.why}.`,
    evidence,
    `Reproduce: factory read friction --days ${facts.days}`,
  ].join('\n')
}

/** `<key> (<count>)` for the pass line and the record. */
export const named = (items: readonly { key: string; count: number }[]): string =>
  items.map((item) => `${item.key} (${item.count})`).join(', ')
