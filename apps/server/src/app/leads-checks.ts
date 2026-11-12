import type { Checks } from '../domains/leads/ports.ts'
import { projectOf } from '../domains/planning/sync.ts'
import type { PlanningStore } from '../domains/planning/ports.ts'
import { ok } from '../kernel/result.ts'
import type { UnitOfWork } from './unit-of-work.ts'

/** The check tiers of the project a repo path belongs to, read from the stored project: the one in force, not a worktree's copy. */
export function storedChecks(uow: UnitOfWork<{ planning: PlanningStore }>): Checks {
  return {
    of: (repo) =>
      uow.run(async ({ planning }) => ok(projectOf(await planning.projects(), repo)?.project.checks ?? null)),
  }
}
