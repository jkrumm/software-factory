import type { Checks } from '../domains/leads/ports.ts'
import { projectOf } from '../domains/planning/sync.ts'
import type { PlanningStore } from '../domains/planning/ports.ts'
import { ok } from '../kernel/result.ts'
import type { UnitOfWork } from './unit-of-work.ts'

/**
 * The check tiers and the `env` of the project a repo path belongs to, read from the stored project: the one in force, not a
 * worktree's copy. A work repo's lead also gets `GH_CONFIG_DIR` (`FACTORY_GH_CONFIG_DIR_WORK`) so every `gh` it or its children
 * start (`factory land` included) runs as the work account: a shell function that picks the account never reaches a child process.
 * The same rule the reviews loop uses for a work repo; the project's own `env` wins.
 */
export function storedChecks(
  uow: UnitOfWork<{ planning: PlanningStore }>,
  options: { workGhConfigDir?: string | null } = {},
): Checks {
  return {
    of: (repo) =>
      uow.run(async ({ planning }) => ok(projectOf(await planning.projects(), repo)?.project.checks ?? null)),
    env: (repo) =>
      uow.run(async ({ planning }) => {
        const project = projectOf(await planning.projects(), repo)
        const work = project ? project.source === 'defaults' || project.project.work : false
        const account: Record<string, string> =
          work && options.workGhConfigDir ? { GH_CONFIG_DIR: options.workGhConfigDir } : {}
        return ok({ ...account, ...(project?.project.env ?? {}) })
      }),
  }
}
