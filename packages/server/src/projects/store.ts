import {
  defaultManifest,
  isProjectDirName,
  type Project,
  type ProjectManifest,
  type MakeTargets,
} from '@software-factory/contract'
import { basename } from 'node:path'
import type { SQL } from 'bun'

interface ProjectRow {
  name: string
  repo: string
  manifest: ProjectManifest | null
  manifest_sha: string | null
  manifest_error: string | null
  manifest_error_sha: string | null
  make_targets: MakeTargets | null
  paused: boolean
  synced_at: Date | null
  error_issue: number | null
  holders: number[]
  queued: number[]
}

const toProject = (row: ProjectRow): Project => {
  // The key may carry a path hash; the manifest's name is always the directory's.
  const manifest = row.manifest ?? defaultManifest(basename(row.repo))
  return {
    name: row.name,
    repo: row.repo,
    source: row.manifest ? 'manifest' : 'defaults',
    manifest,
    manifestSha: row.manifest_sha,
    manifestError:
      row.manifest_error && row.manifest_error_sha
        ? { sha: row.manifest_error_sha, message: row.manifest_error, issue: row.error_issue }
        : null,
    makeTargets: row.make_targets,
    claim: { leads: manifest.leads, holders: row.holders, queued: row.queued },
    paused: row.paused,
    syncedAt: row.synced_at?.toISOString() ?? null,
  }
}

const select = (sql: SQL, name: string | null) => sql`
  SELECT p.name, p.repo, p.manifest, p.manifest_sha, p.manifest_error, p.manifest_error_sha, p.make_targets, p.paused, p.synced_at,
    (SELECT i.id FROM factory.issues i
     WHERE i.source = 'upkeep' AND i.source_key = 'manifest:' || p.name || ':' || p.manifest_error_sha) AS error_issue,
    (SELECT COALESCE(json_agg(c.issue_id ORDER BY c.held_at, c.issue_id), '[]'::json)
     FROM factory.claims c WHERE c.key = 'repo:' || p.name AND c.held_at IS NOT NULL) AS holders,
    (SELECT COALESCE(json_agg(c.issue_id ORDER BY c.urgent DESC, c.issue_id), '[]'::json)
     FROM factory.claims c WHERE c.key = 'repo:' || p.name AND c.held_at IS NULL) AS queued
  FROM factory.projects p
  WHERE ${name}::text IS NULL OR p.name = ${name}
  ORDER BY p.name`

/** A row stored before sync refused such names: its directory cannot be a project's name, so it is not listed and `GET /projects/:name` is a 404, rather than the response failing its schema. The server's own reads (`getProject`) still see it. */
export const listable = (row: { repo: string }): boolean => isProjectDirName(basename(row.repo))

export async function listProjects(sql: SQL): Promise<Project[]> {
  const rows: ProjectRow[] = await select(sql, null)
  return rows.filter(listable).map(toProject)
}

export async function getProject(sql: SQL, name: string): Promise<Project | undefined> {
  const [row]: ProjectRow[] = await select(sql, name)
  return row && toProject(row)
}
