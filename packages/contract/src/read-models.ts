import * as z from 'zod'
import { QueueReason, QueueStatesView } from './capacity.ts'
import { SIGNAL_ORIGINS } from './intake.ts'
import { IssueRef } from './planning.ts'
import { EFFORTS, LeadSeat, TIERS } from './roles.ts'
import { WORK_WORDS, WorkCounts } from './work-words.ts'

/**
 * The Console's computed screens: what waits on the owner, the Issues by state, the chain, the KPIs and the friction. Each
 * is a read model over the stored facts (`GET /v1/needs|flow|chain|kpis|friction`). Titles and summaries are plain words:
 * an id is a field to link by, never display text.
 */

const at = z.string().describe('an ISO timestamp')

// -- needs ---------------------------------------------------------------------------------------------------------------

export const NEED_KINDS = ['decision', 'review', 'errand', 'held_signal', 'long_wait'] as const
export type NeedKind = (typeof NEED_KINDS)[number]

export const NeedItem = z
  .strictObject({
    kind: z.enum(NEED_KINDS),
    /** the checkpoint's own id: the Decision, the artifact under review, the Errand, the held signal */
    id: z.string(),
    issue: IssueRef.nullable(),
    repo: z.string().nullable(),
    title: z.string(),
    summary: z.string(),
    since: at,
    ageMs: z.number().int().min(0),
    /** waiting longer than 24 hours */
    stale: z.boolean(),
    /** when the factory takes the Decision's default; null for everything that has none */
    defaultAt: at.nullable(),
    /** the Judge's reason for passing a Decision on, plain and cut; null for everything else and for a work-repo item the caller may not read */
    judge: z.string().nullable(),
    link: z.strictObject({ type: z.enum(['decision', 'artifact', 'errand', 'signal', 'issue']), id: z.string() }),
    /** the artifact under review a Decision was raised about; null for everything else */
    artifact: z.string().nullable(),
    /** where it came from, in the words of `SIGNAL_ORIGINS`: a held signal's own origin, else the Issue's; null when unknown */
    origin: z.string().nullable(),
    /** a held signal's source in a person's word (never a tool name); a request's asker (`ask-human`); null for everything else */
    source: z.string().nullable(),
    /** a request's command to copy, and where the hands must be; null for everything else and for a work-repo item the caller may not read */
    command: z.string().nullable(),
    host: z.enum(['macbook', 'iphone', 'portal', 'any']).nullable(),
    /** a held signal that is a monitor down with no route: its source in a person's word, its name and the repo the screen's note names (the one promoting it routes to); null for everything else */
    unrouted: z.strictObject({ source: z.string(), monitor: z.string(), proposal: z.string().nullable() }).nullable(),
    /** a held signal's link to the thing it is about; null for everything else and for a work-repo item the caller may not read */
    sourceLink: z.string().nullable(),
    /** an Errand whose last run failed or whose check overruled a done: "tried, failed: <first error line>" or the check's note; null for everything else and for a work-repo item the caller may not read */
    tried: z.string().nullable(),
    /** an Errand's need: `secret`, `hands`, `approval` (Approve button; its command runs on the mini) or `place` (his MacBook, no secret); null for everything else */
    need: z.enum(['secret', 'hands', 'approval', 'place']).nullable(),
    /** an Errand other Issues wait on too (their command, check, need key or ask was the same): how many besides the one that raised it; 0 for everything else */
    joined: z.number().int().min(0),
    /** the Issues that joined it, oldest first (`issue_<n>`); empty for everything else */
    joinedIssues: z.array(z.string()),
    /** a long wait: why the Issue waits, when it ends and how many open Issues wait behind it; null for everything else */
    wait: z.strictObject({ reason: z.literal('timer'), until: at, held: z.number().int().min(1) }).nullable(),
    /** the seat of the item's Issue's lead (`LeadSeat`); null for an item with no Issue or none known */
    seat: LeadSeat.nullable(),
    /** the title and summary were replaced: the item is work-repo text and the caller may not read it */
    redacted: z.boolean(),
  })
  .meta({ id: 'NeedItem' })
export type NeedItem = z.infer<typeof NeedItem>

export const NeedsModel = z
  .strictObject({
    at,
    /** newest first within a kind; kinds in the order of `counts` */
    items: z.array(NeedItem),
    counts: z.strictObject({
      decision: z.number().int(),
      review: z.number().int(),
      errand: z.number().int(),
      held_signal: z.number().int(),
      long_wait: z.number().int(),
    }),
  })
  .meta({ id: 'NeedsModel' })
export type NeedsModel = z.infer<typeof NeedsModel>

// -- flow ----------------------------------------------------------------------------------------------------------------

export const FLOW_STATES = ['settling', 'queued', 'working', 'waiting', 'watching'] as const
export type FlowState = (typeof FLOW_STATES)[number]

export const FLOW_KINDS = ['feature', 'bug', 'incident', 'chore', 'docs'] as const

export const FlowIssue = z
  .strictObject({
    id: IssueRef,
    repo: z.string(),
    title: z.string(),
    /** where it came from: a shape, so a work repo's Issue shows it too */
    origin: z.enum(SIGNAL_ORIGINS),
    /** the settled kind, else the filed one: a shape, so a work repo's Issue shows it too */
    kind: z.enum(FLOW_KINDS),
    /** when it entered the state it is in */
    since: at,
    /** the wait of a `waiting` Issue */
    waitReason: z.string().nullable(),
    /** why a queued Issue stays queued; null: nothing keeps it out, or it is not queued */
    queue: QueueReason.nullable(),
    /** the seat of its lead (`LeadSeat`); null when none is known */
    seat: LeadSeat.nullable(),
  })
  .meta({ id: 'FlowIssue' })
export type FlowIssue = z.infer<typeof FlowIssue>

export const FlowColumn = z
  .strictObject({ count: z.number().int(), issues: z.array(FlowIssue) })
  .meta({ id: 'FlowColumn' })
export type FlowColumn = z.infer<typeof FlowColumn>

export const FlowClosed = z
  .strictObject({
    id: IssueRef,
    repo: z.string(),
    title: z.string(),
    origin: z.enum(SIGNAL_ORIGINS),
    kind: z.enum(FLOW_KINDS),
    outcome: z.enum(['done', 'dropped', 'healed', 'cancelled']),
    closedAt: at,
    /** the seat its last lead ran on; null when it never had one */
    seat: LeadSeat.nullable(),
  })
  .meta({ id: 'FlowClosed' })

export const FlowProject = z
  .strictObject({
    repo: z.string(),
    /** every open Issue of the repo */
    open: z.number().int(),
    /** the five words (`workOf`): they add up to `open` */
    work: WorkCounts,
  })
  .meta({ id: 'FlowProject' })

const flowStateCounts = z.array(z.number().int()).length(8)

export const FlowTrend = z
  .strictObject({
    /** 8 samples, oldest first, 24 h apart, the last one is `at` of the model */
    at: z.array(at).length(8),
    /** per state, how many Issues were in it at each sample */
    states: z.strictObject({
      settling: flowStateCounts,
      queued: flowStateCounts,
      working: flowStateCounts,
      waiting: flowStateCounts,
      watching: flowStateCounts,
    }),
    /** Issues closed done or healed in each daily window (at[i], at[i+1]], oldest first */
    shipped: z.array(z.number().int()).length(7),
    /** the same count over the 7 days before at[0] */
    shippedBefore: z.number().int(),
    /** Issues closed done or healed in each hour window (at - (168 - i) h, at - (167 - i) h], oldest first: the last 7 days by the hour */
    shippedHourly: z.array(z.number().int()).length(168),
    /** the same per day window (at - (30 - i) d, at - (29 - i) d], oldest first: the last 30 days by the day */
    shippedDaily30: z.array(z.number().int()).length(30),
  })
  .meta({ id: 'FlowTrend' })

export const FlowModel = z
  .strictObject({
    at,
    states: z.strictObject({
      settling: FlowColumn,
      queued: FlowColumn,
      working: FlowColumn,
      waiting: FlowColumn,
      watching: FlowColumn,
    }),
    /** closed in the last 24 hours, newest first */
    closedRecently: z.array(FlowClosed),
    perProject: z.array(FlowProject),
    /** every open Issue by the five words (`workOf`): the strip's and the Herdr bar's figures */
    work: WorkCounts,
    queueStates: QueueStatesView,
    /** the last 7 days in daily samples; counts only */
    trend: FlowTrend,
  })
  .meta({ id: 'FlowModel' })
export type FlowModel = z.infer<typeof FlowModel>

/** The windows and buckets of the flow trend: 24 hours by the hour, 7 days by the hour, 30 days by the day. */
export const FLOW_TREND_RANGES = [
  { window: '24h', bucket: 'hour' },
  { window: '7d', bucket: 'hour' },
  { window: '30d', bucket: 'day' },
] as const
export const FLOW_TREND_WINDOWS = ['24h', '7d', '30d'] as const
export const FLOW_TREND_BUCKETS = ['hour', 'day'] as const
/** The default window of the trend: 7 days. */
export const FLOW_TREND_DEFAULT_WINDOW = '7d' as const

/** The one bucket a window is plotted by: 30 days by the day, anything shorter by the hour. */
export const flowTrendBucketOf = (window: (typeof FLOW_TREND_WINDOWS)[number]): (typeof FLOW_TREND_BUCKETS)[number] =>
  window === '30d' ? 'day' : 'hour'

/** What one count did inside one bucket: the most Issues at any instant, and the time-weighted mean. */
export const FlowTrendPoint = z
  .strictObject({ peak: z.number().int().min(0), avg: z.number().min(0) })
  .meta({ id: 'FlowTrendPoint' })

/**
 * The three counts per bucket, computed from the applied events (never from samples): the peak is the most Issues in
 * the count at any instant of the bucket, the average its mean over the time the bucket covers. Buckets sit on UTC
 * hours or days, oldest first; the last one ends at `at` and may be partial.
 */
export const FlowTrendSeries = z
  .strictObject({
    at,
    window: z.enum(FLOW_TREND_WINDOWS),
    bucket: z.enum(FLOW_TREND_BUCKETS),
    buckets: z.array(
      z.strictObject({
        /** the start of the bucket */
        at,
        running: FlowTrendPoint,
        paused: FlowTrendPoint,
        notStarted: FlowTrendPoint,
        checking: FlowTrendPoint,
      }),
    ),
  })
  .meta({ id: 'FlowTrendSeries' })
export type FlowTrendSeries = z.infer<typeof FlowTrendSeries>

/** `?window=24h|7d|30d&bucket=hour|day`: both optional (default 7 days by the hour); a bucket other than the window's own (30 days by the hour, 7 days by the day) is refused. */
export const FlowTrendQuery = z
  .object({ window: z.enum(FLOW_TREND_WINDOWS).optional(), bucket: z.enum(FLOW_TREND_BUCKETS).optional() })
  .refine(
    (query) =>
      FLOW_TREND_RANGES.some(
        (range) =>
          range.window === (query.window ?? FLOW_TREND_DEFAULT_WINDOW) &&
          range.bucket === (query.bucket ?? flowTrendBucketOf(query.window ?? FLOW_TREND_DEFAULT_WINDOW)),
      ),
    'window and bucket: 24h by hour, 7d by hour, 30d by day',
  )
export type FlowTrendQuery = z.infer<typeof FlowTrendQuery>

// -- chain ---------------------------------------------------------------------------------------------------------------

export const ChainNode = z
  .strictObject({
    /** an Issue's id, or `row:<project>:<key>` for a plan row not yet filed */
    id: z.string(),
    kind: z.enum(['issue', 'row']),
    repo: z.string().nullable(),
    title: z.string(),
    /** an Issue's state, or a row's: `filable` or `waiting` (stored names; a screen shows `work`) */
    state: z.string(),
    /** the word it stands under (`workOf`): an open Issue's five, a row's `planned` with its split `due` (to file now), `issue` (after another Issue) or `date` (not before a time); null for a closed Issue */
    work: z.strictObject({ word: z.enum([...WORK_WORDS, 'planned']), split: z.string().nullable() }).nullable(),
    /** an Issue's settled kind, else its filed one (`chore` when unknown); a row's `kind` (default `feature`) */
    issueKind: z.enum(FLOW_KINDS),
    /** when the Issue entered the state it is in; null for a row */
    since: z.string().nullable(),
    /** the wait of a `waiting` Issue; null for a row */
    waitReason: z.string().nullable(),
    /** a row's `not_before` as a full ISO instant, past or future; null for an Issue and for a row without one */
    notBefore: z.string().nullable(),
    /** the seat of an Issue's lead (`LeadSeat`); null for a row and for an Issue with none known */
    seat: LeadSeat.nullable(),
  })
  .meta({ id: 'ChainNode' })
export type ChainNode = z.infer<typeof ChainNode>

export const ChainEdge = z
  .strictObject({
    /** the node that runs after `to`... */
    from: z.string(),
    /** ...this one, its blocker */
    to: z.string(),
    /** the blocker has closed */
    closed: z.boolean(),
  })
  .meta({ id: 'ChainEdge' })
export type ChainEdge = z.infer<typeof ChainEdge>

export const ChainModel = z
  .strictObject({
    at,
    nodes: z.array(ChainNode),
    edges: z.array(ChainEdge),
    /** per queued node, the nodes that block it right now */
    blocking: z.record(z.string(), z.array(z.string())),
  })
  .meta({ id: 'ChainModel' })
export type ChainModel = z.infer<typeof ChainModel>

// -- kpis ----------------------------------------------------------------------------------------------------------------

export const KPI_KEYS = [
  'avoidable_touches',
  'asks',
  'recommendation_taken',
  'specs_not_needed',
  'verdict_changes_share',
  'specs_per_100',
  'owner_decisions_per_100',
  'errands_reached_per_100',
  'errands_no_secret_no_hands',
  'first_verification_passes',
  'refusals',
  'cycle_p50',
  'queue_wait_p90',
  'issues_closed_per_day',
  'test_slot_wait_p50',
  'minutes_over_ceiling',
  'fix_commits',
  'window_points',
  'cost',
  'queue_capacity_share',
  'idle_capacity',
  'working_share',
  'dropped_after_lead',
  'nudges_acted',
  'errands_turned_away',
  'first_watch_dwell_p50',
] as const
export type KpiKey = (typeof KPI_KEYS)[number]

export const KpiTarget = z
  .strictObject({
    kind: z.enum(['at_most', 'at_least', 'between', 'trend', 'unset']),
    min: z.number().nullable(),
    max: z.number().nullable(),
  })
  .meta({ id: 'KpiTarget' })
export type KpiTargetValue = z.infer<typeof KpiTarget>

/** The side of a KPI that is good: `watch` when no side is known and the figure is read as a trend. */
export const KPI_DIRECTIONS = ['lower', 'higher', 'watch'] as const
export type KpiDirection = (typeof KPI_DIRECTIONS)[number]

/** How many consecutive windows of `days` days a Kpi's `history` holds, the current one last. */
export const HISTORY_WINDOWS = 6

export const KpiPoint = z
  .strictObject({
    /** null when nothing was counted (`n` is 0) or the number is not measured in that window */
    value: z.number().nullable(),
    n: z.number().int(),
  })
  .meta({ id: 'KpiPoint' })

const KPI_UNITS = ['per_issue', 'per_100_issues', 'per_day', 'share', 'ms', 'usd', 'points', 'count'] as const

/** One slice of a KPI that is a breakdown (queued time by reason, time by state): same unit as the KPI, never a target. */
export const KpiPart = z
  .strictObject({
    key: z.string(),
    label: z.string(),
    value: z.number(),
    unit: z.enum(KPI_UNITS),
  })
  .meta({ id: 'KpiPart' })
export type KpiPart = z.infer<typeof KpiPart>

export const Kpi = z
  .strictObject({
    key: z.enum(KPI_KEYS),
    label: z.string(),
    /** null when nothing was counted (`n` is 0) or the number is not measured */
    value: z.number().nullable(),
    unit: z.enum(KPI_UNITS),
    /** what the value was divided by: Issues, answered Decisions, passed watches, measured Issues */
    n: z.number().int(),
    /** the numerator: the events counted (a duration's samples are `n`) */
    count: z.number().int().nullable(),
    target: KpiTarget,
    /** the side that is good; the target's kind follows it (`at_most` for lower, `at_least` for higher, a trend for watch) */
    direction: z.enum(KPI_DIRECTIONS),
    /** where the target came from, or why the KPI is watch only */
    targetSource: z.string(),
    /** what is counted, in a short phrase */
    numerator: z.string(),
    /** what it is divided by */
    denominator: z.string(),
    /** what a person or a loop does differently when the figure moves */
    decision: z.string(),
    /** false: there is no figure (it is not a zero): the factory has no data for it, or too few samples stand under it; `reason` says which */
    measured: z.boolean(),
    /** why `measured` is false, in words; null when it is true */
    reason: z.string().nullable(),
    /** exactly what was counted */
    definition: z.string(),
    /** the breakdown of the current window, when the figure is one (empty otherwise); history keeps the headline only */
    parts: z.array(KpiPart),
    /** `HISTORY_WINDOWS` points, oldest first, one per window of `KpiModel.windows`; the last is `value` and `n` */
    history: z.array(KpiPoint).length(HISTORY_WINDOWS),
  })
  .meta({ id: 'Kpi' })
export type Kpi = z.infer<typeof Kpi>

/** The seats a lead starts on, as the seat table groups them: the light row, the lead row, a seat the filer named. */
export const KPI_SEATS = ['light', 'lead', 'filed'] as const

/**
 * The Issues whose first lead started in the window, grouped by the seat that first lead ran on: an Issue counts for the
 * seat the rule started it on, so a light Issue moved up stays light's and its move shows in `movedUp`.
 */
export const SeatKpiRow = z
  .strictObject({
    seat: z.enum(KPI_SEATS),
    issues: z.number().int(),
    /** of every Issue whose first lead started in the window; null when none did */
    share: z.number().nullable(),
    /** the light Issues moved up to the lead row; 0 on the other seats */
    movedUp: z.number().int(),
    /**
     * first watches that ended passed or regressed, and the share that passed (null with none); on light, only the first
     * watches of ships by the light lead: a move-up shipped nothing on the seat and is its own figure (`SeatDelivery`)
     */
    firstWatches: z.number().int(),
    firstPassRate: z.number().nullable(),
    /** watches that ended regressed */
    regressions: z.number().int(),
    /** ships the gate or the machine refused */
    refusals: z.number().int(),
    /** median filed to closed of the ones closed, in ms; null with none closed */
    cycleP50Ms: z.number().nullable(),
    /** median time an Issue was in the working state, in ms */
    workingP50Ms: z.number().nullable(),
    /** dollars per Issue from the usage schema; null while it is not there */
    costPerIssue: z.number().nullable(),
  })
  .meta({ id: 'SeatKpiRow' })
export type SeatKpiRow = z.infer<typeof SeatKpiRow>

/**
 * The attempts that started in the window, grouped by the tier and effort each ran on (`lead_attempts.tier`, `effort`).
 * Unlike `SeatKpiRow`, which follows an Issue's first lead, this follows every attempt: a retry on a stronger seat counts
 * for that seat, and a first watch counts for the seat of the attempt that shipped it.
 */
export const AttemptSeatRow = z
  .strictObject({
    tier: z.enum(TIERS),
    effort: z.enum(EFFORTS),
    /** attempts that started on the seat in the window */
    attempts: z.number().int(),
    /** the Issues behind those attempts, each once */
    issues: z.number().int(),
    /** first watches (watch 1) of those attempts' ships that ended passed or regressed, and the share that passed (null with none) */
    firstWatches: z.number().int(),
    firstPassRate: z.number().nullable(),
    /** dollars the usage schema priced for the Claude sessions the attempts' hooks reported; null while it cannot be read */
    cost: z.number().nullable(),
    /** `cost` per Issue of `issues`; null while `cost` is */
    costPerIssue: z.number().nullable(),
  })
  .meta({ id: 'AttemptSeatRow' })
export type AttemptSeatRow = z.infer<typeof AttemptSeatRow>

/**
 * What one seat delivers, over a window, in the four figures the owner pays for (`definitions` says each in a line). `light`
 * follows the Issues the light rule seated, `lead` the Issues that started on the lead row; the fields that only a move-up
 * has are 0 or null on the lead row.
 */
export const SeatDelivery = z
  .strictObject({
    issues: z.number().int(),
    /** (a) first watches of ships by attempts that finished on the seat, ended passed or regressed */
    finishedWatches: z.number().int(),
    /** (a) the share of them that passed; null with none */
    finishedPassRate: z.number().nullable(),
    /** (b) the Issues moved up to the lead row, and their share of `issues` (null with none) */
    movedUp: z.number().int(),
    movedUpShare: z.number().nullable(),
    /** (b) dollars the light attempts of moved-up Issues cost, and the mean ms they ran before moving up; null while unmeasured */
    movedUpCost: z.number().nullable(),
    movedUpMs: z.number().nullable(),
    /** (c) watches that ended regressed, and per Issue (null with none) */
    regressions: z.number().int(),
    regressionsPerIssue: z.number().nullable(),
    /** (d) dollars of every session of the seat's Issues, moved-up attempts included, and per Issue; null while unmeasured */
    cost: z.number().nullable(),
    costPerIssue: z.number().nullable(),
  })
  .meta({ id: 'SeatDelivery' })
export type SeatDelivery = z.infer<typeof SeatDelivery>

/**
 * The share of moved-up Issues at which starting light costs as much as starting on the lead row. A light route costs
 * `lightAttempt + share * followUpAttempt` per Issue (every Issue runs a light attempt, the moved-up share then runs a
 * lead attempt), the lead route `leadAttempt`; they meet at `share = (leadAttempt - lightAttempt) / followUpAttempt`.
 */
export const MoveUpBound = z
  .strictObject({
    /** dollars per attempt: light attempts, lead-row attempts of Issues that started there, lead attempts that followed a move-up (the lead row's when fewer than three) */
    lightAttempt: z.number(),
    leadAttempt: z.number(),
    followUpAttempt: z.number(),
    share: z.number(),
  })
  .meta({ id: 'MoveUpBound' })
export type MoveUpBound = z.infer<typeof MoveUpBound>

/** The one-line definitions of the four figures, as the Improve screen and `factory read kpis` carry them. */
export const SEAT_DELIVERY_DEFINITIONS = {
  finishedPass:
    'First pass of what finished: the share of first verifications that passed, over the attempts that shipped on the seat; an attempt that moved up shipped nothing and is not in it',
  movedUp:
    'Move-up share: the share of the seat’s Issues a light lead handed to the lead row, with the dollars and minutes the light attempt spent before it moved',
  regressions:
    'Regressions per Issue: watches that ended regressed, over the Issues whose first lead started on the seat',
  cost: 'Cost per Issue: dollars of every session of those Issues, the light attempts of moved-up ones included',
} as const

export const SeatKpis = z
  .strictObject({
    rows: z.array(SeatKpiRow),
    /** the same window by the seat each attempt started on, the most attempts first */
    attemptSeats: z.array(AttemptSeatRow),
    /** the light Issues moved up, of the light Issues; null with none light */
    movedUpShare: z.number().nullable(),
    /** the window's four figures for the light seat beside the lead row's, each defined in one line */
    delivery: z.strictObject({
      light: SeatDelivery,
      lead: SeatDelivery,
      definitions: z.strictObject({
        finishedPass: z.string(),
        movedUp: z.string(),
        regressions: z.string(),
        cost: z.string(),
      }),
    }),
    /**
     * Whether triage's `small` starts on the light seat now: the same four figures over the window of `days` days from
     * `from` (`TRIPWIRE_DAYS` days, reaching back until light has `targetWatches` finished first watches, at most `TRIPWIRE_MAX_DAYS`), whatever window
     * the page shows. `met` unless light is shown worse: the lower bound (at `confidence`, one-sided) of lead's pass rate
     * over light's is within `points`, and its move-up share is under `bound` (null while any figure is unmeasured, or
     * light has fewer than `minWatches` finished first watches); `failing` names each condition that is not met or not
     * measured. `passGap` and `regressionGap` are the gaps with their lower bounds, `passGap` in points and
     * `regressionGap` in regressions per Issue (light over lead; shown, not a condition).
     */
    tripwire: z.strictObject({
      points: z.number(),
      days: z.number().int(),
      from: z.string(),
      confidence: z.number(),
      targetWatches: z.number().int(),
      minWatches: z.number().int(),
      passGap: z.strictObject({ points: z.number(), lower: z.number() }).nullable(),
      regressionGap: z.strictObject({ perIssue: z.number(), lower: z.number() }).nullable(),
      light: SeatDelivery,
      lead: SeatDelivery,
      bound: MoveUpBound.nullable(),
      met: z.boolean().nullable(),
      failing: z.array(z.string()),
    }),
  })
  .meta({ id: 'SeatKpis' })
export type SeatKpis = z.infer<typeof SeatKpis>

/** The two reviewer seats, as the reviewer table groups them: the cheap row (`reviewer-cheap`) and the other, `reviewer`. */
export const REVIEWER_SEATS = ['plain', 'cheap'] as const

/**
 * One reviewer seat over the reviews recorded in the window (a review is an agw thread that covered a ship, recorded with
 * the seat it ran on, Issue 2027). Reviews are the non-deep ones; a deep review stays on `reviewer` and counts in
 * `deepReviews`. The Issue measures follow the Issues assigned the seat that had at least one non-deep review.
 */
export const ReviewerKpiRow = z
  .strictObject({
    seat: z.enum(REVIEWER_SEATS),
    /** the row of the role table and the tier and effort it names now */
    role: z.string(),
    tier: z.enum(TIERS).nullable(),
    effort: z.enum(EFFORTS).nullable(),
    reviews: z.number().int(),
    deepReviews: z.number().int(),
    findings: z.number().int(),
    /** findings per review; null with no review */
    findingsPerReview: z.number().nullable(),
    /** findings the lead fixed, and the ones it declined (wrong, intentional or irrelevant); the rest were open at the ship */
    applied: z.number().int(),
    declined: z.number().int(),
    /** applied of applied and declined; null with neither */
    appliedShare: z.number().nullable(),
    /** rounds of a review until clean, on average; null with no review */
    roundsPerReview: z.number().nullable(),
    /** Issues behind the reviews, their first watches that ended passed or regressed, and the share that passed */
    issues: z.number().int(),
    firstWatches: z.number().int(),
    firstPassRate: z.number().nullable(),
    /** Issues with a watch that ended regressed, and their share of `firstWatches`'s Issues; null with none */
    regressedIssues: z.number().int(),
    regressionRate: z.number().nullable(),
    /** reviewer-agent dollars the usage schema priced for these Issues' sessions (the cheap seat's by the haiku tier, the rest the other's), per review of the seat, deep ones included; null while it cannot be read */
    costPerReview: z.number().nullable(),
    /** median wall time of the covering round, in ms; null with none */
    wallP50Ms: z.number().nullable(),
  })
  .meta({ id: 'ReviewerKpiRow' })
export type ReviewerKpiRow = z.infer<typeof ReviewerKpiRow>

/** What the tripwire reads of one seat: the inputs, over the whole record, whatever window the page shows. */
const ReviewerEvidence = z.strictObject({
  reviews: z.number().int(),
  issues: z.number().int(),
  firstPassRate: z.number().nullable(),
  regressionRate: z.number().nullable(),
})

export const ReviewerKpis = z
  .strictObject({
    rows: z.array(ReviewerKpiRow),
    /** the share of the Issues that are not light that start on the cheap row */
    startShare: z.number(),
    /**
     * The cheap row takes every non-deep review when each seat has `minReviews` reviews and the cheap row's Issues regress
     * no more often and pass their first verification within `points` of the other seat's (`cheap` and `plain` are those
     * numbers); it goes back to its starting share while the cheap row's last `windowDays` days (`window`, judged with at
     * least `windowMinIssues` Issues) break either test against the other seat's record. `takesAll` is the verdict now.
     */
    tripwire: z.strictObject({
      minReviews: z.number().int(),
      points: z.number(),
      windowDays: z.number().int(),
      windowMinIssues: z.number().int(),
      cheap: ReviewerEvidence,
      plain: ReviewerEvidence,
      window: ReviewerEvidence,
      enough: z.boolean(),
      passOk: z.boolean().nullable(),
      regressOk: z.boolean().nullable(),
      windowBreaks: z.boolean().nullable(),
      takesAll: z.boolean(),
    }),
  })
  .meta({ id: 'ReviewerKpis' })
export type ReviewerKpis = z.infer<typeof ReviewerKpis>

/**
 * The `after` edges the factory inferred (`planning_edges.inferred_by` set) that were created in the window, by whether
 * they were needed. An edge is settled once its blocker closed. A settled edge with no `ready_since` was needed: no look
 * saw its Issue ready behind it. One with `ready_since` was not: the Issue sat ready, idle capacity, until the edge was
 * satisfied. Readiness is judged per Issue, so the idle hours of Issues held in one repo can overlap.
 */
export const InferredEdgeKpis = z
  .strictObject({
    /** inferred edges created in the window */
    total: z.number().int(),
    /** of those, not yet satisfied: their value is not final */
    open: z.number().int(),
    /** satisfied with no look that saw the Issue ready */
    needed: z.number().int(),
    /** satisfied with the Issue ready from `ready_since` */
    notNeeded: z.number().int(),
    /** `needed` of the settled edges; null with none settled */
    neededShare: z.number().nullable(),
    /** hours the not needed edges held a ready Issue, from `ready_since` to `satisfied_at`, summed */
    idleHours: z.number(),
  })
  .meta({ id: 'InferredEdgeKpis' })
export type InferredEdgeKpis = z.infer<typeof InferredEdgeKpis>

export const KpiModel = z
  .strictObject({
    at,
    days: z.number().int(),
    window: z.strictObject({ from: at, to: at }),
    /** the consecutive windows behind every `history`, oldest first; the last is `window` */
    windows: z.array(z.strictObject({ from: at, to: at })).length(HISTORY_WINDOWS),
    kpis: z.array(Kpi),
    /** the current window's Issues by the seat their first lead ran on */
    seats: SeatKpis,
    /** the reviewer seats side by side, and the tripwire that hands the cheap one every review */
    reviewers: ReviewerKpis,
    /** the inferred chain edges created in the window, needed or not */
    edges: InferredEdgeKpis,
  })
  .meta({ id: 'KpiModel' })
export type KpiModel = z.infer<typeof KpiModel>

/** `?days=7`: a whole number of days, 1 to 90 (a query is text, so the number is read by the route). */
export const DaysQuery = z.object({
  days: z
    .string()
    .regex(/^[0-9]{1,2}$/, 'a whole number of days, 1 to 90')
    .refine((text) => Number(text) >= 1 && Number(text) <= 90, 'a whole number of days, 1 to 90')
    .optional(),
})
export type DaysQuery = z.infer<typeof DaysQuery>
export const DEFAULT_DAYS = 7

// -- wait census ---------------------------------------------------------------------------------------------------------

export const WAIT_ENDERS = ['owner', 'judge', 'steward', 'factory', 'open'] as const

export const WaitCensusReason = z
  .strictObject({
    /** a `WAITS` key of the work domain */
    reason: z.string(),
    /** the wait's exit is a person */
    person: z.boolean(),
    count: z.number().int(),
    /** of `count`, the waits still going (their duration runs to `at`) */
    open: z.number().int(),
    totalSeconds: z.number(),
    p50Seconds: z.number().nullable(),
    p90Seconds: z.number().nullable(),
    /** the waits by length: under 30 minutes, under 2 hours, under 24 hours, 24 hours or more */
    buckets: z.strictObject({
      lt30m: z.number().int(),
      lt2h: z.number().int(),
      lt24h: z.number().int(),
      gte24h: z.number().int(),
    }),
    /** who ended them: the actor of the event that left the wait */
    endedBy: z.strictObject({
      owner: z.number().int(),
      judge: z.number().int(),
      steward: z.number().int(),
      factory: z.number().int(),
      open: z.number().int(),
    }),
    /** the waits no person's hands were needed to end (a person wait the Judge, a default or a check ended): a lead could have gone on at once */
    avoidableCount: z.number().int(),
    avoidableSeconds: z.number(),
  })
  .meta({ id: 'WaitCensusReason' })

export const WaitCensusLong = z
  .strictObject({
    issue: IssueRef,
    reason: z.string(),
    seconds: z.number(),
    open: z.boolean(),
    endedBy: z.enum(WAIT_ENDERS),
    avoidable: z.boolean(),
  })
  .meta({ id: 'WaitCensusLong' })

/**
 * The waits that began over the last `days` days, counted by reason and length (`GET /v1/waits`, `factory read waits`),
 * and which of them nobody's hands were needed to end. Computed from `issue_events`: a wait is the span from the applied
 * event that began it to the next applied event that left it. Ids, reasons and numbers only.
 */
export const WaitCensusModel = z
  .strictObject({
    at,
    days: z.number().int(),
    window: z.strictObject({ from: at, to: at }),
    waits: z.number().int(),
    totalSeconds: z.number(),
    avoidableSeconds: z.number(),
    /** `avoidableSeconds` over `totalSeconds`; null with no wait */
    avoidableShare: z.number().nullable(),
    /** every reason, the one that cost most time first */
    byReason: z.array(WaitCensusReason),
    /** the 10 longest waits */
    longest: z.array(WaitCensusLong),
  })
  .meta({ id: 'WaitCensusModel' })
export type WaitCensusModel = z.infer<typeof WaitCensusModel>

/** `?hours=24`: a whole number of hours, 1 to 336 (14 days, as long as the minute rows are kept). */
export const HoursQuery = z.object({
  hours: z
    .string()
    .regex(/^[0-9]{1,3}$/, 'a whole number of hours, 1 to 336')
    .refine((text) => Number(text) >= 1 && Number(text) <= 336, 'a whole number of hours, 1 to 336')
    .optional(),
})
export type HoursQuery = z.infer<typeof HoursQuery>
export const DEFAULT_HOURS = 24

// -- friction ------------------------------------------------------------------------------------------------------------

export const FrictionCount = z
  .strictObject({
    /** a stable name for the count, grouped by `group` */
    key: z.string(),
    group: z.enum([
      'avoidable_touch',
      'orchestrator_steer',
      'refusal',
      'stall',
      'lead_gone',
      'undelivered_note',
      'unreviewed_ship',
      'unstated_acceptance',
      'unproven_ci',
      'regression',
      'decision_settled',
      'signal',
      'api_transient',
      'spec_unneeded',
    ]),
    label: z.string(),
    count: z.number().int(),
    /** per Issue closed in the window; null when none closed */
    perIssue: z.number().nullable(),
    /** the same count over the window of the same length just before; null when that window is not comparable (it reaches back before the counting began), the row is keyed by its own time, or the comparison was not asked for */
    previous: z.number().int().nullable(),
  })
  .meta({ id: 'FrictionCount' })
export type FrictionCount = z.infer<typeof FrictionCount>

export const FrictionModel = z
  .strictObject({
    at,
    days: z.number().int(),
    /** `from` is the later of `days` ago and `since`: nothing older is counted */
    window: z.strictObject({ from: at, to: at }),
    /** the import marker: the old core's history ends here and only the new core's own events count; null when nothing was imported */
    since: at.nullable(),
    /** Issues filed in the window */
    issues: z.number().int(),
    /** Issues closed in the window: what `perIssue` divides by, and the sample a rate stands on */
    closed: z.number().int(),
    counts: z.array(FrictionCount),
  })
  .meta({ id: 'FrictionModel' })
export type FrictionModel = z.infer<typeof FrictionModel>

// -- retro ---------------------------------------------------------------------------------------------------------------

/** A lead session of the window: where its transcript is, for the transcript pass (`factory retro`). */
export const RetroSession = z
  .strictObject({
    issue: z.string(),
    attempt: z.number().int(),
    model: z.string().nullable(),
    account: z.string().nullable(),
    /** null when the lead's hook did not report one, and for the read token */
    transcriptPath: z.string().nullable(),
  })
  .meta({ id: 'RetroSession' })
export type RetroSession = z.infer<typeof RetroSession>

/** One Issue of a sample a reader goes through: why it is in the sample, in the factory's own words. */
export const RetroSample = z
  .strictObject({
    issue: z.string(),
    why: z.string(),
    /** the duration that put it in (cycle for the slowest), when it is one */
    ms: z.number().nullable(),
  })
  .meta({ id: 'RetroSample' })
export type RetroSample = z.infer<typeof RetroSample>

/**
 * An earlier retro signal against the number it was filed to move: its marker line (`Retro: <date> kpi=<key>
 * before=<value> direction=<up|down>`), the Issue it became and when that shipped, and the KPI now.
 */
export const RetroLedgerEntry = z
  .strictObject({
    signal: z.string(),
    title: z.string(),
    filedAt: at,
    issue: z.string().nullable(),
    /** the Issue's state, or null while the signal has none */
    state: z.string().nullable(),
    outcome: z.string().nullable(),
    shippedAt: at.nullable(),
    kpi: z.string(),
    before: z.number().nullable(),
    direction: z.enum(['up', 'down']),
    /** the KPI over this retro's window; null when the KPI is not measured or has no data */
    now: z.number().nullable(),
    /**
     * `not_shipped`: no ship yet. `partial`: the window began before the ship, so it mixes both. `after`: the whole window
     * is after the ship. `unknown`: no number to compare.
     */
    measured: z.enum(['not_shipped', 'partial', 'after', 'unknown']),
    /** better or worse than `before` by more than 5 % in the signal's direction; flat inside; null unless `after` or `partial` */
    moved: z.enum(['better', 'worse', 'flat']).nullable(),
  })
  .meta({ id: 'RetroLedgerEntry' })
export type RetroLedgerEntry = z.infer<typeof RetroLedgerEntry>

/**
 * What the owner said about an artifact in the window, in his words: the notes of his verdicts and his annotations, each with
 * the artifact, repo and Issue it was about, so a recurring preference can be written down where the next lead reads it.
 * Words are dropped for the read token (a work repository's words never leave it).
 */
export const RetroTaste = z
  .strictObject({
    verdicts: z.array(
      z.strictObject({
        artifact: z.string(),
        kind: z.enum(['concept', 'spec', 'report']),
        title: z.string(),
        repo: z.string(),
        issue: z.string(),
        verdict: z.enum(['looks_good', 'with_notes', 'changes']),
        note: z.string().nullable(),
        at,
      }),
    ),
    annotations: z.array(
      z.strictObject({
        artifact: z.string(),
        kind: z.enum(['concept', 'spec', 'report']),
        title: z.string(),
        repo: z.string(),
        issue: z.string(),
        revision: z.number().int(),
        quote: z.string(),
        comment: z.string(),
        /** how the lead handled it; null until it answered */
        disposition: z.enum(['applied', 'deferred', 'declined']).nullable(),
        dispositionNote: z.string().nullable(),
        at,
      }),
    ),
  })
  .meta({ id: 'RetroTaste' })
export type RetroTaste = z.infer<typeof RetroTaste>

// -- finding classes -----------------------------------------------------------------------------------------------------

export const FindingClass = z
  .strictObject({
    loop: z.enum(['friction', 'hygiene']),
    class: z.string(),
    status: z.enum(['open', 'probation', 'held']),
    /** every Issue the class filed */
    issues: z.number().int(),
    /** decided Issues in the judged window */
    decided: z.number().int(),
    /** of those, dropped or cancelled */
    noise: z.number().int(),
    /** noise / decided; null with nothing decided */
    share: z.number().nullable(),
    /** Issues of the class not closed yet */
    open: z.number().int(),
    /** when a held class is asked again; null unless the window is over the share */
    heldUntil: at.nullable(),
    /** where the class's Issues start (`judgeClassSeat`); null for a friction class, whose Issues start by triage's size */
    seat: z
      .strictObject({
        /** Issues of the class whose first lead started on the light seat, all time */
        starts: z.number().int(),
        /** of those, moved up to the lead row */
        movedUp: z.number().int(),
        /** first watches of ships by light attempts of the class, and the share that passed; null with none */
        finishedWatches: z.number().int(),
        finishedPassRate: z.number().nullable(),
        /** over the class's last 20 Issues: light starts, the move-ups among them, and their share (null under 3 starts) */
        windowStarts: z.number().int(),
        windowMovedUp: z.number().int(),
        windowShare: z.number().nullable(),
        /** true: the class's next Issue starts on the standard lead */
        out: z.boolean(),
        /** why it is out; null while it is on the light seat */
        why: z.string().nullable(),
      })
      .nullable(),
  })
  .meta({ id: 'FindingClass' })
export type FindingClass = z.infer<typeof FindingClass>

export const FindingClassesModel = z
  .strictObject({
    at,
    /** the move-up share a hygiene class stays under to start light (the tripwire's); null while a cost is unmeasured, and then no class is out */
    bound: z.number().nullable(),
    /** held first, then probation, then open; then by loop and class */
    classes: z.array(FindingClass),
  })
  .meta({ id: 'FindingClassesModel' })
export type FindingClassesModel = z.infer<typeof FindingClassesModel>

// -- what the loops yield ----------------------------------------------------------------------------------------------

/** The loops that file signals; the others (leads, steward, host, ...) judge or sample and file none. */
export const YIELD_LOOPS = ['friction', 'hygiene', 'selfwatch', 'throughput'] as const

export const LoopYieldClass = z
  .strictObject({
    /** the pattern group, probe, finding kind or KPI the loop filed under */
    class: z.string(),
    issues: z.number().int(),
    /** of those, dropped or cancelled */
    noise: z.number().int(),
  })
  .meta({ id: 'LoopYieldClass' })
export type LoopYieldClass = z.infer<typeof LoopYieldClass>

/** One loop over one window: what it filed and how it ended. Issues are counted by the day they were filed. */
export const LoopYieldWindow = z
  .strictObject({
    days: z.number().int(),
    /** recorded passes (a pass that filed nothing too); null for a loop that keeps no record of its passes */
    passes: z.number().int().nullable(),
    /** signals the loop filed, as its own record counts them (a repeat that amended an Issue is one) */
    signals: z.number().int(),
    /** distinct Issues those signals opened or reached */
    issues: z.number().int(),
    done: z.number().int(),
    healed: z.number().int(),
    dropped: z.number().int(),
    cancelled: z.number().int(),
    /** not closed yet */
    open: z.number().int(),
    /** median seconds from the Issue's filing to its close, over the closed ones; null with none */
    medianCloseSeconds: z.number().nullable(),
    /** the three kinds of finding with the most Issues, then by name */
    classes: z.array(LoopYieldClass),
  })
  .meta({ id: 'LoopYieldWindow' })
export type LoopYieldWindow = z.infer<typeof LoopYieldWindow>

export const LoopYield = z
  .strictObject({
    loop: z.enum(YIELD_LOOPS),
    /** the last 7 days, then the last 30 */
    windows: z.array(LoopYieldWindow),
  })
  .meta({ id: 'LoopYield' })
export type LoopYield = z.infer<typeof LoopYield>

export const LoopYieldModel = z.strictObject({ at, loops: z.array(LoopYield) }).meta({ id: 'LoopYieldModel' })
export type LoopYieldModel = z.infer<typeof LoopYieldModel>

// -- fix commits ---------------------------------------------------------------------------------------------------------

export const FixWeek = z
  .strictObject({
    from: at,
    to: at,
    total: z.number().int().min(0),
    /** every class key, 0 included */
    byClass: z.record(z.string(), z.number().int().min(0)),
  })
  .meta({ id: 'FixWeek' })
export type FixWeek = z.infer<typeof FixWeek>

export const FixCommitsModel = z
  .strictObject({
    /** at least one fix commit is stored */
    measured: z.boolean(),
    /** the classes in the order they are shown, with what each means (`docs/product.md` "Fix classes") */
    classes: z.array(z.strictObject({ key: z.string(), meaning: z.string() })),
    /** four trailing 7-day windows, the newest first: week i is [now - 7(i+1) days, now - 7i days) */
    weeks: z.array(FixWeek),
    /** repos with a stored fix commit in those four weeks */
    repos: z.number().int().min(0),
  })
  .meta({ id: 'FixCommitsModel' })
export type FixCommitsModel = z.infer<typeof FixCommitsModel>

// -- machine -------------------------------------------------------------------------------------------------------------

/** The host's reading and the ceilings admission holds it to; a reading that failed is null. */
export const MachineModel = z
  .strictObject({
    at,
    /** the 1-minute load average */
    load: z.number().nullable(),
    loadCeiling: z.number(),
    /** swapped-out data in the last 300 s (MiB) and swap in use as a share of RAM (percent) */
    memory: z.strictObject({ swapoutMbPer300s: z.number(), swapUsedPct: z.number() }).nullable(),
    memoryCeilings: z.strictObject({ swapoutMbPer300s: z.number(), swapUsedPct: z.number() }),
  })
  .meta({ id: 'MachineModel' })
export type MachineModel = z.infer<typeof MachineModel>

/** One minute-sample of the host; a figure the host could not read at that minute is null. */
export const HostSample = z
  .strictObject({
    at,
    /** the 1-minute load average */
    load: z.number().nullable(),
    /** resident memory of all processes as a share of RAM, percent */
    memoryUsedPct: z.number().nullable(),
    /** swap in use as a share of RAM, percent */
    swapUsedPct: z.number().nullable(),
    /** swapped-out data in the last 300 s, MiB */
    swapoutMbPer300s: z.number().nullable(),
    /** the process count of `top`'s header at that minute */
    processes: z.number().int().nullable(),
    /** the header's CPU split, percent of all cores: user, system and idle (they sum to about 100) */
    cpuUserPct: z.number().nullable(),
    cpuSysPct: z.number().nullable(),
    cpuIdlePct: z.number().nullable(),
  })
  .meta({ id: 'HostSample' })
export type HostSample = z.infer<typeof HostSample>

/** One process of the host's top list. */
export const HostProcess = z
  .strictObject({
    pid: z.number().int(),
    /** the executable's name, never its arguments */
    command: z.string(),
    /** share of one core, percent (above 100 on several cores) */
    cpuPct: z.number(),
    /** resident memory, MiB */
    memoryMb: z.number(),
  })
  .meta({ id: 'HostProcess' })
export type HostProcess = z.infer<typeof HostProcess>

/**
 * The host over the last 24 hours and its busiest processes, with the server's own version and start time (the Live
 * popover's facts). `samples` are oldest first, one a minute; fewer when the history is younger than 24 hours.
 */
export const HostHistoryModel = z
  .strictObject({
    at,
    version: z.string(),
    startedAt: at,
    samples: z.array(HostSample),
    topByCpu: z.array(HostProcess),
    topByMemory: z.array(HostProcess),
  })
  .meta({ id: 'HostHistoryModel' })
export type HostHistoryModel = z.infer<typeof HostHistoryModel>

// -- project digests -------------------------------------------------------------------------------------------------------

/** One digest line and the Issues it is about (each id links to its page). */
export const ProjectDigestBullet = z
  .strictObject({ text: z.string(), ids: z.array(IssueRef) })
  .meta({ id: 'ProjectDigestBullet' })

/** What a project has: counts from the event log, never from the model. */
export const ProjectDigestCounts = z
  .strictObject({
    /** closed done or healed in the last 7 days */
    done7d: z.number().int().min(0),
    /** the open Issues by the five words (`workOf`) */
    work: WorkCounts,
  })
  .meta({ id: 'ProjectDigestCounts' })

/** One project's newest digest with its live counts. The read token sees the counts of a work project and no words. */
export const ProjectDigest = z
  .strictObject({
    project: z.string(),
    /** when the digest was made */
    at,
    headline: z.string(),
    shipped: z.array(ProjectDigestBullet),
    next: z.array(ProjectDigestBullet),
    risks: z.array(ProjectDigestBullet),
    themes: z.array(z.string()),
    counts: ProjectDigestCounts,
  })
  .meta({ id: 'ProjectDigest' })
export type ProjectDigest = z.infer<typeof ProjectDigest>

export const ProjectDigestsModel = z
  .strictObject({ at, projects: z.array(ProjectDigest) })
  .meta({ id: 'ProjectDigestsModel' })
export type ProjectDigestsModel = z.infer<typeof ProjectDigestsModel>

// -- since you were here ---------------------------------------------------------------------------------------------------

export const SinceItem = z
  .strictObject({
    /** null for a dismissed signal that never became an Issue */
    issue: IssueRef.nullable(),
    title: z.string(),
    repo: z.string().nullable(),
    at,
  })
  .meta({ id: 'SinceItem' })
export type SinceItem = z.infer<typeof SinceItem>

export const SinceCategory = z
  .strictObject({
    /** every Issue (or signal) of the category since `since`, counted once */
    count: z.number().int(),
    /** the newest 8 */
    items: z.array(SinceItem),
  })
  .meta({ id: 'SinceCategory' })
export type SinceCategory = z.infer<typeof SinceCategory>

export const SinceFiled = z
  .strictObject({
    count: z.number().int(),
    byOrigin: z.array(z.strictObject({ origin: z.enum(SIGNAL_ORIGINS), count: z.number().int() })),
    items: z.array(SinceItem),
  })
  .meta({ id: 'SinceFiled' })
export type SinceFiled = z.infer<typeof SinceFiled>

/**
 * What happened since the owner was last here (`GET /v1/since`). The owner's read moves the visit marker: the first call
 * looks back 24 hours, a call within 30 minutes of the last keeps `since`, a later one starts at the last call. Every
 * other caller reads relative to the stored `since` and writes nothing.
 */
export const SinceModel = z
  .strictObject({
    at,
    /** where the band begins */
    since: at,
    categories: z.strictObject({
      /** applied `watch_passed`: shipped with verification */
      shipped: SinceCategory,
      /** applied `regressed` */
      failed: SinceCategory,
      /** closed as dropped */
      dropped: SinceCategory,
      /** Decisions the Judge settled */
      judge: SinceCategory,
      /** signals the Judge turned away and Errands screened off */
      screen: SinceCategory,
      /** requests for the owner's hands that closed without him: their check said no, they expired, a newer request replaced them, or the still-needed look found them needless */
      errands: SinceCategory,
      filed: SinceFiled,
      /** incidents opened */
      incidents: SinceCategory,
    }),
  })
  .meta({ id: 'SinceModel' })
export type SinceModel = z.infer<typeof SinceModel>

// -- capacity loop ---------------------------------------------------------------------------------------------------------

/** One UTC day's figure; null when the day has nothing to compute it from (a count is 0, never null). */
export const CapacityDay = z
  .strictObject({
    /** the UTC date, `YYYY-MM-DD` */
    day: z.string(),
    value: z.number().nullable(),
  })
  .meta({ id: 'CapacityDay' })

/** What the waits for a test slot waited for: per reason (a wait that spent time under it) the count and the ms spent under it. */
export const SlotWaitReason = z
  .strictObject({
    /** `slots` every slot taken, `memory` the fit, `swap` swap growing, `load` the load gate, `unsized` no learned size or free-memory reading, `line` the waiters ahead */
    reason: z.enum(['slots', 'memory', 'swap', 'load', 'unsized', 'line', 'cores', 'class']),
    waits: z.number().int(),
    totalMs: z.number(),
    p50Ms: z.number().nullable(),
    p90Ms: z.number().nullable(),
    maxMs: z.number().nullable(),
  })
  .meta({ id: 'SlotWaitReason' })

export const SlotWaitRepo = z
  .strictObject({
    repo: z.string(),
    waits: z.number().int(),
    totalMs: z.number(),
    p50Ms: z.number().nullable(),
    p90Ms: z.number().nullable(),
    maxMs: z.number().nullable(),
    byReason: z.array(SlotWaitReason),
  })
  .meta({ id: 'SlotWaitRepo' })

export const CapacityTotal = z
  .strictObject({ total: z.number(), perDay: z.array(CapacityDay) })
  .meta({ id: 'CapacityTotal' })

export const CapacityStep = z
  .strictObject({
    name: z.string(),
    runs: z.number().int(),
    maxPeakMib: z.number().int(),
    p80PeakMib: z.number(),
    medianDurationMs: z.number(),
    medianWaitMs: z.number(),
  })
  .meta({ id: 'CapacityStep' })

export const CapacityLeadCost = z
  .strictObject({
    repo: z.string(),
    attempts: z.number().int(),
    peakMibP80: z.number().int(),
    lastPeakMib: z.number().int(),
    /** attempts with a physical footprint recorded (`top` answered); 0 until the first one */
    footprintAttempts: z.number().int(),
    /** the same figures as the RSS ones, from the summed physical footprint of the attempts that have one; null with none */
    footprintMibP80: z.number().int().nullable(),
    lastFootprintMib: z.number().int().nullable(),
    /** median over those attempts of (footprint peak / RSS peak), two decimals: how much of summed RSS is not private memory */
    footprintToRss: z.number().nullable(),
    /**
     * what a lead of the repo holds at rest: the median physical footprint of its process tree over the minutes of the
     * class rows (`host_class_samples`) where no test step of that Issue ran; null with none. Read beside the learned peak.
     */
    restMibP50: z.number().int().nullable(),
    /** the minutes of lead rows at rest that the median is taken over */
    restMinutes: z.number().int(),
  })
  .meta({ id: 'CapacityLeadCost' })

/** The host's swapouts and pressure over the minutes of one kind of shadow decision. */
export const CapacityShadowMinutes = z
  .strictObject({
    minutes: z.number().int(),
    /** mean and largest of the minute samples' swapouts, MiB per 300 s; null with no sample joined */
    swapoutMbAvg: z.number().nullable(),
    swapoutMbMax: z.number().nullable(),
    /** the highest `kern.memorystatus_vm_pressure_level` of those minutes (1, 2 or 4); null with none read */
    pressureLevelMax: z.number().int().nullable(),
    /** the minutes at pressure level 2 or 4 */
    pressureMinutes: z.number().int(),
  })
  .meta({ id: 'CapacityShadowMinutes' })

/** The host's readings over the shadow minutes of one kind (the aim above the live rule's slots, or not). */
export const SlotAimMinutes = z
  .strictObject({
    minutes: z.number().int(),
    /** mean swapouts, MiB per 300 s, over the minutes with a reading; null with none */
    swapoutMbMean: z.number().nullable(),
    /** share of the minutes with a pressure reading that were above level 1; null with none */
    pressureAboveNormal: z.number().nullable(),
    /** minutes at pressure level 4 */
    critical: z.number().int(),
  })
  .meta({ id: 'SlotAimMinutes' })

/** One reason kind the queue waited for in the window. */
export const CapacityReason = z
  .strictObject({
    kind: z.string(),
    queuedHours: z.number(),
    issues: z.number().int(),
    idleSeatHours: z.number(),
  })
  .meta({ id: 'CapacityReason' })

export const CapacityReaped = z
  .strictObject({ comm: z.string(), session: z.string(), reason: z.enum(['session', 'worktree']), at })
  .meta({ id: 'CapacityReaped' })

/**
 * The counting epoch (`config/throughput.json`) as a read says it: the time before which no sample counts, whether it
 * cut the asked window short, and where the counted window really starts when it did (`countingSince`, else null). A
 * figure over earlier days (a median) is absent until 3 days after the epoch.
 */
export const ThroughputEpoch = z
  .strictObject({ at, cut: z.boolean(), countingSince: at.nullable() })
  .meta({ id: 'ThroughputEpoch' })
export type ThroughputEpoch = z.infer<typeof ThroughputEpoch>

/**
 * What the capacity loop did over the last `days` days (`GET /v1/capacity-loop`), computed in SQL from the host samples,
 * the test-slot step costs, the lead samples and the reaper's rows, with the settings it tunes.
 */
export const CapacityLoopModel = z
  .strictObject({
    at,
    days: z.number().int(),
    /** the counted window: `from` is the asked start, or the epoch when it cut the window */
    window: z.strictObject({ from: at, to: at }),
    /** the counting epoch; null where none is configured */
    epoch: ThroughputEpoch.nullable(),
    /** Issues that closed (any outcome, as the cycle KPI counts them) */
    throughput: CapacityTotal,
    /** seats not held by a lead while Issues were queued, in hours: minutes with queued > 0 of max(seats - leads, 0), over 60 */
    idleSeatHours: CapacityTotal,
    /**
     * of `idleSeatHours`, the hours in minutes the memory gate was shut: `total` for either trigger, `swapout` and `swapUsed`
     * for each alone (a minute can count in both), against the ceilings in `constants`
     */
    idleSeatHoursMemory: z.strictObject({ total: z.number(), swapout: z.number(), swapUsed: z.number() }),
    /**
     * of `idleSeatHours`, the hours that fell in minutes an Issue was queued behind a drained queue (`queueByReason`'s
     * `drain`, by the same split): the owner or the orchestrator stopped admission, so it is not capacity going unused.
     * `idleSeatHours` minus this is the figure the tuner reads
     */
    idleSeatHoursDrain: CapacityTotal,
    /**
     * what the queue waited for over the window, by reason kind (`factory.queue_intervals`), the kind with most queued hours
     * first: the hours Issues were queued for it, how many Issues, and the share of `idleSeatHours` that fell in minutes
     * when an Issue was queued for it. A minute's idle seat-hours are split equally among the distinct kinds queued in it,
     * leaving out the kinds that are no cost of the factory (an `after` edge, a Spec at the owner) unless only those wait;
     * `unrecorded` is a minute no interval covers. The kinds are the queue's (`memory` is the host's reading, `memory_fit`
     * the learned cost of a repo's lead against the free memory).
     */
    queueByReason: z.array(CapacityReason),
    /**
     * whether the `after` edges the factory added (triage, the queue loop; never one somebody stated) were needed, over the
     * edges added in the window: both Issues shipped (an accepted ship's commits) and touched a file in common (the
     * lockfiles and the plan aggregator left out) is `needed`, none in common `notNeeded`, an edge whose Issues did not
     * both ship `unknown`. `removed` counts the edges the queue loop took back. `stopped`: enough were measured and most were
     * not needed, so the factory stops adding that source's edges (`kernel/edge-need.ts`); `stopped` is what the loops decide, over the last 14 days ending with the window, whatever `days` was asked
     */
    edges: z.strictObject({
      /** the share of the measured edges of every source that were not needed; null when none was measured */
      notNeededShare: z.number().nullable(),
      bySource: z.array(
        z.strictObject({
          source: z.string(),
          added: z.number().int(),
          needed: z.number().int(),
          notNeeded: z.number().int(),
          unknown: z.number().int(),
          removed: z.number().int(),
          notNeededShare: z.number().nullable(),
          stopped: z.boolean(),
        }),
      ),
    }),
    /** host minutes whose load was above the ceiling in force that minute */
    minutesOverCeiling: CapacityTotal,
    /** the leads running per day: the mean of the minute samples' lead count */
    leadsRunning: z.array(CapacityDay),
    slotWait: z.strictObject({
      n: z.number().int(),
      p50Ms: z.number().nullable(),
      p90Ms: z.number().nullable(),
      perDayP50: z.array(CapacityDay),
      /** the 90th percentile of the day's waits: the tail the lead admission's test line steers on */
      perDayP90: z.array(CapacityDay),
      /** the waits that were granted or given up (`factory.slot_waits`; only those after the table existed), split by what each waited for: largest total first */
      byReason: z.array(SlotWaitReason),
      byRepo: z.array(SlotWaitRepo),
    }),
    /** MiB swapped out per day: the minute samples' swapouts (each scaled to 300 s) over five */
    swapoutMib: CapacityTotal,
    /** host minutes at memory pressure level 2 (warning) or 4 (critical) */
    minutesUnderPressure: CapacityTotal,
    /**
     * the throughput rule (the load ceiling in multiples of the cores, the process cap) beside the live one, from the
     * per-minute decisions of `factory.admission_shadow`: minutes with a queued Issue only the host's rules keep out, in
     * how many of them each rule would admit more, and what the host did in those minutes. Empty once the rule is live.
     */
    shadow: z.strictObject({
      minutes: z.number().int(),
      firstAt: at.nullable(),
      lastAt: at.nullable(),
      /** minutes the shadow rule would have admitted more Issues than the live one, per day */
      shadowMore: CapacityTotal,
      /** minutes it would have admitted fewer */
      shadowFewer: CapacityTotal,
      /**
       * the host's swapouts and pressure in the minutes the shadow rule would have admitted more, fewer, or as many; with the
       * fixed ceiling at or above 3x the cores the shadow is the stricter rule and `whenMore` stays empty, so `whenFewer`
       * (the minutes the new rule would have held back) is what shows whether holding back mattered
       */
      whenMore: CapacityShadowMinutes,
      whenFewer: CapacityShadowMinutes,
      whenSame: CapacityShadowMinutes,
    }),
    /**
     * the slot aim of `read/capacity-loop.ts` (`domains/capacity/slot-aim.ts`): the count it allows now (null before its
     * first minute) and, over the window's shadow minutes, the host's readings in the minutes it allowed more slots than
     * the live rule's base against the others; the switch-on is judged by these two not differing for the worse
     */
    slotAim: z.strictObject({
      mode: z.enum(['off', 'shadow', 'on']),
      target: z.number().int().nullable(),
      minutes: z.number().int(),
      /** minutes the aim allowed more than the live base slots, and the minutes a caller waited in them */
      moreSlots: SlotAimMinutes,
      otherwise: SlotAimMinutes,
      /** the minutes of `moreSlots` with a waiter in line: the minutes it would have helped */
      moreSlotsWithWaiter: z.number().int(),
    }),
    /** the 8 steps with the largest peak memory */
    topSteps: z.array(CapacityStep),
    /** the 8 repos whose leads take most memory (80th percentile of the newest attempts' peaks) */
    leadCosts: z.array(CapacityLeadCost),
    /** processes the reaper signalled (TERM or KILL; a dry decision is not counted) */
    reaped: z.strictObject({ total: z.number().int(), perDay: z.array(CapacityDay), newest: z.array(CapacityReaped) }),
    /** the settings in force that this loop tunes */
    constants: z.strictObject({
      leadsPerAccount: z.number(),
      /** the accounts that have a cap of their own (`FACTORY_ACCOUNT_LEADS`); the rest take `leadsPerAccount` */
      accountLeads: z.record(z.string(), z.number()),
      /** the percent of its 5-hour window and of its week at which an account takes no new lead */
      fiveHourLimit: z.number(),
      weeklyLimit: z.number(),
      loadCeiling: z.number(),
      slots: z.number(),
      slotsMax: z.number(),
      slotExtraLoad: z.number(),
      seatsMaxBonus: z.number(),
      reaperGraceMs: z.number(),
      /** the memory gate: swapouts MiB per 300 s, and swap in use as a share of RAM, above which no lead is admitted */
      swapoutCeilingMb: z.number(),
      swapCeilingPct: z.number(),
      /** `shadow`: the fixed load ceiling is live and the throughput rule is recorded; `on`: the throughput rule is live */
      loadRule: z.enum(['shadow', 'on']),
      /** the throughput rule: the load ceiling in multiples of `cores`, and the cap on the host's process count */
      loadPerCore: z.number(),
      processCap: z.number(),
      cores: z.number(),
      /** `FACTORY_SLOT_AIM`: whether the slot count follows memory pressure, only shadows it, or is off */
      slotAim: z.enum(['off', 'shadow', 'on']),
    }),
  })
  .meta({ id: 'CapacityLoopModel' })
export type CapacityLoopModel = z.infer<typeof CapacityLoopModel>

const nullableNumber = z.number().nullable()

/**
 * The three questions the Throughput page and the retro answer first, each as one sentence with its figure and trend, so
 * nothing on top needs interpretation. Computed by the server (`read/throughput-answers.ts`); the Console draws them.
 */
export const ThroughputAnswers = z
  .strictObject({
    /** is the host the limit right now: the newest pressure level, swap and memory read, and what the head of the queue needs */
    host: z.strictObject({
      limit: z.boolean(),
      level: z.enum(['normal', 'warning', 'critical', 'unread']),
      sentence: z.string(),
      /** the newest host minute: swap in use and resident memory, percent of RAM; null when unread */
      swapUsedPct: nullableNumber,
      memoryUsedPct: nullableNumber,
      /** minutes at warning or critical in the counted window, of the minutes read */
      pressuredMinutes: z.number().int(),
      readMinutes: z.number().int(),
      /** the queue's own reason text when an Issue waits for memory (it names the free memory against what the lead takes) */
      waitingFor: z.string().nullable(),
    }),
    /** what queued Issues wait for: the reason kind with most queued hours that is a cost of the factory */
    queue: z.strictObject({
      sentence: z.string(),
      binding: z.strictObject({ kind: z.string(), hours: z.number(), issues: z.number().int() }).nullable(),
      /** the binding reason's queued hours per UTC day of the counted window, oldest first */
      perDay: z.array(z.strictObject({ day: z.string(), hours: z.number() })),
      /** every reason's hours in the window, most first (the detail) */
      byReason: z.array(z.strictObject({ kind: z.string(), hours: z.number(), issues: z.number().int() })),
    }),
    /** the largest avoidable cost: the tenant class over its budget, else the open improvement with the most minutes */
    cost: z.strictObject({
      kind: z.enum(['tenant', 'improvement', 'none']),
      sentence: z.string(),
      /** tenant: MiB over the budget; improvement: its cost in minutes; none: null */
      figure: nullableNumber,
      unit: z.enum(['MiB', 'minutes']).nullable(),
      /** tenant: the class's mean MiB per UTC day against `budgetMib` */
      perDay: z.array(z.strictObject({ day: z.string(), mib: z.number() })),
      budgetMib: z.number().int(),
      /** improvement: the finding, with its figures before, target and after */
      finding: z
        .strictObject({
          id: z.string(),
          project: z.string(),
          kpi: z.string(),
          subject: z.string(),
          before: z.number(),
          target: z.number(),
          after: nullableNumber,
          unit: z.string(),
          issue: z.string().nullable(),
        })
        .nullable(),
    }),
  })
  .meta({ id: 'ThroughputAnswers' })
export type ThroughputAnswers = z.infer<typeof ThroughputAnswers>

/**
 * One closed Issue's lead wall time, or the sum over Issues, split into the seven places it went, in seconds. The places
 * are exclusive and take time in this order, each only what the ones before it did not: the owner (the Issue waited on a
 * person), a step (a `factory slot run` was running), a slot (one was queued), the merge lock (queued for the window), CI
 * (a run of the lead's branch was queued or running), a turn (the lead's model was working), and idle (everything else).
 * So the seven add up to `wallSeconds`.
 */
export const LeadSplit = z.strictObject({
  /** the Issue waited on a person: a Decision, a verdict, an Errand, or another person's review of its pull request */
  ownerSeconds: z.number(),
  /** a test step ran in a slot, inside the lead's worktree */
  stepSeconds: z.number(),
  /** a step of the lead waited for a slot */
  slotWaitSeconds: z.number(),
  /** a `factory merge-lock` of the lead waited for the project's merge window */
  mergeLockSeconds: z.number(),
  /** a CI run of the lead's branch was queued or running */
  ciSeconds: z.number(),
  /** the lead's session was in a turn: the model worked, or a tool ran for it */
  turnSeconds: z.number(),
  /** none of the above: the lead was quiet with nothing measured under it */
  idleSeconds: z.number(),
})
export type LeadSplit = z.infer<typeof LeadSplit>

/** The oldest and newest row of one stored source. */
export const ThroughputStoredSpan = z.strictObject({ from: at, to: at }).meta({ id: 'ThroughputStoredSpan' })

/** One instant of the series: the leads running and the Issues queued, with the queue by reason and by repo. */
export const ThroughputSeriesPoint = z
  .strictObject({
    /** the bucket's start; the counts are read at this instant */
    at,
    /** lead attempts started at `at` and neither gone nor ended by their Issue's close (`lead_attempts`, `issue_events`), in total and by the Issue's repo */
    running: z.number().int(),
    runningByRepo: z.record(z.string(), z.number().int()),
    /** Issues in an open queue interval at `at` (`queue_intervals`), in total, by the kind of the reason and by repo */
    queued: z.number().int(),
    queuedByReason: z.record(z.string(), z.number().int()),
    queuedByRepo: z.record(z.string(), z.number().int()),
    /** the most leads running and Issues queued the host's minute samples of the bucket held; null where the bucket has no sample */
    peakRunning: z.number().int().nullable(),
    peakQueued: z.number().int().nullable(),
  })
  .meta({ id: 'ThroughputSeriesPoint' })

/**
 * Leads running and Issues queued over the window, a point per bucket, from the events the factory already stores: no counter
 * of its own. `queuedByReason` and `queuedByRepo` start where `queue_intervals` starts (`stored.queueIntervals`); before it
 * only `peakQueued` (the host's minute samples) tells.
 */
export const ThroughputSeries = z
  .strictObject({
    /** 5 minutes up to a day, 15 up to three days, else an hour (the host timeline's bucket) */
    bucketMinutes: z.number().int(),
    points: z.array(ThroughputSeriesPoint),
  })
  .meta({ id: 'ThroughputSeries' })

/**
 * Where the host's memory and CPU went over the last `hours` hours (`GET /v1/throughput`), computed in SQL from the
 * host samples, the per-minute class rows and the notable-process rows, over `[now - hours, now)`. A key's per-minute
 * total is the sum of its rows' `footprint_mib` (and `cpu_ms`) at one minute; its `footprintMib` is the sum of those
 * totals over the window's minutes divided by `host.minutes`, so a minute the key is absent counts 0.
 */
export const ThroughputModel = z
  .strictObject({
    at,
    hours: z.number().int(),
    /** the counted window: `from` is the asked start, or the epoch when it cut the window */
    window: z.strictObject({ from: at, to: at }),
    /** the counting epoch; null where none is configured */
    epoch: ThroughputEpoch.nullable(),
    answers: ThroughputAnswers,
    /**
     * What is stored, whatever the window or the epoch: the oldest and newest row of each source the reads draw on, so a
     * window cut short by the epoch can say which earlier data still exists (rows before the epoch stay until retention
     * removes them). A source with no row is null.
     */
    stored: z.strictObject({
      hostSamples: ThroughputStoredSpan.nullable(),
      hostClassSamples: ThroughputStoredSpan.nullable(),
      queueIntervals: ThroughputStoredSpan.nullable(),
      leadAttempts: ThroughputStoredSpan.nullable(),
      stepCosts: ThroughputStoredSpan.nullable(),
      mergeWindows: ThroughputStoredSpan.nullable(),
    }),
    series: ThroughputSeries,
    host: z.strictObject({
      /** snapshot minutes in the window: the distinct minutes with class rows; the divisor of every mean below */
      minutes: z.number().int(),
      /** the minute rows of `host_samples`; every figure is null when the window has no reading of it (p50 is `percentile_cont(0.5)`) */
      signals: z.strictObject({
        /** host minutes by the kernel's memory pressure level: 1 normal, 2 warning, 4 critical, unread when null */
        pressureMinutes: z.strictObject({
          normal: z.number().int(),
          warning: z.number().int(),
          critical: z.number().int(),
          unread: z.number().int(),
        }),
        load: z.strictObject({ p50: nullableNumber, max: nullableNumber }),
        cpuIdlePct: z.strictObject({ p50: nullableNumber, min: nullableNumber }),
        /** the header's user and system CPU shares, percent of all cores; null where the minutes stored before the split read none */
        cpuUserPct: z.strictObject({ p50: nullableNumber, max: nullableNumber }),
        cpuSysPct: z.strictObject({ p50: nullableNumber, max: nullableNumber }),
        /** user plus system CPU, percent of all cores (a minute with no split reads 100 minus idle) */
        cpuBusyPct: z.strictObject({ p50: nullableNumber, max: nullableNumber }),
        /** memory in use (app, wired and compressed) and swap in use, bytes; a minute stored before the amounts is its share of the RAM */
        memoryUsedBytes: z.strictObject({ p50: nullableNumber, max: nullableNumber }),
        swapUsedBytes: z.strictObject({ p50: nullableNumber, max: nullableNumber }),
        compressorMib: z.strictObject({ p50: nullableNumber, max: nullableNumber }),
        swapUsedPct: z.strictObject({ p50: nullableNumber, max: nullableNumber }),
        processes: z.strictObject({ p50: nullableNumber, max: nullableNumber }),
        /** free space of the swap volume: the smallest reading, and the newest */
        vmFreeGib: z.strictObject({ min: nullableNumber, last: nullableNumber }),
      }),
      /** the CPU the collector's own child processes took, over the minutes it was measured */
      collector: z.strictObject({
        /** minutes with `collector_cpu_ms` read */
        minutes: z.number().int(),
        /** sum of `collector_cpu_ms` over 1000 */
        cpuSeconds: z.number(),
        /** `cpuSeconds` over `minutes * 60`: the share of one core; null when no minute was measured */
        coreShare: nullableNumber,
      }),
      /** all seven classes (lead, step, tenant, factory, system, owner, other), zeros when absent, largest footprint first then by name */
      byClass: z.array(
        z.strictObject({
          class: z.string(),
          /** mean MiB per minute, over `host.minutes`, an integer */
          footprintMib: z.number().int(),
          /** the largest per-minute total */
          peakMib: z.number().int(),
          /** sum of `cpu_ms` (nulls ignored) over 1000, one decimal */
          cpuSeconds: z.number(),
          /** `cpuSeconds` over `host.minutes * 60`, two decimals (0 with no minutes): the mean cores in use */
          cores: z.number(),
          /** mean processes per minute, one decimal */
          procs: z.number(),
          /** the class's part of the footprint of all seven classes together, 0 to 1, four decimals (0 with no footprint) */
          share: z.number(),
        }),
      ),
      /**
       * the tenant class (launchd jobs and VMs) against its budget (`FACTORY_TENANT_BUDGET_MIB`): the class's `footprintMib` over
       * the window, whether it is over the budget, and the repo the daily ranking files a finding on when the 7 days are over it
       */
      tenantBudget: z.strictObject({
        budgetMib: z.number().int(),
        footprintMib: z.number().int(),
        over: z.boolean(),
        project: z.string(),
      }),
      /** lead and step rows with a repo, per repo: the 20 largest by footprint, then repo name */
      byRepo: z.array(
        z.strictObject({
          repo: z.string(),
          footprintMib: z.number().int(),
          peakMib: z.number().int(),
          cpuSeconds: z.number(),
          /** the part of `footprintMib` that is leads, by the same mean rule */
          leadMib: z.number().int(),
          /** the part of `footprintMib` that is steps */
          stepMib: z.number().int(),
        }),
      ),
      /** tenant rows with a tenant, per tenant: the 20 largest by footprint, then tenant name */
      byTenant: z.array(
        z.strictObject({
          tenant: z.string(),
          footprintMib: z.number().int(),
          peakMib: z.number().int(),
          cpuSeconds: z.number(),
        }),
      ),
      /** notable processes grouped by name, class, repo and tenant (a null groups with a null): the 15 with the largest peak, then name */
      topProcesses: z.array(
        z.strictObject({
          name: z.string(),
          class: z.string(),
          repo: z.string().nullable(),
          tenant: z.string().nullable(),
          /** the largest `footprint_mib` of the group */
          peakMib: z.number().int(),
          /** sum of `cpu_ms` (nulls ignored) over 1000, one decimal */
          cpuSeconds: z.number(),
          /** minutes the group was a notable process */
          minutes: z.number().int(),
          /** the largest `grown_mib` of the group, null when it never grew */
          grownMib: z.number().int().nullable(),
        }),
      ),
      /**
       * the newest host minute of the window, as amounts (what the page leads with): each figure null where that minute
       * read none; `cores` is the host's, null where the server does not know it. Null with no minute in the window.
       */
      now: z
        .strictObject({
          at,
          /** user plus system CPU, percent of all cores */
          cpuBusyPct: nullableNumber,
          /** the 1-minute load average, the ceiling in force that minute (cores times the load per core) and the cores */
          load: nullableNumber,
          loadCeiling: nullableNumber,
          cores: z.number().int().nullable(),
          ramBytes: nullableNumber,
          memoryUsedBytes: nullableNumber,
          swapUsedBytes: nullableNumber,
          swapTotalBytes: nullableNumber,
          /** the kernel pressure level (1, 2 or 4) */
          pressureLevel: z.number().int().nullable(),
        })
        .nullable(),
      /**
       * the host signals over the window in equal buckets (5 minutes up to 24 hours, 15 up to 72, else 60), oldest first, a
       * bucket with no sample left out: the worst pressure level and the largest CPU, memory and swap use and load of the bucket
       */
      timeline: z.strictObject({
        bucketMinutes: z.number().int(),
        points: z.array(
          z.strictObject({
            at,
            /** the largest kernel pressure level read in the bucket (1, 2 or 4), null when none was read */
            pressureLevel: z.number().int().nullable(),
            swapUsedPct: nullableNumber,
            cpuBusyPct: nullableNumber,
            memoryUsedBytes: nullableNumber,
            swapUsedBytes: nullableNumber,
            load: nullableNumber,
          }),
        ),
      }),
      /**
       * the last 15 minutes of the host as they were sampled, one point per minute, oldest first (a minute with no sample is
       * left out; none when the newest sample is older than that): what the host cards draw beside their figure. The newest
       * point is the minute `now` reads.
       */
      recent: z.array(
        z.strictObject({
          at,
          cpuBusyPct: nullableNumber,
          memoryUsedBytes: nullableNumber,
          swapUsedBytes: nullableNumber,
          load: nullableNumber,
        }),
      ),
    }),
    /**
     * Test runs per project and the flaky tests, from `step_costs` and `test_results` over the same window (by `at`, the
     * end of a run). A run is a row of `step_costs`; it failed when its exit code is not 0 (a run killed at its limit is 124).
     * A flake is a test with both a pass and a fail at one commit, over clean-tree runs only; a run counts a test once,
     * failed when any of its results of that test failed.
     */
    tests: z.strictObject({
      /** every project with a run in the window, by name */
      byProject: z.array(
        z.strictObject({
          repo: z.string(),
          runs: z.number().int(),
          failedRuns: z.number().int(),
          /** sum of `duration_ms` over 60000, one decimal */
          runMinutes: z.number(),
          /** the same over the failed runs: the slot-minutes that bought nothing */
          failedRunMinutes: z.number(),
          /** `test_results` rows of the window */
          testResults: z.number().int(),
          /** distinct (suite, test) with a flake in the window */
          flakyTests: z.number().int(),
          /** flaky (test, commit) pairs over the pairs seen in two or more clean runs; null when no pair was */
          flakeRate: nullableNumber,
        }),
      ),
      /** the steps of the window per host (`coalesce(host, 'mini')`), by name; a host with no step is absent */
      byHost: z.array(
        z.strictObject({
          host: z.string(),
          runs: z.number().int(),
          failed: z.number().int(),
          /** sum of `duration_ms` over 60000, one decimal */
          minutes: z.number(),
          /** the wait for the slot (`wait_ms`) of the runs, median and 90th percentile; null when no run read one */
          waitP50Ms: nullableNumber,
          waitP90Ms: nullableNumber,
          durationP50Ms: nullableNumber,
          /** runs on the mini that found a red off the mini green */
          disagreed: z.number().int(),
        }),
      ),
      /**
       * The steps its project declared remote and that were placed or ran on the step host in the window: where they ran,
       * why the mini kept them, and the hold a disagreement put them under (issue 2028).
       */
      remote: z.strictObject({
        /** the lines above which production's pressure on the step host refuses a step, and what they come from */
        pressure: z.strictObject({
          memoryPct: z.number(),
          ioPct: z.number(),
          from: z.enum(['default', 'baseline']),
          /** probe samples with no step running (the last 3 days): how many, over how many hours, their 99th percentiles; null: none */
          baseline: z
            .strictObject({
              samples: z.number().int(),
              spanHours: z.number(),
              memoryP99: z.number(),
              ioP99: z.number(),
            })
            .nullable(),
        }),
        steps: z.array(
          z.strictObject({
            step: z.string(),
            /** runs of the window per host */
            miniRuns: z.number().int(),
            vpsRuns: z.number().int(),
            /** placements of the window: on the step host, or on the mini because a slot was free, the VPS had no room, would not finish sooner, or the step was held */
            placed: z.strictObject({
              vps: z.number().int(),
              free: z.number().int(),
              noRoom: z.number().int(),
              notSooner: z.number().int(),
              held: z.number().int(),
            }),
            /** the hold now (or the last one, ended): its length, when it ends, the disagreements in its chain; null: none in the ledger */
            hold: z
              .strictObject({
                active: z.boolean(),
                holdMs: z.number().int(),
                until: at,
                disagreements: z.number().int(),
              })
              .nullable(),
            /** the newest disagreement and what the red run failed on */
            lastDisagreement: z
              .strictObject({
                at,
                tests: z.array(
                  z.strictObject({
                    name: z.string(),
                    durationMs: z.number().int(),
                    timeoutMs: z.number().int().nullable(),
                  }),
                ),
                tail: z.string().nullable(),
              })
              .nullable(),
          }),
        ),
      }),
      /** the 20 flaky tests with the most flaky commits, then the newest flake, then name */
      flaky: z.array(
        z.strictObject({
          repo: z.string(),
          suite: z.string(),
          name: z.string(),
          /** commits at which the test had both results */
          flakyCommits: z.number().int(),
          /** clean-tree runs of the test, and how many of them failed */
          runs: z.number().int(),
          failures: z.number().int(),
          /** when the first and the newest flaky commit showed both results (the later of its first pass and first fail) */
          firstFlakeAt: at,
          lastFlakeAt: at,
        }),
      ),
    }),
    /**
     * Each Issue closed in the window (an applied event into `closed`), over its lead's wall time: from the start of its
     * first lead after the Issue's previous close, if any, to the close. An Issue whose lead never started is not in it.
     * A step or merge window is the lead's when its directory is inside the lead's worktree (a step of an older row, with
     * no directory, when its name begins with the worktree's `factory-<issue>-<attempt>`).
     */
    lead: z.strictObject({
      /** Issues in the split */
      closed: z.number().int(),
      wallSeconds: z.number(),
      split: LeadSplit,
      /** the Issues with the longest wall time, at most 50, then Issue number */
      issues: z.array(
        z.strictObject({
          issue: z.string(),
          repo: z.string(),
          closedAt: at,
          wallSeconds: z.number(),
          split: LeadSplit,
        }),
      ),
    }),
    /** one scorecard per project that closed an Issue, ran a step, finished a CI run or took the merge window in the window: most slot minutes first, then repo name */
    project: z.array(
      z.strictObject({
        repo: z.string(),
        /** Issues closed in the window, whether or not their lead is in `lead` */
        closedIssues: z.number().int(),
        /** the project's `factory slot run` steps over the window, every step of the repo, a lead's or not */
        slot: z.strictObject({
          steps: z.number().int(),
          /** the minutes the steps ran */
          minutes: z.number(),
          /** `minutes` over `closedIssues`, null when none closed */
          minutesPerClosedIssue: nullableNumber,
          /** the minutes the steps waited for a slot, and the median and 90th percentile of one wait */
          waitMinutes: z.number(),
          waitP50Ms: nullableNumber,
          waitP90Ms: nullableNumber,
          /** the longest single wait */
          waitMaxMs: nullableNumber,
          /** the largest peak memory of a step, null when none was measured */
          peakMib: z.number().int().nullable(),
          /** steps that exited non-zero, and their minutes */
          failedSteps: z.number().int(),
          failedMinutes: z.number(),
        }),
        /** the steps by tier: `fast` is `check-fast`, `full` is `check`, any other step is its own last word; most total minutes first */
        check: z.strictObject({
          tiers: z.array(
            z.strictObject({
              tier: z.string(),
              runs: z.number().int(),
              p50Ms: z.number(),
              p90Ms: z.number(),
            }),
          ),
        }),
        /** the finished CI runs (success, failure or timed out; a cancelled or skipped one is left out) */
        ci: z.strictObject({
          runs: z.number().int(),
          /** started to finished, summed */
          minutes: z.number(),
          /** queued to started, summed */
          queueMinutes: z.number(),
          p50Minutes: nullableNumber,
          p90Minutes: nullableNumber,
          /** runs that ended red or timed out, and their minutes */
          failedRuns: z.number().int(),
          failedMinutes: z.number(),
        }),
        /** the work done on the host (`slot.minutes`) against the work done in CI (`ci.minutes`) */
        localToCi: z.strictObject({
          localMinutes: z.number(),
          ciMinutes: z.number(),
          /** local over local plus CI, null when both are 0 */
          localShare: nullableNumber,
        }),
        /** `factory merge-lock` calls that ended in the window: asked to got, and got to gave back */
        mergeLock: z.strictObject({
          windows: z.number().int(),
          waitMinutes: z.number(),
          /** the 90th percentile and the longest of one wait, null when no call ended */
          waitP90Minutes: nullableNumber,
          waitMaxMinutes: nullableNumber,
          holdMinutes: z.number(),
        }),
        /** the lead time of the project's Issues in `lead` */
        leadTime: z.strictObject({
          closed: z.number().int(),
          wallSeconds: z.number(),
          split: LeadSplit,
        }),
      }),
    ),
    /**
     * The deploys that ended in the window, by UTC day, from `data/deploys.log` (empty where the server has no such log): how
     * many ran, how many restarted the server, how many found their commit live and restarted nothing, how many ended red, and
     * the seconds the server was unreachable (from stopping the old process to `/health` at the new sha, `scripts/deploy.sh`).
     */
    deploys: z.strictObject({
      days: z.array(
        z.strictObject({
          day: z.string(),
          deploys: z.number().int(),
          restarts: z.number().int(),
          skipped: z.number().int(),
          failed: z.number().int(),
          unreachableSeconds: z.number().int(),
          longestSeconds: z.number().int(),
        }),
      ),
    }),
    /**
     * The throughput loop's findings (`throughput_findings`), the 50 newest by filing, whatever the window: what each measured
     * before it was filed, the target, the figure read three days after its Issue shipped, and where it stands.
     */
    improvements: z.array(
      z.strictObject({
        id: z.string(),
        project: z.string(),
        /** `failed_run_minutes`, `slot_minutes_per_issue`, `step_peak_mib`, `process_growth_mib`, `queued_minutes`, `tenant_class_mib` or `tenant_growth_mib` */
        kpi: z.string(),
        /** a step's tier, a process name, or `*` for the whole project */
        subject: z.string(),
        before: z.number(),
        target: z.number(),
        after: nullableNumber,
        direction: z.enum(['up', 'down']),
        unit: z.string(),
        costMinutes: z.number(),
        /** open, shipped (waiting for its after), moved, flat, worse, dropped or unmeasured */
        status: z.string(),
        /** why a row is `unmeasured` when the read says so (filed before the epoch), else null */
        reason: z.string().nullable(),
        issue: z.string().nullable(),
        filedAt: at,
        shippedAt: at.nullable(),
        afterAt: at.nullable(),
      }),
    ),
  })
  .meta({ id: 'ThroughputModel' })
export type ThroughputModel = z.infer<typeof ThroughputModel>

/** The capacity figures a retro signal can name in its marker (`kpi=<key>`), besides the `KPI_KEYS`; all per day or p90. */
export const CAPACITY_FIGURE_KEYS = [
  'closed_per_day',
  'minutes_over_ceiling_per_day',
  'idle_seat_hours_per_day',
  'idle_seat_hours_drain_per_day',
  'idle_seat_hours_with_drain_per_day',
  'slot_wait_p90_ms',
  'check_minutes_per_issue',
  'ci_p50_minutes',
  'api_blocked_minutes_per_day',
] as const

export const RetroCapacityFigure = z
  .strictObject({
    key: z.enum(CAPACITY_FIGURE_KEYS),
    label: z.string(),
    /** null when nothing was measured (no slot step ran) */
    value: z.number().nullable(),
    unit: z.enum(['count', 'minutes', 'hours', 'ms']),
  })
  .meta({ id: 'RetroCapacityFigure' })
export type RetroCapacityFigure = z.infer<typeof RetroCapacityFigure>

export const RetroBuildStep = z
  .strictObject({
    /** the step's name as `factory slot run` was given it, a lead's `factory-<n>-<attempt> ` prefix dropped */
    name: z.string(),
    runs: z.number().int(),
    medianMs: z.number(),
    p90Ms: z.number(),
    totalMinutes: z.number(),
  })
  .meta({ id: 'RetroBuildStep' })

export const RetroBuildCiKind = z
  .strictObject({ runs: z.number().int(), p50Minutes: z.number(), p90Minutes: z.number() })
  .meta({ id: 'RetroBuildCiKind' })

export const RetroBuildCi = z
  .strictObject({
    /** finished runs on the default branch (a push) that ended green or red */
    defaultBranch: RetroBuildCiKind.nullable(),
    /** finished runs on pull request heads */
    pullRequest: RetroBuildCiKind.nullable(),
    /** minutes of every run counted */
    totalMinutes: z.number(),
    /** more finished runs were in the window than were read (the newest 300): every figure here covers the newest days only */
    truncated: z.boolean(),
    /** runs that passed on a rerun (a run attempt above 1), as a share of the finished runs; null with no runs */
    flakyShare: z.number().nullable(),
  })
  .meta({ id: 'RetroBuildCi' })

export const RetroBuildRepo = z
  .strictObject({
    repo: z.string(),
    /** Issues closed in the window (any outcome, as `closed_per_day` counts them) */
    closedIssues: z.number().int(),
    check: z.strictObject({
      /** finished test-slot steps (`factory slot run`) */
      runs: z.number().int(),
      /** runs x duration */
      totalMinutes: z.number(),
      /** null with no Issue closed */
      runsPerIssue: z.number().nullable(),
      minutesPerIssue: z.number().nullable(),
      /** minutes spent waiting for a test slot, and the p90 of one wait */
      waitMinutes: z.number(),
      waitP90Ms: z.number().nullable(),
      /** the steps with the most total minutes, at most 5 */
      slowestSteps: z.array(RetroBuildStep),
    }),
    /** null when GitHub could not be read for the repo: it is under `unreadable` */
    ci: RetroBuildCi.nullable(),
    /** check plus CI minutes per closed Issue; null with no Issue closed, or no CI read and no check run */
    minutesPerIssue: z.number().nullable(),
  })
  .meta({ id: 'RetroBuildRepo' })
export type RetroBuildRepo = z.infer<typeof RetroBuildRepo>

/**
 * What it costs to build in each repo over the window (`build` of `GET /v1/retro`): local check minutes from the test-slot
 * step costs and CI from GitHub's finished workflow runs. `repos` is sorted by `minutesPerIssue`, highest first, those
 * without one after, by total minutes. `figures` are the two keys a retro signal may name (`check_minutes_per_issue`,
 * `ci_p50_minutes`), totals over all repos.
 */
export const RetroBuild = z
  .strictObject({
    repos: z.array(RetroBuildRepo),
    /** repos whose CI could not be read (no token, no github.com origin, a timeout, a bad answer), with why */
    unreadable: z.array(z.strictObject({ repo: z.string(), reason: z.string() })),
    figures: z.array(RetroCapacityFigure),
  })
  .meta({ id: 'RetroBuild' })
export type RetroBuild = z.infer<typeof RetroBuild>

/** The one setting to change first, by fixed rules over the figures (`read/capacity-tuning.ts`). */
export const RetroCapacityTune = z
  .strictObject({
    constant: z.enum([
      'leadsPerAccount',
      'seatsMaxBonus',
      'loadCeiling',
      'slots',
      'slotsMax',
      'swapoutCeilingMb',
      'swapCeilingPct',
    ]),
    direction: z.enum(['up', 'down']),
    reason: z.string(),
  })
  .meta({ id: 'RetroCapacityTune' })
export type RetroCapacityTune = z.infer<typeof RetroCapacityTune>

export const RetroCapacity = z
  .strictObject({
    figures: z.array(RetroCapacityFigure),
    /** null when nothing is out of range */
    tune: RetroCapacityTune.nullable(),
    loop: CapacityLoopModel,
  })
  .meta({ id: 'RetroCapacity' })
export type RetroCapacity = z.infer<typeof RetroCapacity>

/**
 * The throughput figures of the retro's window (`ThroughputModel` over the same hours, capped at 14 days): where the
 * host's memory went by class, the pressure and swap it ran at, the lead time split, the project scorecard and the
 * improvements with their before and after. Numbers and project names only.
 */
export const RetroThroughput = z
  .strictObject({
    hours: z.number().int(),
    epoch: ThroughputEpoch.nullable(),
    answers: ThroughputAnswers,
    host: ThroughputModel.shape.host.pick({ minutes: true, signals: true, byClass: true }),
    lead: ThroughputModel.shape.lead.omit({ issues: true }),
    project: ThroughputModel.shape.project,
    improvements: ThroughputModel.shape.improvements,
  })
  .meta({ id: 'RetroThroughput' })
export type RetroThroughput = z.infer<typeof RetroThroughput>

/** One source of waste over the retro's window, in hours: what the factory spent waiting or redoing. */
export const RetroWasteSource = z
  .strictObject({
    source: z.enum(['queue', 'slot_wait', 'stalls', 'refused_ships', 'owner_waits']),
    hours: z.number(),
    /** how many waits, refusals or intervals add up to the hours */
    events: z.number().int(),
    /** the largest part of it, in the factory's words (the queue reason, the stall reason); null when it has no parts */
    largest: z.string().nullable(),
  })
  .meta({ id: 'RetroWasteSource' })
export type RetroWasteSource = z.infer<typeof RetroWasteSource>

/**
 * What the weekly retro reads, all of it from the event log and the tables (no model): the KPI table with its history, the
 * friction counts, the lead sessions with their transcripts (the CLI reads those: `factory retro`), samples of Issues worth
 * reading, the ledger of the earlier retro signals and the capacity loop's figures with the one setting to change.
 */
export const RetroModel = z
  .strictObject({
    at,
    days: z.number().int(),
    window: z.strictObject({ from: at, to: at }),
    kpis: KpiModel,
    friction: FrictionModel,
    sessions: z.array(RetroSession),
    samples: z.strictObject({
      regressed: z.array(RetroSample),
      stalled: z.array(RetroSample),
      slowest: z.array(RetroSample),
      refused: z.array(RetroSample),
      dropped: z.array(RetroSample),
    }),
    ledger: z.array(RetroLedgerEntry),
    /** the owner's verdict notes and annotations of the window */
    taste: RetroTaste,
    /** the capacity loop over the window; null when the server holds no capacity settings */
    capacity: RetroCapacity.nullable(),
    /** what each repo's local checks and CI cost over the window */
    build: RetroBuild,
    /** where the host's memory and the leads' hours went over the window */
    throughput: RetroThroughput,
    /** the five sources of waste in hours, largest first: the first three are what the Report leads with */
    waste: z.array(RetroWasteSource),
  })
  .meta({ id: 'RetroModel' })
export type RetroModel = z.infer<typeof RetroModel>

/**
 * The marker a retro signal ends with so the next retro can find it: `Retro: 2026-11-17 kpi=cycle_p50 before=4273327645
 * direction=down` (`before=none` when the KPI had no number). The date is the retro's day, `kpi` a `KPI_KEYS` or `CAPACITY_FIGURE_KEYS` entry,
 * `direction` where the number should go. Intake keeps a signal's text on one line (newlines become spaces), so the marker
 * is found anywhere in the text, never by a line start.
 */
export const RETRO_MARKER =
  /Retro: (\d{4}-\d{2}-\d{2}) kpi=([a-z0-9_]+) before=(none|-?\d+(?:\.\d+)?) direction=(up|down)(?![a-z])/
