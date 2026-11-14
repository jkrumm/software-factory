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
    /** a held signal's link to the thing it is about; null for everything else and for a work-repo item the caller may not read */
    sourceLink: z.string().nullable(),
    /** an Errand whose last run failed or whose check overruled a done: "tried, failed: <first error line>" or the check's note; null for everything else and for a work-repo item the caller may not read */
    tried: z.string().nullable(),
    /** a long wait: why the Issue waits, when it ends and how many open Issues wait behind it; null for everything else */
    wait: z.strictObject({ reason: z.literal('timer'), until: at, held: z.number().int().min(1) }).nullable(),
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
  'verdict_changes_share',
  'specs_per_100',
  'owner_decisions_per_100',
  'first_verification_passes',
  'refusals',
  'cycle_p50',
  'queue_wait_p50',
  'queue_wait_p90',
  'fix_commits',
  'window_points',
  'cost',
  'queue_time',
  'idle_capacity',
  'working_share',
  'dropped_after_lead',
  'amend_rate',
  'nudges_acted',
  'forced_note_delay_p50',
  'errands_turned_away',
  'regression_cause',
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

/** How many consecutive windows of `days` days a Kpi's `history` holds, the current one last. */
export const HISTORY_WINDOWS = 6

export const KpiPoint = z
  .strictObject({
    /** null when nothing was counted (`n` is 0) or the number is not measured in that window */
    value: z.number().nullable(),
    n: z.number().int(),
  })
  .meta({ id: 'KpiPoint' })

const KPI_UNITS = ['per_issue', 'per_100_issues', 'share', 'ms', 'usd', 'points'] as const

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
    /** false: the factory has no data for it yet (it is not a zero) */
    measured: z.boolean(),
    /** exactly what was counted */
    definition: z.string(),
    /** the breakdown of the current window, when the figure is one (empty otherwise); history keeps the headline only */
    parts: z.array(KpiPart),
    /** `HISTORY_WINDOWS` points, oldest first, one per window of `KpiModel.windows`; the last is `value` and `n` */
    history: z.array(KpiPoint).length(HISTORY_WINDOWS),
  })
  .meta({ id: 'Kpi' })
export type Kpi = z.infer<typeof Kpi>

export const KpiModel = z
  .strictObject({
    at,
    days: z.number().int(),
    window: z.strictObject({ from: at, to: at }),
    /** the consecutive windows behind every `history`, oldest first; the last is `window` */
    windows: z.array(z.strictObject({ from: at, to: at })).length(HISTORY_WINDOWS),
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
    /** working or watching now */
    working: z.number().int().min(0),
    /** settling or queued now */
    queued: z.number().int().min(0),
    waiting: z.number().int().min(0),
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

export const CapacityReaped = z
  .strictObject({ comm: z.string(), session: z.string(), reason: z.enum(['session', 'worktree']), at })
  .meta({ id: 'CapacityReaped' })

/**
 * What the capacity loop did over the last `days` days (`GET /v1/capacity-loop`), computed in SQL from the host samples,
 * the test-slot step costs, the lead samples and the reaper's rows, with the settings it tunes.
 */
export const CapacityLoopModel = z
  .strictObject({
    at,
    days: z.number().int(),
    window: z.strictObject({ from: at, to: at }),
    /** Issues that closed (any outcome, as the cycle KPI counts them) */
    throughput: CapacityTotal,
    /** seats not held by a lead while Issues were queued, in hours: minutes with queued > 0 of max(seats - leads, 0), over 60 */
    idleSeatHours: CapacityTotal,
    /**
     * of `idleSeatHours`, the hours in minutes the memory gate was shut: `total` for either trigger, `swapout` and `swapUsed`
     * for each alone (a minute can count in both), against the ceilings in `constants`
     */
    idleSeatHoursMemory: z.strictObject({ total: z.number(), swapout: z.number(), swapUsed: z.number() }),
    /** host minutes whose load was above the ceiling in force that minute */
    minutesOverCeiling: CapacityTotal,
    slotWait: z.strictObject({
      n: z.number().int(),
      p50Ms: z.number().nullable(),
      p90Ms: z.number().nullable(),
      perDayP50: z.array(CapacityDay),
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
    window: z.strictObject({ from: at, to: at }),
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
        }),
      ),
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
  })
  .meta({ id: 'ThroughputModel' })
export type ThroughputModel = z.infer<typeof ThroughputModel>

/** The capacity figures a retro signal can name in its marker (`kpi=<key>`), besides the `KPI_KEYS`; all per day or p90. */
export const CAPACITY_FIGURE_KEYS = [
  'closed_per_day',
  'minutes_over_ceiling_per_day',
  'idle_seat_hours_per_day',
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
  })
  .meta({ id: 'RetroModel' })
export type RetroModel = z.infer<typeof RetroModel>

/**
 * The marker a retro signal ends with so the next retro can find it: `Retro: 2026-11-17 kpi=queue_time before=4273327645
 * direction=down` (`before=none` when the KPI had no number). The date is the retro's day, `kpi` a `KPI_KEYS` or `CAPACITY_FIGURE_KEYS` entry,
 * `direction` where the number should go. Intake keeps a signal's text on one line (newlines become spaces), so the marker
 * is found anywhere in the text, never by a line start.
 */
export const RETRO_MARKER =
  /Retro: (\d{4}-\d{2}-\d{2}) kpi=([a-z0-9_]+) before=(none|-?\d+(?:\.\d+)?) direction=(up|down)(?![a-z])/
