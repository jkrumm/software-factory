import * as z from 'zod'

/** An Issue as the API names it: `issue_<n>`, the number being "Issue 286". */
export const IssueRef = z.string().regex(/^issue_[1-9][0-9]*$/, 'an Issue id like issue_286')

export const ROW_STATES = ['done', 'open', 'filable', 'waiting'] as const

/** One row of a project's `docs/plan.yaml` as the factory sees it now (derived at read, never stored). */
export const PlanRowStatus = z
  .object({
    project: z.string(),
    key: z.string(),
    state: z.enum(ROW_STATES),
    /** the row's Issue, once there is one */
    issue: IssueRef.nullable(),
    /** why a `waiting` row waits */
    reason: z.string().nullable(),
    /** the project the row's Issue is filed in; null when the row names a project nobody knows */
    target: z.string().nullable(),
  })
  .meta({ id: 'PlanRowStatus' })
export type PlanRowStatus = z.infer<typeof PlanRowStatus>

const FileError = z.object({ message: z.string(), sha: z.string().nullable() })

/** A project the factory has read: its `project.yaml` in force and its plan. */
export const ProjectView = z
  .object({
    /** the repo directory's name (`<name>~<hash>` for a second directory of that name) */
    name: z.string(),
    repo: z.string(),
    /** `file`: the last valid `project.yaml`; `defaults`: there is none */
    source: z.enum(['file', 'defaults']),
    branch: z.string().nullable(),
    syncedAt: z.string().nullable(),
    /** how many leads may work in the repo at once */
    leads: z.number().int(),
    /** the test-slot run limit, `45m`; null: the default */
    slotRun: z.string().nullable(),
    /** the automatic sources the project listens to; a work repo lists none and hears the owner only */
    signals: z.record(z.string(), z.unknown()),
    /** the content now on the default branch does not parse; the fields above are the last valid ones */
    projectError: FileError.nullable(),
    plan: z
      .object({ sha: z.string().nullable(), warnings: z.array(z.string()), rows: z.array(PlanRowStatus) })
      .nullable(),
    /** the plan now on the default branch does not parse; `plan` is the last valid one */
    planError: z.string().nullable(),
  })
  .meta({ id: 'ProjectView' })
export type ProjectView = z.infer<typeof ProjectView>

export const ProjectList = z.object({ projects: z.array(ProjectView) }).meta({ id: 'ProjectList' })
export type ProjectList = z.infer<typeof ProjectList>

export const BrokenFile = z.object({
  project: z.string(),
  file: z.enum(['project.yaml', 'docs/plan.yaml']),
  message: z.string(),
  /** the Issue filed for a broken `project.yaml` */
  issue: IssueRef.nullable(),
})

/** `--fetch true` asks the remote for new commits first; absent, the default branch is read as last fetched. */
export const FetchQuery = z.object({ fetch: z.enum(['true', 'false']).optional() })
export type FetchQuery = z.infer<typeof FetchQuery>

export const ProjectSyncAnswer = z
  .object({
    synced: z.number().int(),
    broken: z.array(BrokenFile),
    /** repos that could not be read this time; their rows are left as they were */
    errors: z.array(z.string()),
  })
  .meta({ id: 'ProjectSyncAnswer' })
export type ProjectSyncAnswer = z.infer<typeof ProjectSyncAnswer>

export const PlanningPassAnswer = z
  .object({
    sync: ProjectSyncAnswer.nullable(),
    /** plan rows filed as Issues by this pass */
    filed: z.array(z.object({ project: z.string(), row: z.string(), issue: IssueRef })),
    /** chain edges whose blocker was seen closed */
    satisfied: z.number().int(),
    /** Issues whose dependency wait ended */
    woken: z.array(IssueRef),
    errors: z.array(z.string()),
  })
  .meta({ id: 'PlanningPassAnswer' })
export type PlanningPassAnswer = z.infer<typeof PlanningPassAnswer>

export const SettleBody = z
  .object({
    issue: IssueRef,
    /** the Issues it must wait for; none is a known answer too */
    after: z.array(IssueRef).max(20).default([]),
  })
  .meta({ id: 'SettleBody' })
export type SettleBody = z.infer<typeof SettleBody>

export const SettleAnswer = z
  .object({
    issue: IssueRef,
    /** `settled`: queued now; `replayed`: settled before; `ignored`: it was not settling */
    result: z.enum(['settled', 'replayed', 'ignored']),
    edges: z.number().int(),
    state: z.string(),
  })
  .meta({ id: 'SettleAnswer' })
export type SettleAnswer = z.infer<typeof SettleAnswer>

export const AfterBody = z
  .object({ issue: IssueRef, after: z.array(IssueRef).min(1).max(20) })
  .meta({ id: 'AfterBody' })
export type AfterBody = z.infer<typeof AfterBody>

export const AfterAnswer = z.object({ issue: IssueRef, edges: z.number().int() }).meta({ id: 'AfterAnswer' })
export type AfterAnswer = z.infer<typeof AfterAnswer>

export const UnafterBody = z
  .object({ issue: IssueRef, after: z.array(IssueRef).min(1).max(20) })
  .meta({ id: 'UnafterBody' })
export type UnafterBody = z.infer<typeof UnafterBody>

export const UnafterAnswer = z.object({ issue: IssueRef, removed: z.number().int() }).meta({ id: 'UnafterAnswer' })
export type UnafterAnswer = z.infer<typeof UnafterAnswer>

export const PrioBody = z
  .strictObject({
    value: z.number().int().min(-1000).max(1000),
    /** a repeated key records nothing again; generated when absent */
    key: z.string().min(1).max(200).optional(),
  })
  .meta({ id: 'PrioBody' })
export type PrioBody = z.infer<typeof PrioBody>

export const PrioAnswer = z
  .object({ issue: IssueRef, value: z.number().int(), recorded: z.boolean() })
  .meta({ id: 'PrioAnswer' })
export type PrioAnswer = z.infer<typeof PrioAnswer>
