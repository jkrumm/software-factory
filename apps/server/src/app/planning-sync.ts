import type { ProjectSource, RepoRef } from '../domains/planning/ports.ts'
import { projectName, projectOf, repoTextOf, synced, type StoredProject } from '../domains/planning/sync.ts'
import { key } from '../kernel/keys.ts'
import { err, ok, portError, type PortError, type Result } from '../kernel/result.ts'
import type { WorkStore } from '../domains/work/ports.ts'
import { fileIn, recordIn } from './issues.ts'
import type { PlanningDeps } from './planning-deps.ts'
import type { SeatRoles } from './seat.ts'

export interface SyncDeps extends PlanningDeps {
  source: ProjectSource
  /** the role table, for a plan row whose seat names a role */
  roles: SeatRoles
}

export interface BrokenFile {
  project: string
  file: 'project.yaml' | 'docs/plan.yaml'
  message: string
  /** the Issue filed for a broken `project.yaml` */
  issue: string | null
}

export interface SyncResult {
  synced: number
  broken: BrokenFile[]
  /** repos that could not be read this time; their rows are left as they were */
  errors: string[]
}

/**
 * Reads the project files of every repo the factory knows from their default branches, and stores what they say. The
 * repos are the ones under the repo roots that have a `project.yaml`, the ones already stored, and the ones an open
 * Issue names. All reading happens before any transaction (the ports), then every project is written in one. A repo
 * that cannot be read keeps its row; a file that does not parse keeps the last valid content and records the error,
 * and a broken `project.yaml` files one Issue per content.
 */
export async function syncProjects(
  deps: SyncDeps,
  options: { fetch: boolean },
): Promise<Result<SyncResult, PortError>> {
  const known = await deps.uow.run(async ({ planning, reads }) =>
    ok({ projects: await planning.projects(), open: await reads.open() }),
  )
  if (!known.ok) return known

  const errors: string[] = []
  const refs = new Map<string, RepoRef>()
  const add = (ref: RepoRef) => refs.set(ref.path, ref)
  const discovered = await deps.source.discover()
  if (discovered.ok) discovered.value.forEach(add)
  else errors.push(`discover: ${discovered.error.detail}`)
  for (const project of known.value.projects) {
    add({ directory: project.name.split('~')[0] ?? project.name, path: project.repo })
  }
  for (const repo of new Set(known.value.open.map((issue) => issue.repo))) {
    if (projectOf(known.value.projects, repo)) continue
    const resolved = await deps.source.resolve(repo)
    if (!resolved.ok) errors.push(`${repo}: ${resolved.error.detail}`)
    else if (resolved.value) add(resolved.value)
  }

  const reads: { ref: RepoRef; read: Awaited<ReturnType<ProjectSource['read']>> & { ok: true } }[] = []
  for (const ref of refs.values()) {
    const read = await deps.source.read(ref, options)
    if (read.ok) reads.push({ ref, read })
    else errors.push(`${ref.path}: ${read.error.detail}`)
  }

  const stored = await deps.uow.run(async ({ work, planning }) => {
    const projects = await planning.projects()
    const taken = new Map(projects.map((p) => [p.name, p.repo]))
    const broken: BrokenFile[] = []
    const now = deps.clock.now()
    for (const { ref, read } of reads) {
      const name = projectName(ref.directory, ref.path, taken)
      const previous = projects.find((p) => p.repo === ref.path) ?? null
      const next = synced({
        previous,
        name: previous?.name ?? name,
        directory: ref.directory,
        repo: ref.path,
        read: read.value,
        now,
      })
      taken.set(next.name, next.repo)
      await planning.saveProject(next)
      if (next.planError && next.planError.sha !== previous?.planError?.sha) {
        broken.push({ project: next.name, file: 'docs/plan.yaml', message: next.planError.message, issue: null })
      }
      if (next.projectError) {
        const issue = await fileBrokenProject(work, deps, next)
        if (!issue.ok) return issue
        broken.push({
          project: next.name,
          file: 'project.yaml',
          message: next.projectError.message,
          issue: issue.value,
        })
      }
    }
    return ok({ synced: reads.length, broken, errors })
  })
  return stored
}

/** One Issue per content of a broken `project.yaml`: the same content again finds that Issue, changed content that is still broken files another. */
async function fileBrokenProject(
  work: WorkStore,
  deps: PlanningDeps,
  project: StoredProject,
): Promise<Result<string | null, PortError>> {
  const error = project.projectError
  if (!error?.sha) return ok(null)
  const filed = await fileIn(work, deps, {
    key: key('project-error', project.name, error.sha),
    event: {
      kind: 'filed',
      payload: {
        repo: repoTextOf(project),
        title: `project.yaml of ${project.name} does not parse`,
        kind: 'chore',
        origin: 'factory',
      },
      actor: 'factory',
    },
  })
  if (!filed.ok) return err(portError('refused', JSON.stringify(filed.error)))
  const issue = filed.value.issue
  if (filed.value.result === 'applied') {
    const noted = await recordIn(work, deps, {
      issueId: issue.id,
      key: key('noted', issue.id),
      event: { kind: 'noted', payload: { text: error.message }, actor: 'factory' },
    })
    if (!noted.ok) return err(portError('refused', JSON.stringify(noted.error)))
    const settled = await recordIn(work, deps, {
      issueId: issue.id,
      key: key('settled', issue.id),
      event: { kind: 'settled', payload: {}, actor: 'factory' },
    })
    if (!settled.ok) return err(portError('refused', JSON.stringify(settled.error)))
  }
  return ok(issue.id)
}
