import type { KpiDirection, KpiKey, KpiTargetValue } from './read-models.ts'

/**
 * What every KPI is, stated once: its label, what is counted over what, which way is good, its target and where that came
 * from, and the decision it drives. The KPI read copies these onto each figure, and the table in `docs/product.md` is
 * rendered from them (`renderKpiTable`, written by `bun scripts/kpi-table.ts`), so the code, the screen and the docs say
 * one thing. A test fails when the table and the catalog differ, when a target's kind contradicts its direction and when a
 * KPI has no decision.
 *
 * Rules for a row:
 * - `direction` is the side that is good: `lower`, `higher`, or `watch` when no side is known (a trend to read, no verdict).
 * - A `lower` KPI's target is `at_most`, a `higher` one's `at_least`, a `watch` one's `trend`. Never a band (`between`): a
 *   value better than a band would read as off target. Nothing here is `unset`: a figure with no target says so as `trend`.
 * - `targetSource` names where the number came from, or why there is none ("watch only: ...").
 * - `decision` is what a person or a loop does differently when the figure moves; a KPI that drives none is dropped.
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

const WATCH: KpiTargetValue = { kind: 'trend', min: null, max: null }
const atMost = (max: number): KpiTargetValue => ({ kind: 'at_most', min: null, max })
const atLeast = (min: number): KpiTargetValue => ({ kind: 'at_least', min, max: null })

const OWNER_TOUCH_TARGET =
  'The owner, 2026-11-07, "Maybe 5% is a good KPI, 7% or so": signed as "at most 0.05 to 0.07" (docs/strategy/2026-11-next/definition.html). Read as at most 0.07: below it is better, never off target'

export const KPI_CATALOG: Record<KpiKey, KpiSpec> = {
  avoidable_touches: {
    label: 'Avoidable touches per Issue',
    direction: 'lower',
    target: atMost(0.07),
    targetSource: OWNER_TOUCH_TARGET,
    numerator:
      'Owner actions on an Issue the factory should have settled (a Decision answered, a note, a wake, a cancel, a reopen; one burst of a kind counts once)',
    denominator: 'Issues filed in the window',
    decision:
      'Which touch kind to remove first: the friction loop files the largest kind, and a touch that repeats becomes a rule, a default or a brief change',
  },
  asks: {
    label: 'Asks per Issue',
    direction: 'lower',
    target: atMost(0.07),
    targetSource: OWNER_TOUCH_TARGET,
    numerator:
      'Decisions raised that the factory did not settle itself (the owner or the orchestrator answered them, or they still wait)',
    denominator: 'Issues filed in the window',
    decision:
      'Whether a recurring Decision should become a standing policy or a Judge precedent; read beside owner Decisions per 100 Issues, since a path that asks nothing is not the goal either',
  },
  recommendation_taken: {
    label: 'Owner answers that took the lead’s recommendation',
    direction: 'lower',
    target: WATCH,
    targetSource:
      'Watch only: no basis for a number yet. Replaces the "worth asking" mark, which needed a click the owner never gave',
    numerator: 'Decisions the owner answered with the option the lead recommended',
    denominator: 'Decisions the owner answered in the window',
    decision:
      'A high share means leads ask what they already know: tighten the rule that decides when a lead may raise a Decision, or add a standing policy for the recurring question',
  },
  specs_per_100: {
    label: 'Specs per 100 Issues',
    direction: 'watch',
    target: WATCH,
    targetSource:
      'Watch only: a Spec is owed by rule, so no rate is right; near zero for weeks means the Spec path is silent',
    numerator: 'Specs the leads submitted',
    denominator: 'Issues filed in the window (per 100)',
    decision: 'Whether the Spec path is silent (triage and the lead’s Spec rules need a look) or flooding the owner',
  },
  owner_decisions_per_100: {
    label: 'Owner-settled Decisions per 100 Issues',
    direction: 'watch',
    target: WATCH,
    targetSource: 'Watch only: the floor that tells silence from success; asks per Issue is the one with a ceiling',
    numerator: 'Decisions the owner answered himself (not the Judge, a policy, a default or the orchestrator)',
    denominator: 'Issues filed in the window (per 100)',
    decision:
      'Whether anything reaches the owner at all: this and Specs per 100 both near zero means the checkpoints are silent, not that the factory is perfect',
  },
  errands_reached_per_100: {
    label: 'Errands that reached the owner per 100 Issues',
    direction: 'lower',
    target: WATCH,
    targetSource: 'Watch only: the first weeks of data (0, 1.5, 5.1 per 100) give no basis for a number',
    numerator: 'Errands the screen let through to the owner',
    denominator: 'Issues filed in the window (per 100)',
    decision:
      'Which kind of Errand to take off him: the parts split by need (secret, hands, a place on his MacBook, only his yes)',
  },
  errands_no_secret_no_hands: {
    label: 'Errands that reached the owner needing neither a secret nor hands',
    direction: 'lower',
    target: WATCH,
    targetSource: 'Watch only: the aim is zero, but the first reading is not in yet',
    numerator: 'Errands that reached him needing a place on his MacBook or only his yes',
    denominator: 'Errands that reached the owner in the window',
    decision:
      'Each one is a step a token or a command could take: add the verb (the lead does it itself) or a screen rule that turns the Errand away',
  },
  errands_auto_run_share: {
    label: 'Errands the MacBook ran by itself',
    direction: 'higher',
    target: WATCH,
    targetSource:
      'Watch only: the first class (secrets-seed) shipped 2026-11-19, so there is no reading to set a number from',
    numerator: 'Errands closed by a granted auto-run class in the window',
    denominator:
      'Errands that reached the owner in the window, plus those that ran by themselves before they reached him',
    decision:
      'Which command shape repeats with no refusal and joins the catalogue next: the lead of dotfiles adds a row, he grants it once',
  },
  specs_not_needed: {
    label: 'Specs at the owner not needed',
    direction: 'lower',
    target: atMost(0.2),
    targetSource:
      'Set with the Spec screen (#306, 2026-11-10), no measured basis: one Spec in five wasted on him is the line the screen is judged by',
    numerator: 'The owner’s own verdicts on a Spec marked "needed me: no"',
    denominator: 'The owner’s own verdicts on a Spec in the window',
    decision:
      'Which source made the unneeded Spec owed (triage, the filer, a Replan, the lead) and so which rule to change',
  },
  verdict_changes_share: {
    label: 'Owner verdicts that ask for changes',
    direction: 'lower',
    target: WATCH,
    targetSource:
      'Watch only: a Concept or Spec may rightly need notes; falling over time is the aim, a number is not set',
    numerator: 'The owner’s own verdicts on a Concept, Spec or Report that were good with notes or changes',
    denominator: 'The owner’s own verdicts in the window',
    decision:
      'Whether leads know his taste: a high share means the retro’s recurring notes are not reaching the next lead',
  },
  first_verification_passes: {
    label: 'First verification passes',
    direction: 'higher',
    target: atLeast(0.9),
    targetSource: 'docs/product.md, 2026-11-07 (the signed doc said at least 80%; the table was raised to 90%)',
    numerator: 'First watches that ended passed',
    denominator: 'First watches that ended passed or regressed in the window',
    decision:
      'Whether shipped changes hold in production; the parts name why each regression failed (CI, verify, deploy, probe), so the fix goes at the cause. Read beside the first watch dwell',
  },
  refusals: {
    label: 'Refusals per Issue',
    direction: 'lower',
    target: atMost(0.25),
    targetSource: 'The owner’s signed table, 2026-11-07 (docs/strategy/2026-11-next/definition.html): at most 0.25',
    numerator: 'Issue events the state machine refused, plus ships the gate refused',
    denominator: 'Issues filed in the window',
    decision: 'Which refusal repeats: a rule or a prompt that is wrong, so the friction loop files it',
  },
  cycle_p50: {
    label: 'Cycle, median',
    direction: 'lower',
    target: WATCH,
    targetSource:
      'Watch only: no basis. product.md said "set after parallel leads"; parallel leads run now and the window still moves too much (0.5 h, 0.9 h, 2.3 h) to set one',
    numerator: 'Median of filed-to-closed time',
    denominator: 'Issues that closed in the window',
    decision: 'Whether work is getting slower end to end; the queue wait and the working share say where',
  },
  queue_wait_p90: {
    label: 'Queue wait, 90th percentile',
    direction: 'lower',
    target: WATCH,
    targetSource: 'Watch only: no basis; the tail is set by chains and caps the owner chose',
    numerator: '90th percentile of filed-or-reopened-to-admitted time',
    denominator: 'Admissions in the window',
    decision: 'Whether to raise a cap or a seat count, or change a chain: the tail is where an Issue waits for hours',
  },
  fix_commits: {
    label: 'Fix commits per week, by class',
    direction: 'lower',
    target: WATCH,
    targetSource: 'Watch only: falling over four weeks is the aim; no number is set',
    numerator: 'Commits with a conventional fix subject on a project’s default branch, by class',
    denominator: 'Each of the last four weeks (a count, not a ratio)',
    decision:
      'Which class of fix keeps coming back (tests, contract, concurrency, environment) and so which gate or rule to add',
  },
  window_points: {
    label: 'Window points per Issue',
    direction: 'lower',
    target: WATCH,
    targetSource: 'Watch only: no basis; read as a trend and against the Max quota left',
    numerator: 'Points of the five-hour Max window the Issues’ sessions used',
    denominator: 'Issues filed in the window',
    decision:
      'Whether the subscriptions carry the work: a rise means a seat or a tier is spending more than its Issues return',
  },
  cost: {
    label: 'Cost per Issue',
    direction: 'lower',
    target: WATCH,
    targetSource: 'Watch only: development runs on flat-rate Max subscriptions, so the dollars are notional',
    numerator: 'Dollars the usage schema priced for the Issues’ sessions',
    denominator: 'Issues filed in the window',
    decision:
      'Which seat (tool, model, effort) spends most, from the parts: whether a tier or a role costs more than its Issues return; the real limit is window points',
  },
  queue_capacity_share: {
    label: 'Share of queued time held by capacity',
    direction: 'lower',
    target: WATCH,
    targetSource:
      'Watch only: some queueing is by design (the chain); the share a cap or a slot holds is the figure to lower',
    numerator:
      'Queued time no after edge held (the repo’s lead cap, a seat, a slot, an account window, the queue state)',
    denominator: 'All queued time that ended in the window',
    decision: 'Whether to tune capacity (caps, seats, slots) or the chains: the parts split the time between the two',
  },
  idle_capacity: {
    label: 'Idle capacity behind a queue',
    direction: 'lower',
    target: WATCH,
    targetSource:
      'Watch only: high by construction while a repo’s lead cap holds an Issue; read beside the capacity loop’s reasons',
    numerator: 'Hours an unchained Issue sat queued while an enabled account had room',
    denominator: 'Hours of the window with an unchained Issue queued',
    decision: 'Whether capacity is idle behind a queue: it sends the capacity loop to the reason that holds the Issue',
  },
  working_share: {
    label: 'Working share of a lead’s time',
    direction: 'higher',
    target: WATCH,
    targetSource: 'Watch only: waits on a Decision, a review or a timer are by design; the share is read as a trend',
    numerator: 'Time Issues spent working',
    denominator: 'Time spent working or waiting, for the intervals that ended in the window',
    decision: 'Which wait reason takes most of a lead’s time (the parts): that wait is the one to shorten or remove',
  },
  dropped_after_lead: {
    label: 'Issues dropped or cancelled after a lead started',
    direction: 'lower',
    target: WATCH,
    targetSource: 'Watch only: a duplicate or noise Issue is dropped by design; the aim is a falling share',
    numerator: 'Issues that closed dropped or cancelled after a lead was admitted',
    denominator: 'Issues that closed in the window after a lead was admitted',
    decision: 'Whether intake and triage let work through that nobody wanted: lead time spent on nothing',
  },
  nudges_acted: {
    label: 'Steward nudges a lead acted on',
    direction: 'higher',
    target: WATCH,
    targetSource: 'Watch only: a nudge to a lead that is mid-thought rightly gets no verb; no basis for a number',
    numerator: 'Steward notes followed within 30 minutes by the lead’s own verb',
    denominator: 'Steward notes sent in the window',
    decision:
      'Whether the steward’s nudges work: a low share means a nudge is noise or the stalls it chases are not the lead’s to fix',
  },
  errands_turned_away: {
    label: 'Errands the screen turned away',
    direction: 'higher',
    target: WATCH,
    targetSource:
      'Watch only: a high share can also mean leads raise Errands they should not; read beside Errands that reached him',
    numerator: 'Errands turned away by a rule or the Judge before they reached him',
    denominator: 'Errands raised in the window',
    decision:
      'Whether the screen takes work off the owner: a falling share with Errands reaching him means a rule is missing',
  },
  first_watch_dwell_p50: {
    label: 'First watch, median time to its answer',
    direction: 'watch',
    target: WATCH,
    targetSource:
      'Watch only: a pass over watches that answer in seconds checks little, and one that waits an hour slows the queue; no side is right',
    numerator: 'Median of a first watch’s start-to-answer time',
    denominator: 'First watches answered in the window',
    decision: 'Whether first verification passes mean anything: a pass rate over instant watches is not evidence',
  },
  quota_at_reset: {
    label: 'Quota used at reset',
    direction: 'higher',
    target: WATCH,
    targetSource:
      'Watch only: demand sets the ceiling, not a goal (docs/accounts.md, the v1.9 simulation: at a demand below the pool slack is unavoidable, at or above it every window fills to 91-100 %); read it beside how many Issues waited',
    numerator:
      'The weekly percent each account stood at when its weekly window reset, weighted by the account’s weekly capacity (the reset ledger of packages/accounts)',
    denominator: 'Account resets in the window, weighted by capacity',
    decision:
      'Whether the subscriptions are used: a low figure with Issues waiting means the rule leaves quota unspent (docs/accounts.md §The picker); a high one with a long queue means a subscription is missing',
  },
  issues_closed_per_day: {
    label: 'Issues closed per day',
    direction: 'higher',
    target: WATCH,
    targetSource:
      'Watch only: set by the capacity the host and the subscriptions give, not by a goal; the throughput loop reads the same count',
    numerator: 'Issues that closed (any outcome; dropped ones show in the dropped share)',
    denominator: 'Days in the window',
    decision:
      'Whether the factory moves faster or slower than last week; a fall with a queue behind it sends the capacity loop to the reason',
  },
  test_slot_wait_p50: {
    label: 'Test slot wait, median',
    direction: 'lower',
    target: WATCH,
    targetSource: 'Watch only: no basis; the capacity loop tunes the slot count from the same waits',
    numerator: 'Median of a step’s wait for a test slot',
    denominator: 'Steps that ran in the window',
    decision: 'Whether to add a test slot: a long wait means leads idle on a gate',
  },
  minutes_over_ceiling: {
    label: 'Share of minutes over the load ceiling',
    direction: 'lower',
    target: WATCH,
    targetSource:
      'Watch only: the ceiling is the admission guard, not a goal; a share that rises means the guard runs too late',
    numerator: 'Minutes the host’s load was above its ceiling',
    denominator: 'Minutes sampled in the window',
    decision: 'Whether to lower the ceiling or the lead count: the host is overcommitted when work still runs above it',
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
export function targetPhrase(target: KpiTargetValue, unit: 'share' | 'raw' = 'raw'): string {
  const show = (n: number) => (unit === 'share' ? `${Math.round(n * 100)}%` : String(n))
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

const SHARE_TARGETS: ReadonlySet<KpiKey> = new Set(['specs_not_needed', 'first_verification_passes'])

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
    const target = targetPhrase(spec.target, SHARE_TARGETS.has(key) ? 'share' : 'raw')
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
