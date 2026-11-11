import type { PlanningStore } from '../domains/planning/ports.ts'
import { durationMs, type ProjectFile } from '../domains/planning/project.ts'
import { projectOf } from '../domains/planning/sync.ts'
import type { Projects } from '../domains/quality/ports.ts'
import type { ProjectChecks } from '../domains/quality/watch.ts'
import { ok } from '../kernel/result.ts'
import type { UnitOfWork } from './unit-of-work.ts'

export interface ProjectChecksDeps {
  uow: UnitOfWork<{ planning: PlanningStore }>
  /** what a repo without a `project.yaml` runs on: its Makefile */
  fallback: Projects
}

/** The one `make` target the watch's verify runs. */
const MAKE_VERIFY = 'make verify'

/**
 * What a synced `project.yaml` says of the watch: the deploy mode, the hold as the window, `make verify` when a target
 * names it (any other `make <target>` runs as well, never dropped), and an HTTP probe for every target that verifies by URL and for every probe of the file. `makeVerify` is
 * `undefined` where the file names no target, so the caller can fall back to what the Makefile offers.
 */
export function checksOfFile(project: ProjectFile): Omit<ProjectChecks, 'makeVerify'> & { makeVerify?: boolean } {
  const { targets, hold, mode, probes } = project.deploy
  const makeTargets = targets.flatMap((target) => {
    const named = /^make (\S+)$/.exec(target.verify)?.[1]
    return named && named !== 'verify' ? [named] : []
  })
  return {
    windowMs: durationMs(hold) ?? 0,
    deployMode: mode,
    ...(targets.length > 0 ? { makeVerify: targets.some((target) => target.verify === MAKE_VERIFY) } : {}),
    ...(makeTargets.length > 0 ? { makeTargets: [...new Set(makeTargets)] } : {}),
    ...(project.ship.some((rule) => rule.via === 'pr') ? { ci: true } : {}),
    probes: [
      ...targets
        .filter((target) => /^https?:\/\//.test(target.verify))
        .map((target) => ({ name: target.name, http: target.verify, expect: 200 })),
      ...probes,
    ],
  }
}

/**
 * The watch's `Projects`: the project file the factory already synced when the repo has one, the Makefile otherwise.
 * Deploy mode, hold and probes are the file's, so a repo whose push deploys through CI (`auto`) is never asked for
 * `make version`. A file that names no target leaves verify to the Makefile, as it was before the file was read. A repo
 * that is not a project, or has no `project.yaml`, behaves as it always has.
 */
export function projectFileProjects(deps: ProjectChecksDeps): Projects {
  return {
    async checksOf(repo) {
      const known = await deps.uow.run(async ({ planning }) => ok(await planning.projects()))
      if (!known.ok) return known
      const project = projectOf(known.value, repo)
      if (project?.source !== 'file') return deps.fallback.checksOf(repo)
      const checks = checksOfFile(project.project)
      if (checks.makeVerify !== undefined) return ok({ ...checks, makeVerify: checks.makeVerify })
      const makefile = await deps.fallback.checksOf(repo)
      if (!makefile.ok) return makefile
      return ok({ ...checks, makeVerify: makefile.value.makeVerify })
    },
  }
}
