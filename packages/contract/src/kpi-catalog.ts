import type { KpiDirection, KpiKey, KpiTargetValue } from './read-models.ts'
import { THRESHOLDS } from './thresholds.ts'

/**
 * What each of the seven KPIs is, stated once: its label, what is counted over what, which way is good, where its target came
 * from, and the decision it drives. The target itself is in `THRESHOLDS.kpis` (`thresholds.ts`), the one table the friction loop
 * judges by. The KPI read copies the label, target, direction and target source onto each figure, and the table in
 * `docs/product.md` is rendered from these rows (`renderKpiTable`, written by `bun scripts/kpi-table.ts`), so the code, the
 * screen and the docs say one thing. A test fails when the table and the catalog differ, when a target's kind contradicts its
 * direction and when a KPI has no decision.
 *
 * Rules for a row:
 * - `direction` is the side that is good: `lower` or `higher`.
 * - A `lower` KPI's target is `at_most`, a `higher` one's `at_least`. Never a band (`between`): a value better than a band
 *   would read as off target. A KPI with no number yet has a `trend` target and its source starts "No target yet" and says when.
 * - `decision` is what a person or a loop does differently when the figure moves; a KPI that drives none is not a KPI.
 */
export interface KpiSpec {
  label: string
  direction: KpiDirection
  target: KpiTargetValue
  targetSource: string
  /** what is counted, in a short phrase */
  numerator: string
  /** what it is divided by, or what the figure is a median or share of */
  denominator: string
  decision: string
}

const PROPOSED =
  'Proposed in the Spec of Issue 2606 (2026-11-20) and taken by the owner with "looks good", no measured basis beyond'

export const KPI_CATALOG: Record<KpiKey, KpiSpec> = {
  avoidable_touches: {
    label: 'Avoidable touches per Issue',
    direction: 'lower',
    target: THRESHOLDS.kpis.avoidable_touches,
    targetSource:
      'The owner, 2026-11-07, "Maybe 5% is a good KPI, 7% or so": signed as "at most 0.05 to 0.07" (docs/archive/strategy/2026-11-next/definition.html). Read as at most 0.07',
    numerator:
      'Owner actions on an Issue the factory should have settled, a loop’s Issues included (a Decision answered, a note, a wake, a cancel, a reopen; one burst of a kind counts once)',
    denominator:
      'Issues filed in the window by a person, an agent or an alert (the factory’s own loops left out: friction, hygiene, selfwatch, throughput)',
    decision:
      'Which touch kind to remove first: off target, the friction loop files a finding naming the largest kind, and a touch that repeats becomes a rule, a default or a brief change',
  },
  first_verification_passes: {
    label: 'First verification passes',
    direction: 'higher',
    target: THRESHOLDS.kpis.first_verification_passes,
    targetSource: 'docs/product.md, 2026-11-07 (the signed doc said at least 80%; the table was raised to 90%)',
    numerator: 'First watches that ended passed',
    denominator: 'First watches that ended passed or regressed in the window',
    decision:
      'Whether shipped changes hold in production; the parts name why each regression failed (CI, verify, deploy, probe), so the fix goes at the cause. Read beside the first watch dwell',
  },
  asks_not_needed: {
    label: 'Asks that did not need the owner',
    direction: 'lower',
    target: THRESHOLDS.kpis.asks_not_needed,
    targetSource:
      'Carried over from the Spec screen’s line (#306, 2026-11-10: one ask in five wasted on him), now read from his answers: of 85 verdicts in the eight days to 2026-11-21, 27 carried no word from him while the mark said 6',
    numerator:
      'The owner’s own answers that changed nothing: a verdict of Looks good with no note and no comment, a Decision answered with the recommendation',
    denominator: 'The owner’s own verdicts on a Concept or Spec and Decisions he answered in the window',
    decision:
      'Which kind of ask and, for a Spec, which source made it owed (triage, the filer, a Replan, the lead) and so which rule to change; a preference about how much to ask goes to order 2 of the lead brief',
  },
  errands_reached_per_100: {
    label: 'Errands that reached the owner per 100 Issues',
    direction: 'lower',
    target: THRESHOLDS.kpis.errands_reached_per_100,
    targetSource:
      'No target yet: one is set once three full weeks after the counting epoch exist (the first ends 2026-11-22); the first weeks gave 0, 1.8 and 5.0 per 100',
    numerator: 'Errands the screen let through to the owner',
    denominator: 'Issues filed in the window (per 100)',
    decision:
      'Which kind of Errand to take off him: the parts split by need (secret, hands, a place on his MacBook, only his yes); beside them, the share the screen turned away and the share his MacBook ran by itself',
  },
  cycle_p50: {
    label: 'Cycle, median',
    direction: 'lower',
    target: THRESHOLDS.kpis.cycle_p50,
    targetSource: `${PROPOSED} 1.5 times the worse full week (2.0 h)`,
    numerator: 'Median of filed-to-closed time',
    denominator: 'Issues that closed in the window',
    decision: 'Whether work is getting slower end to end; the parts (time by state) and the queue wait say where',
  },
  queue_wait_p90: {
    label: 'Queue wait, 90th percentile',
    direction: 'lower',
    target: THRESHOLDS.kpis.queue_wait_p90,
    targetSource: `${PROPOSED} the worse full week (8.3 h)`,
    numerator: '90th percentile of filed-or-reopened-to-admitted time',
    denominator: 'Admissions in the window',
    decision:
      'Whether to raise a cap or a seat count, or change a chain: the parts split the queued time by what held it (capacity, an after edge, a draining queue, production red)',
  },
  quota_at_reset: {
    label: 'Quota used at reset',
    direction: 'higher',
    target: THRESHOLDS.kpis.quota_at_reset,
    targetSource: `${PROPOSED} the weeks so far (0.94 to 0.98) and the accounts simulation (packages/accounts/docs/accounts.md, v1.9: 91-100 % at or above the pool's demand)`,
    numerator:
      'The weekly percent each account stood at when its weekly window reset, weighted by the account’s weekly capacity (the reset ledger of packages/accounts)',
    denominator: 'Account resets in the window, weighted by capacity',
    decision:
      'Whether the subscriptions are used: a low figure with Issues waiting means the picker leaves quota unspent (packages/accounts/docs/accounts.md §The picker); a high one with a long queue means a subscription is missing. Beside it: window points and dollars per Issue',
  },
}

/** The keys in the order the table lists them: the catalog's own order, which is the order they are written above. */
export const KPI_CATALOG_KEYS = Object.keys(KPI_CATALOG) as KpiKey[]

export const KPI_DIRECTION_WORD: Record<KpiDirection, string> = {
  lower: 'Lower',
  higher: 'Higher',
  watch: 'Watch only',
}

/** A target as the table and the screens say it. */
export function targetPhrase(target: KpiTargetValue, unit: 'share' | 'ms' | 'raw' = 'raw'): string {
  const show = (n: number) =>
    unit === 'share' ? `${Math.round(n * 100)}%` : unit === 'ms' ? `${Number((n / 3_600_000).toFixed(1))} h` : String(n)
  switch (target.kind) {
    case 'at_most':
      return `at most ${show(target.max ?? 0)}`
    case 'at_least':
      return `at least ${show(target.min ?? 0)}`
    case 'between':
      return `${show(target.min ?? 0)} to ${show(target.max ?? 0)}`
    case 'trend':
      return 'watch only'
    case 'unset':
      return 'none'
  }
}

/** How the table writes each KPI's target number: a share as a percent, a duration in hours. */
const TARGET_UNIT: Record<KpiKey, 'share' | 'ms' | 'raw'> = {
  avoidable_touches: 'raw',
  first_verification_passes: 'share',
  asks_not_needed: 'share',
  errands_reached_per_100: 'raw',
  cycle_p50: 'ms',
  queue_wait_p90: 'ms',
  quota_at_reset: 'share',
}

const cell = (text: string): string => text.replaceAll('|', '/').replaceAll('\n', ' ')

export const KPI_TABLE_START = '<!-- kpi-table:start -->'
export const KPI_TABLE_END = '<!-- kpi-table:end -->'

/**
 * The table of `docs/product.md` "How we know it works": one row per KPI of the catalog. Values are not in it (they move
 * every window); the definition, the direction, the target and its source, and the decision are.
 */
export function renderKpiTable(): string {
  const rows = KPI_CATALOG_KEYS.map((key) => {
    const spec = KPI_CATALOG[key]
    const target = targetPhrase(spec.target, TARGET_UNIT[key])
    return `| ${cell(spec.label)} | ${KPI_DIRECTION_WORD[spec.direction]} | ${target} | ${cell(spec.targetSource)} | ${cell(spec.numerator)} | ${cell(spec.denominator)} | ${cell(spec.decision)} |`
  })
  return [
    KPI_TABLE_START,
    '| KPI | Good | Target | Where the target comes from | Counts | Over | Decision it drives |',
    '|-|-|-|-|-|-|-|',
    ...rows,
    KPI_TABLE_END,
  ].join('\n')
}
