import type { SQL } from 'bun'
import * as z from 'zod'

/** What a work-repo item says under the read token: the ids, kinds and times stay, the words go. */
export const REDACTED_TITLE = 'Work in a private repository'
export const REDACTED_SUMMARY = 'The text of work in a private repository is not shown here.'
export const REDACTED_REPO = 'private'

/** A project the factory reads from its own `project.yaml`: its repo text is the owner's, not the work account's. */
export interface OpenProject {
  name: string
  repo: string
}

const Project = z.object({ name: z.string(), repo: z.string() })

/** The projects with a `project.yaml` of their own. */
export async function loadOpenProjects(sql: SQL): Promise<OpenProject[]> {
  const rows: unknown[] = await sql`SELECT name, repo FROM factory.planning_projects WHERE source = 'file'`
  return rows.map((raw) => Project.parse(raw))
}

/**
 * Whether a repo is a work repo: it belongs to no project with a `project.yaml` of its own (a project with defaults, or
 * a repo the factory does not know). Fails closed: text of a repo nobody listed is not shown to the read token. This is
 * the one rule; the SQL in `issues.ts` and `sessions.ts` says the same thing in a WHERE clause and a test holds them equal.
 */
export function isWorkRepo(repo: string | null, open: readonly OpenProject[]): boolean {
  if (repo === null) return false
  return !open.some((p) => p.name === repo || p.repo === repo || repo.startsWith(`${p.repo}/`))
}
