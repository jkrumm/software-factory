import {
  HYGIENE_OUTCOMES,
  type HygieneFindingRow,
  type HygienePassRow,
  type HygieneProbeRow,
  type ProjectCounts,
  type ProjectHygieneModel,
  type ProjectPageModel,
} from '@software-factory/contract'
import type { SQL } from 'bun'
import * as z from 'zod'
import { countsOf, DIGEST_WINDOW_MS, groupByProject, shipped, type DigestIssue } from '../kernel/digest-scope.ts'
import { projectOf } from '../kernel/project-of.ts'
import { queueKindOf, type QueueReasons } from './flow.ts'
import { loopReads } from './loops.ts'

/**
 * The project screens' read models: the list of projects, one project's page and one project's hygiene, from the stored
 * projects, their Issues (as the digests count them), the door's routes and the hygiene passes. Read-only SQL; the plan rows
 * come from `GET /v1/projects/:name/plan` and the open Issues from `GET /v1/flow`.
 */

/** The built-in probes of the hygiene loop, in its order (`PROBES` of `domains/loops/hygiene-model.ts` less `probe`; a test holds them equal). */
export const BUILT_IN_PROBES = [
  'check',
  'links',
  'retired',
  'deps',
  'cochange',
  'runrules',
  'browser',
  'context',
] as const

/** The key prefix of a finding the document judgment filed (`JUDGMENT_PREFIX` of `domains/loops/hygiene.ts`; a test holds them equal). */
export const DOCUMENT_PREFIX = 'judgment:'

const DAY_MS = 24 * 3_600_000
const SHIPPED_ITEMS = 100
const HOUR_MS = 3_600_000
const HOURS = 168
const PASSES = 5

const json = (value: unknown): unknown => (typeof value === 'string' ? JSON.parse(value) : value)

// -- the stored project --------------------------------------------------------------------------------------------------

/** The part of the stored `project.yaml` (defaults filled in) these screens show; `prefault` fills what an older row lacks. */
const StoredProject = z.object({
  work: z.boolean().prefault(false),
  leads: z.number().int().prefault(0),
  lanes: z
    .record(z.string(), z.object({ leads: z.number().int(), memoryMib: z.number().int().nullable().prefault(null) }))
    .prefault({}),
  slots: z.object({ run: z.string().optional() }).prefault({}),
  checks: z.object({ fast: z.string(), full: z.string(), ci: z.boolean() }).nullable().prefault(null),
  doctor: z.string().nullable().prefault(null),
  signals: z.record(z.string(), z.unknown()).prefault({}),
  deploy: z
    .object({
      mode: z.enum(['auto', 'make', 'agentic', 'none']).prefault('none'),
      hold: z.string().prefault('0m'),
      targets: z.array(z.object({ name: z.string(), verify: z.string() })).prefault([]),
      probes: z
        .array(z.object({ name: z.string(), http: z.string(), expect: z.number().int().prefault(200) }))
        .prefault([]),
    })
    .prefault({}),
  hygiene: z
    .object({
      check: z.boolean().prefault(true),
      reason: z.string().optional(),
      skip: z.array(z.object({ probe: z.string(), reason: z.string() })).prefault([]),
      probes: z.array(z.object({ name: z.string(), target: z.string() })).prefault([]),
    })
    .prefault({}),
})
type StoredProject = z.infer<typeof StoredProject>

const ProjectRow = z.object({
  name: z.string(),
  repo: z.string(),
  source: z.enum(['file', 'defaults']),
  project: z.unknown(),
  project_error: z.unknown(),
  branch: z.string().nullable(),
  synced_at: z.date().nullable(),
})

export interface Project {
  name: string
  repo: string
  source: 'file' | 'defaults'
  stored: StoredProject
  /** the stored project as the sync parsed it, defaults filled in; `{}` when no file was read */
  raw: Record<string, unknown>
  /** the message of the `project.yaml` that does not parse */
  error: string | null
  branch: string | null
  syncedAt: Date | null
  /** no `project.yaml` of its own, or one that says `work: true` (`read/work.ts`) */
  work: boolean
}

const messageOf = (value: unknown): string | null => {
  const parsed = z.object({ message: z.string() }).safeParse(json(value))
  return parsed.success ? parsed.data.message : null
}

export async function loadProjects(sql: SQL): Promise<Project[]> {
  const rows: unknown[] = await sql`
    SELECT name, repo, source, project, project_error, branch, synced_at FROM factory.planning_projects ORDER BY name`
  return rows.map((raw) => {
    const row = ProjectRow.parse(raw)
    const rawProject = json(row.project) ?? {}
    const stored = StoredProject.parse(rawProject)
    return {
      name: row.name,
      repo: row.repo,
      source: row.source,
      stored,
      raw: isRecord(rawProject) ? rawProject : {},
      error: messageOf(row.project_error),
      branch: row.branch,
      syncedAt: row.synced_at,
      work: row.source === 'defaults' || stored.work,
    }
  })
}

// -- the issues ---------------------------------------------------------------------------------------------------------

export async function issuesOf(sql: SQL, projects: readonly Project[], now: Date): Promise<Map<string, DigestIssue[]>> {
  // two windows: the last 7 days and the 7 before, for the shipped bars
  const issues = await loopReads(sql).digestIssues(new Date(now.getTime() - 2 * DIGEST_WINDOW_MS))
  return groupByProject(projects, issues)
}

export const iso = (date: Date): string => date.toISOString()
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// -- hygiene passes ------------------------------------------------------------------------------------------------------

const Judgment = z.object({
  outcome: z.enum(HYGIENE_OUTCOMES).prefault('skipped'),
  reason: z.string().prefault(''),
})
const Run = z.object({
  probe: z.string(),
  outcome: z.enum(['clean', 'found', 'skipped', 'failed']),
  detail: z.string().prefault(''),
})
const Found = z.object({
  probe: z.string(),
  key: z.string(),
  title: z.string(),
  count: z.number().int().prefault(1),
})
const Report = z.object({
  ref: z.string().prefault(''),
  runs: z.array(Run).prefault([]),
  findings: z.array(Found).prefault([]),
  stale: z.array(z.unknown()).prefault([]),
  slop: z.array(z.unknown()).prefault([]),
})
const Entry = z.object({ key: z.string(), title: z.string().optional(), reason: z.string().optional() })

const PassRow = z.object({
  id: z.string(),
  repo: z.string(),
  at: z.date(),
  ref: z.string(),
  report: z.unknown(),
  judgment: z.unknown(),
  filed: z.unknown(),
  over_budget: z.unknown(),
  failed: z.unknown(),
})

export interface Pass {
  id: string
  repo: string
  at: Date
  ref: string
  report: z.infer<typeof Report>
  judgment: z.infer<typeof Judgment>
  filed: z.infer<typeof Entry>[]
  overBudget: z.infer<typeof Entry>[]
  failed: z.infer<typeof Entry>[]
}

export const passOf = (raw: unknown): Pass => {
  const row = PassRow.parse(raw)
  const entries = (value: unknown) =>
    z
      .array(Entry)
      .prefault([])
      .parse(json(value) ?? [])
  return {
    id: row.id,
    repo: row.repo,
    at: row.at,
    ref: row.ref,
    report: Report.parse(json(row.report) ?? {}),
    judgment: Judgment.parse(json(row.judgment) ?? {}),
    filed: entries(row.filed),
    overBudget: entries(row.over_budget),
    failed: entries(row.failed),
  }
}

/** The entries the document judgment filed, left out or had refused: findings that are not a probe's. */
export const documentKeys = (pass: Pass): Set<string> =>
  new Set(
    [...pass.filed, ...pass.overBudget, ...pass.failed]
      .map((e) => e.key)
      .filter((key) => key.startsWith(DOCUMENT_PREFIX)),
  )

export const findingCount = (pass: Pass): number => pass.report.findings.length + documentKeys(pass).size

const passRow = (pass: Pass): HygienePassRow => ({
  id: pass.id,
  at: iso(pass.at),
  ref: pass.ref,
  judgment: { outcome: pass.judgment.outcome, reason: pass.judgment.reason },
  findings: findingCount(pass),
  filed: pass.filed.length,
})

function findingRows(pass: Pass): HygieneFindingRow[] {
  const statusOf = (key: string): Pick<HygieneFindingRow, 'status' | 'reason'> => {
    if (pass.filed.some((e) => e.key === key)) return { status: 'filed', reason: null }
    if (pass.overBudget.some((e) => e.key === key)) return { status: 'left_out', reason: null }
    const refused = pass.failed.find((e) => e.key === key)
    if (refused) return { status: 'refused', reason: refused.reason ?? null }
    return { status: 'not_filed', reason: null }
  }
  const probes = pass.report.findings.map((f): HygieneFindingRow => ({
    probe: f.probe,
    key: f.key,
    title: f.title,
    count: f.count,
    ...statusOf(f.key),
  }))
  const documents = [...documentKeys(pass)].map((key): HygieneFindingRow => {
    const title = [...pass.filed, ...pass.overBudget].find((e) => e.key === key)?.title ?? key
    return { probe: 'document', key, title, count: 1, ...statusOf(key) }
  })
  return [...probes, ...documents]
}

function probeRows(project: Project, pass: Pass | null): HygieneProbeRow[] {
  const { hygiene } = project.stored
  const runs = pass?.report.runs ?? []
  const found = (probe: string, key?: string) =>
    (pass?.report.findings ?? []).filter((f) => (key === undefined ? f.probe === probe : f.key === key)).length
  const never = 'No pass has run it yet'
  const builtIn = BUILT_IN_PROBES.map((name): HygieneProbeRow => {
    const skip = hygiene.skip.find((s) => s.probe === name)
    if (skip) return { name, declared: false, target: null, status: 'skipped', detail: skip.reason, findings: 0 }
    if (name === 'check' && !hygiene.check) {
      return { name, declared: false, target: null, status: 'skipped', detail: hygiene.reason ?? '', findings: 0 }
    }
    const run = runs.find((r) => r.probe === name)
    return {
      name,
      declared: false,
      target: null,
      status: run?.outcome ?? 'never',
      detail: run?.detail ?? never,
      findings: found(name),
    }
  })
  const declared = hygiene.probes.map((probe): HygieneProbeRow => {
    const run = runs.find((r) => r.probe === 'probe' && r.detail.startsWith(`${probe.name}:`))
    return {
      name: probe.name,
      declared: true,
      target: probe.target,
      status: run?.outcome ?? 'never',
      detail: run?.detail ?? never,
      findings: found('probe', `probe:${probe.name}`),
    }
  })
  return [...builtIn, ...declared]
}

/** The newest passes of the project, newest first: the pass's repo is the project's name or its path. */
async function passesOf(sql: SQL, project: Project, limit: number): Promise<Pass[]> {
  const rows: unknown[] = await sql`
    SELECT * FROM factory.hygiene_passes
    WHERE repo = ${project.name} OR repo = ${project.repo} OR left(repo, length(${project.repo}::text) + 1) = ${project.repo}::text || '/'
    ORDER BY at DESC LIMIT ${limit}`
  return rows.map(passOf)
}

/** One project's hygiene: each probe with its last run, the newest pass and what it found, and the last passes. Read-only SQL. */
export async function readProjectHygiene(
  sql: SQL,
  options: { now: Date; name: string; /** the read token: a work project is not found */ redact?: boolean },
): Promise<ProjectHygieneModel | null> {
  const project = projectOf(await loadProjects(sql), options.name)
  if (!project || (options.redact && project.work)) return null
  const passes = await passesOf(sql, project, PASSES)
  const last = passes[0] ?? null
  return {
    at: iso(options.now),
    project: project.name,
    skipCheck: project.stored.hygiene.check ? null : (project.stored.hygiene.reason ?? ''),
    probes: probeRows(project, last),
    lastPass: last ? passRow(last) : null,
    documents: { stale: last?.report.stale.length ?? 0, slop: last?.report.slop.length ?? 0 },
    findings: last ? findingRows(last) : [],
    passes: passes.map(passRow),
  }
}

// -- the page ------------------------------------------------------------------------------------------------------------

const IncidentRow = z.object({
  issue_id: z.string(),
  title: z.string().nullable(),
  kind: z.string().nullable(),
  opened_at: z.date(),
  state: z.string(),
})
const RegressionRow = z.object({
  issue_id: z.string(),
  title: z.string().nullable(),
  kind: z.string().nullable(),
  at: z.date(),
})
const MonitorRow = z.object({
  source: z.string(),
  monitor: z.string(),
  last_event: z.string().nullable(),
  quiet: z.number().int(),
  last_quiet_at: z.date().nullable(),
})

function shippedOf(issues: readonly DigestIssue[], now: Date): ProjectPageModel['shipped'] {
  const days = [0, 0, 0, 0, 0, 0, 0]
  const hours = Array.from({ length: HOURS }, () => 0)
  let before = 0
  const items: ProjectPageModel['shipped']['items'] = []
  const closed = issues.filter(shipped).sort((a, b) => b.at.getTime() - a.at.getTime())
  for (const issue of closed) {
    const age = Math.floor((now.getTime() - issue.at.getTime()) / DAY_MS)
    if (age < 0 || age >= 14) continue
    if (age >= 7) {
      before++
      continue
    }
    days[6 - age] = (days[6 - age] ?? 0) + 1
    const hour = HOURS - 1 - Math.floor((now.getTime() - issue.at.getTime()) / HOUR_MS)
    hours[hour] = (hours[hour] ?? 0) + 1
    if (items.length < SHIPPED_ITEMS) {
      items.push({
        id: issue.id,
        title: issue.title,
        kind: issue.kind,
        outcome: issue.outcome ?? 'done',
        closedAt: iso(issue.at),
      })
    }
  }
  return { days, hours, before, items }
}

/** One project's page: its setup, counts, what it shipped and its production facts; null when no project has the name. Read-only SQL. */
export async function readProjectPage(
  sql: SQL,
  options: {
    now: Date
    name: string
    queue?: QueueReasons
    /** the read token: a work project is not found, and no monitor names */ redact?: boolean
  },
): Promise<ProjectPageModel | null> {
  const { now } = options
  const projects = await loadProjects(sql)
  const project = projectOf(projects, options.name)
  if (!project || (options.redact && project.work)) return null
  const issues = (await issuesOf(sql, projects, now)).get(project.name) ?? []
  const since = new Date(now.getTime() - DIGEST_WINDOW_MS)
  const incidents: unknown[] = await sql`
    SELECT n.issue_id, f.payload->>'title' AS title, f.payload->>'kind' AS kind, n.opened_at, i.state
    FROM factory.intake_incidents n
    JOIN factory.issues i ON i.id = n.issue_id
    JOIN factory.issue_events f ON f.issue_id = n.issue_id AND f.kind = 'filed' AND f.version = 1
    WHERE n.opened_at >= ${since}
      AND (i.repo = ${project.name} OR i.repo = ${project.repo} OR left(i.repo, length(${project.repo}::text) + 1) = ${project.repo}::text || '/')
    ORDER BY n.opened_at DESC, n.issue_id DESC`
  const regressions: unknown[] = await sql`
    SELECT DISTINCT ON (e.issue_id) e.issue_id, f.payload->>'title' AS title, f.payload->>'kind' AS kind, e.at
    FROM factory.issue_events e
    JOIN factory.issues i ON i.id = e.issue_id
    JOIN factory.issue_events f ON f.issue_id = e.issue_id AND f.kind = 'filed' AND f.version = 1
    WHERE e.kind = 'regressed' AND e.result = 'applied' AND e.at >= ${since}
      AND (i.repo = ${project.name} OR i.repo = ${project.repo} OR left(i.repo, length(${project.repo}::text) + 1) = ${project.repo}::text || '/')
    ORDER BY e.issue_id, e.at DESC`
  const monitors: unknown[] = options.redact
    ? []
    : await sql`
    SELECT source, monitor, last_event, quiet, last_quiet_at FROM factory.intake_door_routes
    WHERE repo = ${project.name} OR repo = ${project.repo} OR left(repo, length(${project.repo}::text) + 1) = ${project.repo}::text || '/'
    ORDER BY source, monitor`
  const counts: ProjectCounts = countsOf(issues, now, queueKindOf(options.queue))
  return {
    at: iso(now),
    name: project.name,
    repo: project.repo,
    work: project.work,
    source: project.source,
    branch: project.branch,
    syncedAt: project.syncedAt ? iso(project.syncedAt) : null,
    projectError: project.error,
    counts,
    shipped: shippedOf(issues, now),
    production: {
      watching: issues
        .filter((i) => i.state === 'watching')
        .sort((a, b) => a.at.getTime() - b.at.getTime())
        .map((i) => ({ id: i.id, title: i.title, kind: i.kind, since: iso(i.at) })),
      incidents: incidents.map((raw) => {
        const row = IncidentRow.parse(raw)
        return {
          id: row.issue_id,
          title: row.title ?? row.issue_id,
          kind: row.kind ?? 'incident',
          openedAt: iso(row.opened_at),
          open: row.state !== 'closed',
        }
      }),
      regressions: regressions
        .map((raw) => RegressionRow.parse(raw))
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .map((row) => ({
          id: row.issue_id,
          title: row.title ?? row.issue_id,
          kind: row.kind ?? 'chore',
          at: iso(row.at),
        })),
      monitors: monitors.map((raw) => {
        const row = MonitorRow.parse(raw)
        return {
          source: row.source,
          monitor: row.monitor,
          lastEvent: row.last_event,
          quiet: row.quiet,
          lastQuietAt: row.last_quiet_at ? iso(row.last_quiet_at) : null,
        }
      }),
    },
  }
}
