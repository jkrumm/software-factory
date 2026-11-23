import { createHash } from 'node:crypto'
import { type PlanFile, parsePlan } from './plan.ts'
import { defaultProject, parseProject, type ProjectFile } from '@software-factory/contract/project'

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
  /** the host-local project file of the repo (`FACTORY_PROJECTS_DIR`), read whatever the branch holds; absent when none is set up */
  hostFile?: FileRead
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
  /** `file`: the last valid `project.yaml` of the default branch; `local`: the last valid host-local file, for a repo with no committed one; `defaults`: there is none (or never was) */
  source: 'file' | 'local' | 'defaults'
  /** the project in force, defaults filled in */
  project: ProjectFile
  projectSha: string | null
  /** the content now on the default branch does not parse; `project` is the last valid one */
  projectError: FileError | null
  /** what reading `project.yaml` changed without refusing it: a `leads` clamped to its bound */
  projectWarnings: string[]
  plan: PlanFile | null
  planSha: string | null
  planError: FileError | null
  planWarnings: string[]
  branch: string | null
  syncedAt: Date | null
}

/** What `project show` says when both a committed `project.yaml` and a host-local file exist. */
const SHADOWED = 'a host-local project file exists for this repo and is ignored: the committed project.yaml wins'

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** The key of a second directory of a name already taken: `<name>~<first 8 hex of the sha-256 of its path>`. */
const suffixedName = (name: string, path: string): string => `${name}~${sha256(path).slice(0, 8)}`

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
 * error; no `project.yaml` puts the project back on the defaults, unless the host holds a local file for the repo, which
 * then stands in for it; a committed file always wins over the local one. No plan means no plan.
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
    projectWarnings: [],
    plan: null,
    planSha: null,
    planError: null,
    planWarnings: [],
    branch: null,
    syncedAt: null,
  }
  const next: StoredProject = { ...base, repo: input.repo, branch: read.branch, syncedAt: input.now }

  const local = read.hostFile ?? { state: 'absent' as const }
  const committed = read.project
  // a committed file wins; the local one speaks only for a repo whose default branch has none
  const file = committed.state === 'absent' ? local : committed
  const from = committed.state === 'absent' && local.state !== 'absent' ? 'local' : 'file'
  if (file.state === 'absent') {
    Object.assign(next, {
      source: 'defaults',
      project: defaultProject(input.directory),
      projectSha: null,
      projectError: null,
      projectWarnings: [],
    })
  } else if (file.state === 'unreadable') {
    next.projectError = {
      message: from === 'local' ? `host-local project file: ${file.message}` : file.message,
      sha: file.sha,
    }
  } else {
    const parsed = parseProject(file.value, input.directory)
    if (parsed.ok) {
      Object.assign(next, {
        source: from,
        project: parsed.project,
        projectSha: file.sha,
        projectError: null,
        projectWarnings: [...parsed.warnings, ...(from === 'file' && local.state !== 'absent' ? [SHADOWED] : [])],
      })
    } else {
      next.projectError = {
        message: from === 'local' ? `host-local project file: ${parsed.message}` : parsed.message,
        sha: file.sha,
      }
    }
  }

  const plan = read.plan
  if (plan.state === 'absent') {
    Object.assign(next, { plan: null, planSha: null, planError: null, planWarnings: [] })
  } else if (plan.state === 'unreadable') {
    next.planError = { message: plan.message, sha: plan.sha }
  } else {
    const parsed = parsePlan(plan.value, Object.keys(next.project.lanes))
    if (parsed.ok) {
      Object.assign(next, { plan: parsed.plan, planSha: plan.sha, planError: null, planWarnings: parsed.warnings })
    } else {
      next.planError = { message: parsed.message, sha: plan.sha }
    }
  }
  return next
}

/**
 * What an Issue's `repo` says for this project: the directory's name under the source root, which is what intake files
 * Issues with and what a lead locates a repo by. A second directory of a name has a project name no directory carries,
 * so its Issues name the absolute path.
 */
export const repoTextOf = (project: Pick<StoredProject, 'name' | 'repo'>): string =>
  project.name.includes('~') ? project.repo : project.name

export { projectOf } from '../../kernel/project-of.ts'

/**
 * The name a repo text goes by when no project claims it: a name as it is; a path, or a linked worktree below one
 * (`<repo>/.claude/worktrees/<name>`), by the directory name of its main checkout. Never a path, so one project is one
 * string wherever it is stored or counted.
 */
export function repoNameOf(text: string): string {
  if (!text.startsWith('/')) return text
  const main = (text.split('/.claude/worktrees/')[0] ?? text).replace(/\/+$/, '')
  return main.slice(main.lastIndexOf('/') + 1) || text
}
