import * as z from 'zod'
import { QueueReason, QueueStatesView } from './capacity.ts'
import { SIGNAL_ORIGINS } from './intake.ts'
import { IssueRef } from './planning.ts'

/**
 * The Console's computed screens: what waits on the owner, the Issues by state, the chain, the KPIs and the friction. Each
 * is a read model over the stored facts (`GET /v1/needs|flow|chain|kpis|friction`). Titles and summaries are plain words:
 * an id is a field to link by, never display text.
 */

const at = z.string().describe('an ISO timestamp')

// -- needs ---------------------------------------------------------------------------------------------------------------

export const NEED_KINDS = ['decision', 'review', 'errand', 'held_signal'] as const
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
    link: z.strictObject({ type: z.enum(['decision', 'artifact', 'errand', 'signal']), id: z.string() }),
    /** the artifact under review a Decision was raised about; null for everything else */
    artifact: z.string().nullable(),
    /** where it came from, in the words of `SIGNAL_ORIGINS`: a held signal's own origin, else the Issue's; null when unknown */
    origin: z.string().nullable(),
    /** a held signal's source in a person's word (never a tool name); null for everything else */
    source: z.string().nullable(),
    /** a held signal's link to the thing it is about; null for everything else and for a work-repo item the caller may not read */
    sourceLink: z.string().nullable(),
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
  })
  .meta({ id: 'FlowClosed' })

export const FlowProject = z
  .strictObject({ repo: z.string(), open: z.number().int(), working: z.number().int(), queued: z.number().int() })
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
    queueStates: QueueStatesView,
    /** the last 7 days in daily samples; counts only */
    trend: FlowTrend,
  })
  .meta({ id: 'FlowModel' })
export type FlowModel = z.infer<typeof FlowModel>

// -- chain ---------------------------------------------------------------------------------------------------------------

export const ChainNode = z
  .strictObject({
    /** an Issue's id, or `row:<project>:<key>` for a plan row not yet filed */
    id: z.string(),
    kind: z.enum(['issue', 'row']),
    repo: z.string().nullable(),
    title: z.string(),
    /** an Issue's state, or a row's: `filable` or `waiting` */
    state: z.string(),
    /** an Issue's settled kind, else its filed one (`chore` when unknown); a row's `kind` (default `feature`) */
    issueKind: z.enum(FLOW_KINDS),
    /** when the Issue entered the state it is in; null for a row */
    since: z.string().nullable(),
    /** the wait of a `waiting` Issue; null for a row */
    waitReason: z.string().nullable(),
    /** a row's `not_before` as a full ISO instant, past or future; null for an Issue and for a row without one */
    notBefore: z.string().nullable(),
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
  'worth_asking',
  'first_verification_passes',
  'refusals',
  'cycle_p50',
  'queue_wait_p50',
  'queue_wait_p90',
  'fix_commits',
  'window_points',
  'cost',
] as const
export type KpiKey = (typeof KPI_KEYS)[number]

export const KpiTarget = z
  .strictObject({
    kind: z.enum(['at_most', 'at_least', 'between', 'trend', 'unset']),
    min: z.number().nullable(),
    max: z.number().nullable(),
  })
  .meta({ id: 'KpiTarget' })

export const Kpi = z
  .strictObject({
    key: z.enum(KPI_KEYS),
    label: z.string(),
    /** null when nothing was counted (`n` is 0) or the number is not measured */
    value: z.number().nullable(),
    unit: z.enum(['per_issue', 'share', 'ms', 'usd', 'points']),
    /** what the value was divided by: Issues, answered Decisions, passed watches, measured Issues */
    n: z.number().int(),
    /** the numerator: the events counted (a duration's samples are `n`) */
    count: z.number().int().nullable(),
    target: KpiTarget,
    /** false: the factory has no data for it yet (it is not a zero) */
    measured: z.boolean(),
    /** exactly what was counted */
    definition: z.string(),
  })
  .meta({ id: 'Kpi' })
export type Kpi = z.infer<typeof Kpi>

export const KpiModel = z
  .strictObject({
    at,
    days: z.number().int(),
    window: z.strictObject({ from: at, to: at }),
    kpis: z.array(Kpi),
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
      'regression',
      'decision_settled',
      'signal',
    ]),
    label: z.string(),
    count: z.number().int(),
    /** per Issue closed in the window; null when none closed */
    perIssue: z.number().nullable(),
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
  })
  .meta({ id: 'FindingClass' })
export type FindingClass = z.infer<typeof FindingClass>

export const FindingClassesModel = z
  .strictObject({
    at,
    /** held first, then probation, then open; then by loop and class */
    classes: z.array(FindingClass),
  })
  .meta({ id: 'FindingClassesModel' })
export type FindingClassesModel = z.infer<typeof FindingClassesModel>

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
      filed: SinceFiled,
      /** incidents opened */
      incidents: SinceCategory,
    }),
  })
  .meta({ id: 'SinceModel' })
export type SinceModel = z.infer<typeof SinceModel>
