import * as z from 'zod'
import { IssueRef } from './planning.ts'
import { WorkCounts } from './work-words.ts'

/**
 * The Console's project screens: every project in one list, one project's page, and one project's hygiene. Read models over
 * stored facts (`GET /v1/projects`, `/v1/projects/:name`, `/v1/projects/:name/hygiene`); the plan rows of the page come from
 * `GET /v1/projects/:name/plan`, the open Issues from `GET /v1/flow`.
 */

const at = z.string().describe('an ISO timestamp')

/** What a project has now and shipped: the digest's own counts, read from the Issues. */
export const ProjectCounts = z
  .strictObject({
    /** closed done or healed in the last 7 days */
    done7d: z.number().int().min(0),
    /** the open Issues by the five words (`workOf`) */
    work: WorkCounts,
  })
  .meta({ id: 'ProjectCounts' })
export type ProjectCounts = z.infer<typeof ProjectCounts>

export const HYGIENE_OUTCOMES = ['answered', 'failed', 'skipped'] as const

// -- the list ------------------------------------------------------------------------------------------------------------

export const ProjectIndexRow = z
  .strictObject({
    name: z.string(),
    /** a work repo: no `project.yaml` of its own, or one that says `work: true` */
    work: z.boolean(),
    /** `file`: the project has its own `project.yaml`; `defaults`: it has none */
    source: z.enum(['file', 'defaults']),
    branch: z.string().nullable(),
    counts: ProjectCounts,
    /** the newest hygiene pass; null: the project was never swept */
    hygiene: z.strictObject({
      lastPassAt: at.nullable(),
      outcome: z.enum(HYGIENE_OUTCOMES).nullable(),
      /** findings of the newest pass */
      findings: z.number().int().min(0),
    }),
  })
  .meta({ id: 'ProjectIndexRow' })
export type ProjectIndexRow = z.infer<typeof ProjectIndexRow>

export const ProjectIndexModel = z
  .strictObject({ at, projects: z.array(ProjectIndexRow) })
  .meta({ id: 'ProjectIndexModel' })
export type ProjectIndexModel = z.infer<typeof ProjectIndexModel>

// -- the page ------------------------------------------------------------------------------------------------------------

const PageIssue = z.strictObject({ id: IssueRef, title: z.string(), kind: z.string() })

/** A monitor whose alerts the door files in this project (Uptime Kuma, ClickStack), with the last thing it said. */
export const ProjectMonitor = z
  .strictObject({
    source: z.string(),
    monitor: z.string(),
    /** the last event the door heard of it; null: none yet */
    lastEvent: z.string().nullable(),
    /** alerts the door took in and filed nothing for */
    quiet: z.number().int().min(0),
    lastQuietAt: at.nullable(),
  })
  .meta({ id: 'ProjectMonitor' })
export type ProjectMonitor = z.infer<typeof ProjectMonitor>

export const ProjectPageModel = z
  .strictObject({
    at,
    /** the project's name; a request by the repo's path or a worktree below it is answered with this */
    name: z.string(),
    /** the repo text Issues of the project carry (its path): Flow's cards name a project by it when its name was taken */
    repo: z.string(),
    work: z.boolean(),
    source: z.enum(['file', 'defaults']),
    branch: z.string().nullable(),
    syncedAt: at.nullable(),
    /** the `project.yaml` now on the default branch does not parse; the setup is the last valid one */
    projectError: z.string().nullable(),
    counts: ProjectCounts,
    shipped: z.strictObject({
      /** Issues closed done or healed per day, oldest first, the last day ending at `at` */
      days: z.array(z.number().int().min(0)).length(7),
      /** the same count per hour over the last 7 days, oldest first, the last hour ending at `at` */
      hours: z.array(z.number().int().min(0)).length(168),
      /** the same count over the 7 days before */
      before: z.number().int().min(0),
      /** the newest 100 of the last 7 days */
      items: z.array(PageIssue.extend({ outcome: z.string(), closedAt: at })),
    }),
    production: z.strictObject({
      /** shipped and held for their Watch */
      watching: z.array(PageIssue.extend({ since: at })),
      /** incidents opened in the last 7 days, each with whether its Issue is still open */
      incidents: z.array(PageIssue.extend({ openedAt: at, open: z.boolean() })),
      /** regressions in the last 7 days */
      regressions: z.array(PageIssue.extend({ at })),
      /** empty for the read token */
      monitors: z.array(ProjectMonitor),
    }),
  })
  .meta({ id: 'ProjectPageModel' })
export type ProjectPageModel = z.infer<typeof ProjectPageModel>

// -- hygiene -------------------------------------------------------------------------------------------------------------

export const PROBE_STATUSES = ['clean', 'found', 'skipped', 'failed', 'never'] as const

/** One probe of the project: a built-in one, or one the project declares; `never` is a probe no pass has run yet. */
export const HygieneProbeRow = z
  .strictObject({
    /** a built-in probe's name, or the project's own name for a declared one */
    name: z.string(),
    declared: z.boolean(),
    /** a declared probe's `make` target */
    target: z.string().nullable(),
    status: z.enum(PROBE_STATUSES),
    /** what the last run said: what ran and how long, or why it was skipped or failed; the project's reason for a probe it opted out of */
    detail: z.string(),
    /** findings of the newest pass this probe raised */
    findings: z.number().int().min(0),
  })
  .meta({ id: 'HygieneProbeRow' })
export type HygieneProbeRow = z.infer<typeof HygieneProbeRow>

export const HYGIENE_FINDING_STATUSES = ['filed', 'left_out', 'refused', 'not_filed'] as const

export const HygieneFindingRow = z
  .strictObject({
    /** the probe, or `document` for what the document judgment found */
    probe: z.string(),
    key: z.string(),
    title: z.string(),
    /** how many items it groups (broken links in a file) */
    count: z.number().int().min(0),
    /** `filed`: a signal was filed; `left_out`: the pass's cap or a held class kept it out; `refused`: intake refused it (see `reason`) */
    status: z.enum(HYGIENE_FINDING_STATUSES),
    reason: z.string().nullable(),
  })
  .meta({ id: 'HygieneFindingRow' })
export type HygieneFindingRow = z.infer<typeof HygieneFindingRow>

export const HygienePassRow = z
  .strictObject({
    id: z.string(),
    at,
    /** the commit swept (full sha); empty when no checkout could be made */
    ref: z.string(),
    judgment: z.strictObject({ outcome: z.enum(HYGIENE_OUTCOMES), reason: z.string() }),
    findings: z.number().int().min(0),
    filed: z.number().int().min(0),
  })
  .meta({ id: 'HygienePassRow' })
export type HygienePassRow = z.infer<typeof HygienePassRow>

export const ProjectHygieneModel = z
  .strictObject({
    at,
    project: z.string(),
    /** the project's own words for why `make check` is not run as a probe; null: it is run */
    skipCheck: z.string().nullable(),
    probes: z.array(HygieneProbeRow),
    /** the newest pass; null: the project was never swept */
    lastPass: HygienePassRow.nullable(),
    /** how many living documents the newest pass found stale, and edited lately */
    documents: z.strictObject({ stale: z.number().int().min(0), slop: z.number().int().min(0) }),
    findings: z.array(HygieneFindingRow),
    /** the newest five passes, newest first */
    passes: z.array(HygienePassRow),
  })
  .meta({ id: 'ProjectHygieneModel' })
export type ProjectHygieneModel = z.infer<typeof ProjectHygieneModel>

// -- setup ---------------------------------------------------------------------------------------------------------------

/** One key of `project.yaml`: where it sits, what the schema says it means, and the value in force. */
export const ProjectSetupField = z
  .strictObject({
    /** the key's path in the file (`deploy.hold`) */
    path: z.string(),
    /** the schema's description of the key; empty when it has none */
    description: z.string(),
    /** the value in force: a scalar as text, a list or a map as YAML */
    value: z.string(),
    /** the value is the schema's default (the file does not set it, or sets what the default is) */
    isDefault: z.boolean(),
  })
  .meta({ id: 'ProjectSetupField' })
export type ProjectSetupField = z.infer<typeof ProjectSetupField>

/** `GET /v1/projects/:name/setup`: the `project.yaml` in force as a form with the schema's descriptions, and as YAML. */
export const ProjectSetupModel = z
  .strictObject({
    at,
    project: z.string(),
    source: z.enum(['file', 'defaults']),
    /** the `project.yaml` now on the default branch does not parse; the fields are the last valid one's */
    projectError: z.string().nullable(),
    /** the keys in the schema's order; a key with children is followed by them */
    fields: z.array(ProjectSetupField),
    /** the file in force with its defaults filled in, as YAML */
    yaml: z.string(),
  })
  .meta({ id: 'ProjectSetupModel' })
export type ProjectSetupModel = z.infer<typeof ProjectSetupModel>
