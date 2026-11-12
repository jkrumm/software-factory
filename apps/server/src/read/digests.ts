import { DigestAnswer, type ProjectDigest, type ProjectDigestsModel } from '@software-factory/contract'
import type { SQL } from 'bun'
import * as z from 'zod'
import { countsOf, DIGEST_WINDOW_MS, groupByProject } from '../kernel/digest-scope.ts'
import { loopReads } from './loops.ts'
import { REDACTED_REPO, REDACTED_TITLE } from './work.ts'

const Project = z.object({ name: z.string(), repo: z.string(), work: z.boolean() })

const Latest = z.object({ project: z.string(), at: z.date(), digest: z.unknown() })

/**
 * The newest digest of each project with a `project.yaml` that has an Issue open or closed in the last 7 days, with its
 * counts read from the Issues now (never from the model). `redact`, the read token: a work project keeps its counts and
 * loses its words, and the work projects share one entry, as Flow's counts do. Read-only SQL.
 */
export async function readProjectDigests(
  sql: SQL,
  options: { now: Date; redact?: boolean },
): Promise<ProjectDigestsModel> {
  const { now } = options
  const projectRows: unknown[] = await sql`
    SELECT name, repo, COALESCE(project->>'work', 'false') = 'true' AS work
    FROM factory.planning_projects WHERE source = 'file' ORDER BY name`
  const projects = projectRows.map((raw) => Project.parse(raw))
  const issues = await loopReads(sql).digestIssues(new Date(now.getTime() - DIGEST_WINDOW_MS))
  const groups = groupByProject(projects, issues)
  const latestRows: unknown[] = await sql`
    SELECT DISTINCT ON (project) project, at, digest FROM factory.project_digests ORDER BY project, at DESC, id DESC`
  const latest = new Map(latestRows.map((raw) => Latest.parse(raw)).map((row) => [row.project, row]))

  const entries: ProjectDigest[] = []
  for (const project of projects) {
    const group = groups.get(project.name)
    const stored = latest.get(project.name)
    if (!group || group.length === 0 || !stored) continue
    const digest = DigestAnswer.safeParse(typeof stored.digest === 'string' ? JSON.parse(stored.digest) : stored.digest)
    if (!digest.success) continue
    const counts = countsOf(group, now)
    const hide = options.redact === true && project.work
    entries.push({
      project: hide ? REDACTED_REPO : project.name,
      at: stored.at.toISOString(),
      headline: hide ? REDACTED_TITLE : digest.data.headline,
      shipped: hide ? [] : digest.data.shipped,
      next: hide ? [] : digest.data.next,
      risks: hide ? [] : digest.data.risks,
      themes: hide ? [] : digest.data.themes,
      counts,
    })
  }
  return { at: now.toISOString(), projects: mergeHidden(entries) }
}

/** The entries of work projects (named `private`) become one: counts added, the newest digest time. */
function mergeHidden(entries: readonly ProjectDigest[]): ProjectDigest[] {
  const merged = new Map<string, ProjectDigest>()
  for (const entry of entries) {
    const seen = merged.get(entry.project)
    if (!seen || entry.project !== REDACTED_REPO) {
      merged.set(entry.project, entry)
      continue
    }
    merged.set(entry.project, {
      ...seen,
      at: seen.at > entry.at ? seen.at : entry.at,
      counts: {
        done7d: seen.counts.done7d + entry.counts.done7d,
        working: seen.counts.working + entry.counts.working,
        queued: seen.counts.queued + entry.counts.queued,
        waiting: seen.counts.waiting + entry.counts.waiting,
      },
    })
  }
  return [...merged.values()]
}
