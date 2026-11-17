import {
  DigestAnswer,
  PROJECT_SHIPPED_HOURS,
  type ProjectIndexModel,
  type ProjectIndexRow,
  type ProjectMedian,
} from '@software-factory/contract'
import type { SQL } from 'bun'
import * as z from 'zod'
import { countsOf, DIGEST_WINDOW_MS, shipped as isShipped, type DigestIssue } from '../kernel/digest-scope.ts'
import { issueId } from '../kernel/ids.ts'
import { projectOf } from '../kernel/project-of.ts'
import { queueKindOf, type QueueReasons } from './flow.ts'
import type { ProjectGroups } from './project-groups.ts'
import {
  DOCUMENT_PREFIX,
  documentKeys,
  findingCount,
  iso,
  issuesOf,
  loadProjects,
  passOf,
  type Pass,
  type Project,
} from './project-page.ts'
import { percentile } from './stats.ts'

/**
 * The Projects table's one read: every project with what it has now, what it shipped by the hour, how long its Issues
 * took and waited, its production lamp, its plan, its hygiene and its newest digest. Read-only SQL; the rules of each
 * figure are the contract's (`ProjectIndexRow`).
 */

const HOUR_MS = 3_600_000
const WEEK_MS = DIGEST_WINDOW_MS
/** how far back a finding of the newest pass is looked for in earlier passes */
const FINDING_LOOKBACK_MS = 30 * 24 * HOUR_MS
/** a host sample older than this says nothing about the seats now */
const SEATS_MAX_AGE_MS = 10 * 60_000
/** `leads:` at or above this is no cap of the project's own (`DEFAULT_LEADS` of `domains/planning/project.ts`; a test holds them equal) */
export const NO_LEAD_CAP = 64

const json = (value: unknown): unknown => (typeof value === 'string' ? JSON.parse(value) : value)

const RepoAt = z.object({ repo: z.string(), at: z.date() })
const RepoMs = z.object({ repo: z.string(), at: z.date(), ms: z.coerce.number() })
const PlanRow = z.object({ name: z.string(), plan: z.unknown() })
/** the part of a stored plan this read counts (`PlanFile` of `domains/planning/plan.ts`, already checked when stored) */
const PlanFile = z.object({ rows: z.array(z.object({ key: z.string(), issue: z.number().int().min(1).optional() })) })
const Filed = z.object({ project: z.string(), row_key: z.string(), issue_id: z.string(), state: z.string() })
const Closed = z.object({ id: z.string() })
const Seats = z.object({ seats: z.number().int() })
const Latest = z.object({ project: z.string(), at: z.date(), digest: z.unknown() })
const FindingPass = z.object({ repo: z.string(), at: z.date(), keys: z.unknown(), entries: z.unknown() })

/** Rows of `repo` text grouped by the project each belongs to. */
function byProject<R extends { repo: string }>(projects: readonly Project[], rows: readonly R[]): Map<string, R[]> {
  const out = new Map<string, R[]>()
  for (const row of rows) {
    const owner = projectOf(projects, row.repo)
    if (!owner) continue
    const list = out.get(owner.name) ?? []
    list.push(row)
    out.set(owner.name, list)
  }
  return out
}

function medianOf(samples: readonly { at: Date; ms: number }[], now: Date): ProjectMedian {
  const cut = now.getTime() - WEEK_MS
  const recent = samples.filter((s) => s.at.getTime() >= cut).map((s) => s.ms)
  const before = samples.filter((s) => s.at.getTime() < cut).map((s) => s.ms)
  return { ms: percentile(recent, 0.5), n: recent.length, beforeMs: percentile(before, 0.5), beforeN: before.length }
}

/** Shipped per hour, oldest first, the last hour ending at `now`. */
function shippedHours(issues: readonly DigestIssue[], now: Date): number[] {
  const hours = Array<number>(PROJECT_SHIPPED_HOURS).fill(0)
  for (const issue of issues) {
    if (!isShipped(issue)) continue
    const age = Math.floor((now.getTime() - issue.at.getTime()) / HOUR_MS)
    if (age < 0 || age >= PROJECT_SHIPPED_HOURS) continue
    const slot = PROJECT_SHIPPED_HOURS - 1 - age
    hours[slot] = (hours[slot] ?? 0) + 1
  }
  return hours
}

/** A pass's finding keys: the probes' and the document judgment's. */
const keysOf = (pass: Pass): Set<string> => new Set([...pass.report.findings.map((f) => f.key), ...documentKeys(pass)])

/** The first pass that raised a key the newest pass still raises; null when the newest raises none. */
function oldestFindingAt(newest: Pass, earlier: readonly { at: Date; keys: Set<string> }[]): Date | null {
  const keys = keysOf(newest)
  if (keys.size === 0) return null
  let oldest = newest.at
  for (const pass of earlier) if (pass.at < oldest && [...keys].some((k) => pass.keys.has(k))) oldest = pass.at
  return oldest
}

/** The hygiene figures of the newest pass: probes clean of probes run, and the oldest finding still raised. */
function hygieneOf(pass: Pass | undefined, earlier: readonly { at: Date; keys: Set<string> }[]) {
  const runs = pass?.report.runs.filter((r) => r.outcome !== 'skipped') ?? []
  const found = pass ? oldestFindingAt(pass, earlier) : null
  return {
    lastPassAt: pass ? iso(pass.at) : null,
    outcome: pass?.judgment.outcome ?? null,
    findings: pass ? findingCount(pass) : 0,
    clean: runs.filter((r) => r.outcome === 'clean').length,
    run: runs.length,
    oldestFindingAt: found ? iso(found) : null,
  }
}

/** Plan rows done of all rows, per project: a row is done when its Issue (adopted or filed) is closed, as `rowStatuses` says. */
async function plansOf(sql: SQL): Promise<Map<string, { done: number; total: number }>> {
  const plans = ((await sql`SELECT name, plan FROM factory.planning_projects WHERE plan IS NOT NULL`) as unknown[]).map(
    (raw) => PlanRow.parse(raw),
  )
  const filed = (
    (await sql`
    SELECT f.project, f.row_key, f.issue_id, i.state FROM factory.planning_filed_rows f
    JOIN factory.issues i ON i.id = f.issue_id`) as unknown[]
  ).map((raw) => Filed.parse(raw))
  const filedBy = new Map(filed.map((row) => [`${row.project}:${row.row_key}`, row]))
  const adopted = plans.flatMap((p) => {
    const parsed = PlanFile.safeParse(json(p.plan))
    return parsed.success ? parsed.data.rows.flatMap((r) => (r.issue === undefined ? [] : [issueId(r.issue)])) : []
  })
  const closed = new Set(
    adopted.length === 0
      ? []
      : ((await sql`SELECT id FROM factory.issues WHERE state = 'closed' AND id IN ${sql(adopted)}`) as unknown[]).map(
          (raw) => Closed.parse(raw).id,
        ),
  )
  const out = new Map<string, { done: number; total: number }>()
  for (const p of plans) {
    const parsed = PlanFile.safeParse(json(p.plan))
    if (!parsed.success) continue
    const done = parsed.data.rows.filter((row) =>
      row.issue === undefined
        ? filedBy.get(`${p.name}:${row.key}`)?.state === 'closed'
        : closed.has(issueId(row.issue)),
    ).length
    out.set(p.name, { done, total: parsed.data.rows.length })
  }
  return out
}

const bullets = (list: readonly { text: string }[]): string[] => list.map((b) => b.text)

/** Every project of the Projects table. Read-only SQL; `groups` files each under the owner's Herdr groups. */
export async function readProjectIndex(
  sql: SQL,
  options: {
    now: Date
    groups: ProjectGroups
    /** why each queued Issue stays queued: Ready or Held */ queue?: QueueReasons
  },
): Promise<ProjectIndexModel> {
  const { now, groups } = options
  const projects = await loadProjects(sql)
  const issues = await issuesOf(sql, projects, now)
  const twoWeeks = new Date(now.getTime() - 2 * WEEK_MS)
  const weekAgo = new Date(now.getTime() - WEEK_MS)

  const passRows: unknown[] = await sql`SELECT DISTINCT ON (repo) * FROM factory.hygiene_passes ORDER BY repo, at DESC`
  const newest = new Map<string, Pass>()
  for (const pass of passRows.map(passOf)) {
    const owner = projectOf(projects, pass.repo)
    const seen = owner ? newest.get(owner.name) : undefined
    if (owner && (!seen || seen.at < pass.at)) newest.set(owner.name, pass)
  }
  const findingRows: unknown[] = await sql`
    SELECT repo, at, report->'findings' AS keys, coalesce(filed, '[]'::jsonb) || coalesce(over_budget, '[]'::jsonb) || coalesce(failed, '[]'::jsonb) AS entries
    FROM factory.hygiene_passes WHERE at >= ${new Date(now.getTime() - FINDING_LOOKBACK_MS)}`
  const earlier = byProject(
    projects,
    findingRows.map((raw) => {
      const row = FindingPass.parse(raw)
      const found = z
        .array(z.object({ key: z.string() }))
        .catch([])
        .parse(json(row.keys) ?? [])
      const entries = z
        .array(z.object({ key: z.string() }))
        .catch([])
        .parse(json(row.entries) ?? [])
      const keys = new Set([...found, ...entries.filter((e) => e.key.startsWith(DOCUMENT_PREFIX))].map((e) => e.key))
      return { repo: row.repo, at: row.at, keys }
    }),
  )

  const lastShips = byProject(
    projects,
    (
      (await sql`
      SELECT i.repo, max(e.at) AS at FROM factory.issue_events e JOIN factory.issues i ON i.id = e.issue_id
      WHERE e.result = 'applied' AND e.to_state = 'closed' AND i.state = 'closed' AND i.outcome IN ('done', 'healed')
      GROUP BY i.repo`) as unknown[]
    ).map((raw) => RepoAt.parse(raw)),
  )
  // the KPIs' own definitions (`read/kpis.ts` cycleTimes, queueWaits), per project, over two weeks
  const cycles = byProject(
    projects,
    (
      (await sql`
      SELECT i.repo, c.at, extract(epoch FROM (c.at - f.at)) * 1000 AS ms
      FROM factory.issue_events c
      JOIN factory.issue_events f ON f.issue_id = c.issue_id AND f.kind = 'filed' AND f.version = 1
      JOIN factory.issues i ON i.id = c.issue_id
      WHERE c.result = 'applied' AND c.to_state = 'closed' AND c.at >= ${twoWeeks} AND c.at < ${now}`) as unknown[]
    ).map((raw) => RepoMs.parse(raw)),
  )
  const waits = byProject(
    projects,
    (
      (await sql`
      SELECT i.repo, a.at, extract(epoch FROM (a.at - s.at)) * 1000 AS ms
      FROM factory.issue_events a
      JOIN factory.issues i ON i.id = a.issue_id
      JOIN LATERAL (
        SELECT x.at FROM factory.issue_events x
        WHERE x.issue_id = a.issue_id AND x.result = 'applied' AND x.kind IN ('filed', 'reopened') AND x.version < a.version
        ORDER BY x.version DESC LIMIT 1
      ) s ON true
      WHERE a.kind = 'admitted' AND a.result = 'applied' AND a.at >= ${twoWeeks} AND a.at < ${now}`) as unknown[]
    ).map((raw) => RepoMs.parse(raw)),
  )
  const incidents = byProject(
    projects,
    (
      (await sql`
      SELECT i.repo, n.opened_at AS at FROM factory.intake_incidents n JOIN factory.issues i ON i.id = n.issue_id
      WHERE i.state <> 'closed'`) as unknown[]
    ).map((raw) => RepoAt.parse(raw)),
  )
  const regressions = byProject(
    projects,
    (
      (await sql`
      SELECT i.repo, max(e.at) AS at FROM factory.issue_events e JOIN factory.issues i ON i.id = e.issue_id
      WHERE e.kind = 'regressed' AND e.result = 'applied' AND e.at >= ${weekAgo}
      GROUP BY i.repo`) as unknown[]
    ).map((raw) => RepoAt.parse(raw)),
  )
  const plans = await plansOf(sql)
  const seatRows: unknown[] = await sql`
    SELECT seats FROM factory.host_samples
    WHERE seats IS NOT NULL AND at >= ${new Date(now.getTime() - SEATS_MAX_AGE_MS)} ORDER BY at DESC LIMIT 1`
  const digestRows: unknown[] = await sql`
    SELECT DISTINCT ON (project) project, at, digest FROM factory.project_digests ORDER BY project, at DESC, id DESC`
  const digests = new Map(digestRows.map((raw) => Latest.parse(raw)).map((row) => [row.project, row]))

  const latest = (rows: readonly { at: Date }[] | undefined): Date | null =>
    (rows ?? []).reduce<Date | null>((max, r) => (max === null || r.at > max ? r.at : max), null)
  const earliest = (rows: readonly { at: Date }[] | undefined): Date | null =>
    (rows ?? []).reduce<Date | null>((min, r) => (min === null || r.at < min ? r.at : min), null)
  const digestOf = (name: string): ProjectIndexRow['digest'] => {
    const stored = digests.get(name)
    if (!stored) return null
    const answer = DigestAnswer.safeParse(json(stored.digest))
    if (!answer.success) return null
    return {
      at: iso(stored.at),
      headline: answer.data.headline,
      shipped: bullets(answer.data.shipped),
      next: bullets(answer.data.next),
      risks: bullets(answer.data.risks),
    }
  }
  const at = (date: Date | null): string | null => (date ? iso(date) : null)

  return {
    at: iso(now),
    seats: seatRows.length > 0 ? Seats.parse(seatRows[0]).seats : null,
    groups: groups.order,
    projects: projects.map((project): ProjectIndexRow => {
      const own = issues.get(project.name) ?? []
      const cap = project.stored.leads
      return {
        name: project.name,
        work: project.work,
        source: project.source,
        branch: project.branch,
        group: groups.of(project),
        counts: countsOf(own, now, queueKindOf(options.queue)),
        hygiene: hygieneOf(newest.get(project.name), earlier.get(project.name) ?? []),
        shipped: { hours: shippedHours(own, now), lastAt: at(latest(lastShips.get(project.name))) },
        cycle: medianOf(cycles.get(project.name) ?? [], now),
        queueWait: medianOf(waits.get(project.name) ?? [], now),
        production: {
          incidents: incidents.get(project.name)?.length ?? 0,
          incidentAt: at(earliest(incidents.get(project.name))),
          regressionAt: at(latest(regressions.get(project.name))),
        },
        plan: plans.get(project.name) ?? { done: 0, total: 0 },
        leads: {
          running: own.filter((i) => i.state === 'working').length,
          cap: cap > 0 && cap < NO_LEAD_CAP ? cap : null,
        },
        digest: digestOf(project.name),
      }
    }),
  }
}
