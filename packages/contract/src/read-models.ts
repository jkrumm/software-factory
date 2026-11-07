import * as z from 'zod'
import { QueueReason, QueueStatesView } from './capacity.ts'
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
    link: z.strictObject({ type: z.enum(['decision', 'artifact', 'errand', 'signal']), id: z.string() }),
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

export const FlowIssue = z
  .strictObject({
    id: IssueRef,
    repo: z.string(),
    title: z.string(),
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
    outcome: z.enum(['done', 'dropped', 'healed', 'cancelled']),
    closedAt: at,
  })
  .meta({ id: 'FlowClosed' })

export const FlowProject = z
  .strictObject({ repo: z.string(), open: z.number().int(), working: z.number().int(), queued: z.number().int() })
  .meta({ id: 'FlowProject' })

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
      'refusal',
      'stall',
      'lead_gone',
      'undelivered_note',
      'unreviewed_ship',
      'regression',
      'decision_settled',
      'signal',
    ]),
    label: z.string(),
    count: z.number().int(),
    /** per Issue filed in the window; null when there was none */
    perIssue: z.number().nullable(),
  })
  .meta({ id: 'FrictionCount' })
export type FrictionCount = z.infer<typeof FrictionCount>

export const FrictionModel = z
  .strictObject({
    at,
    days: z.number().int(),
    window: z.strictObject({ from: at, to: at }),
    /** Issues filed in the window: what `perIssue` divides by */
    issues: z.number().int(),
    counts: z.array(FrictionCount),
  })
  .meta({ id: 'FrictionModel' })
export type FrictionModel = z.infer<typeof FrictionModel>
