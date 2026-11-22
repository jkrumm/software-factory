import {
  type FrictionCount,
  type JudgmentLedger,
  type JudgmentsModel,
  type FrictionRule,
  type JudgedFrictionGroup,
  type Kpi,
  type KpiPart,
  type KpiTargetValue,
  meetsTarget,
  targetPhrase,
  THRESHOLDS,
} from '@software-factory/contract'
import { isFinding } from '../../kernel/judgments.ts'
import { MAX_SIGNALS_PER_PASS } from '../../kernel/signal-budget.ts'

/** A pass reads this many days of counts: the thresholds below are a week's. */
export const FRICTION_WINDOW_DAYS = 7

/** A pattern whose Issue closed less than this long ago is not filed again: the window the counts are read over. */
export const PATTERN_REPEAT_MS = FRICTION_WINDOW_DAYS * 24 * 3_600_000

/** A pass is due when no pass was recorded within this long... */
const FRICTION_PASS_EVERY_MS = 24 * 3_600_000

/** ...or when this many Issues closed since the last one, whichever comes first: at 126 to 166 closed a day the weekly pace looked at a thousand Issues per pass. */
const FRICTION_PASS_EVERY_CLOSED = 200

/** Why a pass runs now: nothing recorded yet, a day since the last, or the volume of closed Issues. */
export type PassTrigger = 'first' | 'day' | 'volume'

/** `first` or `day` when the clock makes a pass due; null when it does not (the volume is then the other trigger). */
export function clockTrigger(lastAt: Date | null, now: Date): PassTrigger | null {
  if (lastAt === null) return 'first'
  return lastAt.getTime() <= now.getTime() - FRICTION_PASS_EVERY_MS ? 'day' : null
}

/** Whether the Issues closed since the last pass make one due. */
export const volumeDue = (closedSince: number): boolean => closedSince >= FRICTION_PASS_EVERY_CLOSED

/** Evidence Issue refs shown in one signal. */
const MAX_EVIDENCE = 5

/** The groups whose counts are findings: `decision_answered` and `api_transient` are informational and have no rule. */
type Judged = JudgedFrictionGroup

/** What makes a count a finding (`THRESHOLDS.friction` in the contract holds every one). */
type Rule = FrictionRule

/** A rate stands on at least this many Issues closed in the window; under it, no rate-judged pattern is a finding. */
export const MIN_CLOSED = THRESHOLDS.friction.minClosed

/** The rule of each group, and the rules of single keys over their group's (`packages/contract/src/thresholds.ts`). */
const GROUP_RULES: Readonly<Record<Judged, Rule>> = THRESHOLDS.friction.groups
const BY_KEY: Readonly<Record<string, Rule>> = THRESHOLDS.friction.keys

/** Patterns whose mechanism is gone: the review gate that refused a ship (NL23). Never a finding. */
const RETIRED: readonly RegExp[] = [/^ship_refused:review_gate_retired$/]

export const isRetired = (key: string): boolean => RETIRED.some((pattern) => pattern.test(key))

const ruleOf = (key: string, group: Judged): Rule => BY_KEY[key] ?? GROUP_RULES[group]

/** Groups whose events map to Issues; the others (an undelivered note, a quarantined signal) carry no Issue refs. */
const WITHOUT_ISSUES = new Set<PatternGroup>(['undelivered_note', 'signal', 'api_refused', 'kpi', 'judge'])

/** A friction count's group, `kpi` (one of the seven KPIs off its target) or `judge` (a judge whose answers did not stand). */
export type PatternGroup = FrictionCount['group'] | 'kpi' | 'judge'

export interface Pattern {
  key: string
  group: PatternGroup
  label: string
  count: number
  perIssue: number | null
  threshold: number
  /** the least `perIssue` (per Issue closed), or null when the count alone decides */
  rate: number | null
  why: string
  /** a KPI finding's figure: the KPI as read, its target and its largest part; absent on a count */
  kpi?: { value: number; unit: Kpi['unit']; n: number; target: KpiTargetValue; largest: KpiPart | null }
  /** a judge finding's ledger: its counts and the newest answers that did not stand; absent on a count and a KPI */
  judge?: JudgmentLedger
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
    if (c.group === 'decision_answered' || c.group === 'api_transient' || isAggregate(c.key) || isRetired(c.key))
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

/** One of the seven KPIs as the friction pass reads it: the figure of the pass's window with its parts, no history. */
export type KpiReading = Pick<Kpi, 'key' | 'label' | 'value' | 'unit' | 'n' | 'count' | 'measured' | 'target' | 'parts'>

/**
 * The number a KPI finding is filed against and judged by once its Issue closes, read so that lower is better (the loop
 * ledger's rule for every figure): an `at_most` KPI's own value, an `at_least` share's shortfall from 1.
 */
export const kpiFigure = (target: KpiTargetValue, value: number): number =>
  target.kind === 'at_least' ? 1 - value : value

/** The units of a KPI that is a rate over Issues: judged only from `MIN_CLOSED` Issues, like a friction rate. */
const OVER_ISSUES: ReadonlySet<Kpi['unit']> = new Set(['per_issue', 'per_100_issues'])

/**
 * Where to start in a KPI's breakdown. Parts that are shares of their own group's answers (`count` of `n`) are ranked by
 * `count`: the share of a group of two says nothing next to one of sixty-five. The rest are ranked by value.
 */
function largestPart(parts: readonly KpiPart[]): KpiPart | null {
  const counted = parts.filter((part) => part.count !== undefined)
  if (counted.length > 0) {
    return counted.toSorted((a, b) => (b.count ?? 0) - (a.count ?? 0) || b.value - a.value)[0] ?? null
  }
  return parts.toSorted((a, b) => b.value - a.value)[0] ?? null
}

/**
 * The KPIs off their target (`THRESHOLDS.kpis`) over a whole window, as patterns keyed `kpi:<key>`, each naming its largest
 * part: for avoidable touches, the touch kind to remove first. A window the counting epoch cut is not whole and judges none; a
 * KPI with no figure, a rate over fewer than `MIN_CLOSED` Issues, or no number for a target yet, is never a finding.
 */
export function kpisOffTarget(readings: readonly KpiReading[], window: { whole: boolean }): Pattern[] {
  if (!window.whole) return []
  const over: Pattern[] = []
  for (const reading of readings) {
    if (!reading.measured || reading.value === null) continue
    // a rate over Issues stands on as many as a friction rate does; a share or a median has its own floor in the read
    if (OVER_ISSUES.has(reading.unit) && reading.n < MIN_CLOSED) continue
    if (meetsTarget(reading.target, reading.value) !== false) continue
    const largest = largestPart(reading.parts)
    over.push({
      key: `kpi:${reading.key}`,
      group: 'kpi',
      label: `${reading.label} off its target${largest ? `, largest part: ${largest.label}` : ''}`,
      count: kpiFigure(reading.target, reading.value),
      perIssue: null,
      threshold: 1,
      rate: null,
      why: 'a KPI off its target for a whole window is the one figure the owner set a line for; its largest part is where to start',
      kpi: { value: reading.value, unit: reading.unit, n: reading.n, target: reading.target, largest },
    })
  }
  return over
}

/**
 * The judges whose answers did not stand over `THRESHOLDS.judges.share` of the decided ones, from at least
 * `THRESHOLDS.judges.minAnswers` of them, as patterns keyed `judge:<judge>`. The count is the share (lower is better, the
 * figure the ledger judges the finding's Issue by once it closes).
 */
export function judgesOverruled(model: Pick<JudgmentsModel, 'judges'>): Pattern[] {
  return model.judges.filter(isFinding).map((ledger) => ({
    key: `judge:${ledger.judge}`,
    group: 'judge' as const,
    label: `${ledger.label}: ${Math.round((ledger.share ?? 0) * 100)}% of its answers did not stand`,
    count: ledger.share ?? 0,
    perIssue: null,
    threshold: THRESHOLDS.judges.minAnswers,
    rate: THRESHOLDS.judges.share,
    why: 'a judge whose answers are overruled or come back is wrong more often than the line the owner set: its input or its prompt is missing something',
    judge: ledger,
  }))
}

/** A judge finding's text: its counts, the rule that says an answer did not stand, the newest that did not, and how to look again. */
function judgeSignalText(pattern: Pattern, ledger: JudgmentLedger, facts: PassFacts, last: string | null): string {
  const decided = ledger.stood + ledger.didNotStand
  return [
    `Pattern: ${pattern.label} (${pattern.key})`,
    `Window: ${facts.from} to ${facts.to} (${THRESHOLDS.judges.windowDays} days of answers)`,
    `Answers: ${ledger.answers}, of which ${decided} decided: ${ledger.stood} stood, ${ledger.didNotStand} did not (${((ledger.share ?? 0) * 100).toFixed(0)}%), ${ledger.unknown} too early to say`,
    `Did not stand when: ${ledger.rule}`,
    ...ledger.newest.map(
      (a) =>
        `Newest that did not (${a.outcome}, ${a.at.slice(0, 10)}${a.issue ? `, ${a.issue}` : ''}): ${a.subject} -> ${a.answer}`,
    ),
    ...(last === null ? [] : [last]),
    `Threshold: more than ${THRESHOLDS.judges.share * 100}% of the decided answers over at least ${THRESHOLDS.judges.minAnswers} (THRESHOLDS.judges). ${pattern.why}.`,
    `Reproduce: factory read judgments --days ${THRESHOLDS.judges.windowDays}`,
  ].join('\n')
}

/** A KPI value in words, in its unit. */
function valueWords(unit: Kpi['unit'], value: number): string {
  if (unit === 'share') return `${(value * 100).toFixed(1)}%`
  if (unit === 'ms') return `${(value / 3_600_000).toFixed(1)} h`
  if (unit === 'usd') return `$${value.toFixed(2)}`
  return Number(value.toFixed(3)).toString()
}

/** The first `MAX_SIGNALS_PER_PASS` patterns are filed; the rest are named, never dropped. */
export function withinBudget(patterns: readonly Pattern[]): { file: Pattern[]; overBudget: Pattern[] } {
  return { file: patterns.slice(0, MAX_SIGNALS_PER_PASS), overBudget: patterns.slice(MAX_SIGNALS_PER_PASS) }
}

export const hasIssueRefs = (pattern: Pattern): boolean => !WITHOUT_ISSUES.has(pattern.group)

/** Stable per pattern for the lead's reading; intake matches a repeat by the pattern key, never by this title. */
export const signalTitle = (pattern: Pattern): string => `Friction: ${pattern.label}`.slice(0, 512)

export interface PassFacts {
  from: string
  to: string
  days: number
  /** the counting epoch the window was cut at, when it was cut */
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
export function signalText(
  pattern: Pattern,
  facts: PassFacts,
  refs: readonly string[],
  last: string | null = null,
): string {
  if (pattern.kpi) return kpiSignalText(pattern, pattern.kpi, facts, last)
  if (pattern.judge) return judgeSignalText(pattern, pattern.judge, facts, last)
  const evidence = !hasIssueRefs(pattern)
    ? 'Evidence: this count has no Issue behind it (it counts notes or quarantined signals, not Issue events), so there are no refs.'
    : refs.length === 0
      ? 'Evidence: no Issue ref could be read for this count.'
      : `Evidence (the most recent Issues, up to ${MAX_EVIDENCE}): ${refs.slice(0, MAX_EVIDENCE).join(', ')}`
  return [
    `Pattern: ${pattern.label} (${pattern.key})`,
    `Window: ${facts.from} to ${facts.to} (${facts.days} days${facts.since ? `, cut at the counting epoch ${facts.since}` : ''})`,
    `Count: ${pattern.count} (${rate(pattern)}); Issues filed in the window: ${facts.issues}, closed: ${facts.closed}`,
    ...(last === null ? [] : [last]),
    `Threshold: ${thresholdOf(pattern)}. ${pattern.why}.`,
    evidence,
    `Reproduce: factory read friction --days ${facts.days}`,
  ].join('\n')
}

/** A KPI finding's text: the figure, its target, its largest part, and how to look again. */
function kpiSignalText(
  pattern: Pattern,
  kpi: NonNullable<Pattern['kpi']>,
  facts: PassFacts,
  last: string | null,
): string {
  const target = targetPhrase(kpi.target, kpi.unit === 'share' ? 'share' : kpi.unit === 'ms' ? 'ms' : 'raw')
  return [
    `Pattern: ${pattern.label} (${pattern.key})`,
    `Window: ${facts.from} to ${facts.to} (${facts.days} days, whole)`,
    `Figure: ${valueWords(kpi.unit, kpi.value)} over ${kpi.n}, target ${target}; Issues filed in the window: ${facts.issues}, closed: ${facts.closed}`,
    kpi.largest
      ? `Largest part: ${kpi.largest.label} (${kpi.largest.key}, ${valueWords(kpi.largest.unit, kpi.largest.value)}${kpi.largest.count === undefined ? '' : `, ${kpi.largest.count} of ${kpi.largest.n}`})`
      : 'Largest part: this KPI has no parts in the window.',
    ...(last === null ? [] : [last]),
    `Threshold: the KPI's target in THRESHOLDS.kpis (packages/contract/src/thresholds.ts), judged over a whole window. ${pattern.why}.`,
    `Reproduce: factory read kpis --days ${facts.days}`,
  ].join('\n')
}

/** `<key> (<count>)` for the pass line and the record. */
export const named = (items: readonly { key: string; count: number }[]): string =>
  items.map((item) => `${item.key} (${item.count})`).join(', ')
