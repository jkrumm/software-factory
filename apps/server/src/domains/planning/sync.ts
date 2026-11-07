import { createHash } from 'node:crypto'
import { type PlanFile, parsePlan } from './plan.ts'
import { defaultProject, parseProject, type ProjectFile } from './project.ts'

/** What reading one file of a repo's default branch came back with. */
export type FileRead =
  | { state: 'absent' }
  /** the file parsed as YAML */
  | { state: 'text'; sha: string; value: unknown }
  /** the file is there and cannot be used: not YAML, not a regular file, larger than the limit */
  | { state: 'unreadable'; sha: string | null; message: string }

/** `project.yaml` and `docs/plan.yaml` as they stand on a repo's default branch. */
export interface RepoRead {
  branch: string
  project: FileRead
  plan: FileRead
}

export interface FileError {
  message: string
  /** the content's hash: the same broken content is one finding, changed content that is still broken is another */
  sha: string | null
}

/** A project as the factory stores it. */
export interface StoredProject {
  /** the directory's name; `<name>~<hash>` for a second directory of that name */
  name: string
  /** the repo's absolute path */
  repo: string
  /** `file`: the last valid `project.yaml`; `defaults`: there is none (or never was) */
  source: 'file' | 'defaults'
  /** the project in force, defaults filled in */
  project: ProjectFile
  projectSha: string | null
  /** the content now on the default branch does not parse; `project` is the last valid one */
  projectError: FileError | null
  plan: PlanFile | null
  planSha: string | null
  planError: FileError | null
  planWarnings: string[]
  branch: string | null
  syncedAt: Date | null
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** The key of a second directory of a name already taken: `<name>~<first 8 hex of the sha-256 of its path>`. */
export const suffixedName = (name: string, path: string): string => `${name}~${sha256(path).slice(0, 8)}`

/**
 * The name a repo goes by: its directory's name, unless another path holds that name already (the one stored first
 * keeps it, and a stored repo keeps its name whatever is added later).
 */
export function projectName(directory: string, path: string, taken: ReadonlyMap<string, string>): string {
  const holder = taken.get(directory)
  return holder === undefined || holder === path ? directory : suffixedName(directory, path)
}

/**
 * The stored project after a read of its repo. A file that does not parse keeps the last valid content and records the
 * error; no `project.yaml` puts the project back on the defaults; no plan means no plan.
 */
export function synced(input: {
  previous: StoredProject | null
  name: string
  directory: string
  repo: string
  read: RepoRead
  now: Date
}): StoredProject {
  const { previous, read } = input
  const base: StoredProject = previous ?? {
    name: input.name,
    repo: input.repo,
    source: 'defaults',
    project: defaultProject(input.directory),
    projectSha: null,
    projectError: null,
    plan: null,
    planSha: null,
    planError: null,
    planWarnings: [],
    branch: null,
    syncedAt: null,
  }
  const next: StoredProject = { ...base, repo: input.repo, branch: read.branch, syncedAt: input.now }

  const file = read.project
  if (file.state === 'absent') {
    Object.assign(next, {
      source: 'defaults',
      project: defaultProject(input.directory),
      projectSha: null,
      projectError: null,
    })
  } else if (file.state === 'unreadable') {
    next.projectError = { message: file.message, sha: file.sha }
  } else {
    const parsed = parseProject(file.value, input.directory)
    if (parsed.ok) {
      Object.assign(next, { source: 'file', project: parsed.project, projectSha: file.sha, projectError: null })
    } else {
      next.projectError = { message: parsed.message, sha: file.sha }
    }
  }

  const plan = read.plan
  if (plan.state === 'absent') {
    Object.assign(next, { plan: null, planSha: null, planError: null, planWarnings: [] })
  } else if (plan.state === 'unreadable') {
    next.planError = { message: plan.message, sha: plan.sha }
  } else {
    const parsed = parsePlan(plan.value)
    if (parsed.ok) {
      Object.assign(next, { plan: parsed.plan, planSha: plan.sha, planError: null, planWarnings: parsed.warnings })
    } else {
      next.planError = { message: parsed.message, sha: plan.sha }
    }
  }
  return next
}

/** The project a repo text (a project name, a path, a worktree below a path) belongs to: the longest repo wins. */
export function projectOf(projects: readonly StoredProject[], repo: string): StoredProject | undefined {
  const byName = projects.find((p) => p.name === repo)
  if (byName) return byName
  return projects
    .filter((p) => repo === p.repo || repo.startsWith(`${p.repo}/`))
    .sort((a, b) => b.repo.length - a.repo.length)[0]
}
