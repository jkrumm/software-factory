import type { StandingPolicies } from '../domains/checkpoints/ports.ts'
import { projectOf } from '../domains/planning/sync.ts'
import { ok } from '../kernel/result.ts'
import type { PlanningDeps } from './planning-deps.ts'

/**
 * The standing policy of a project: the `policy:` rules of its `project.yaml`, as last read from the default branch. A
 * repo that is no project has none, and every Decision there goes on to the Judge. `PolicyRule` is the checkpoints'
 * rule field for field.
 */
export function standingPolicies(deps: PlanningDeps): StandingPolicies {
  return {
    rulesFor: (repo) =>
      deps.uow.run(async ({ planning }) => {
        const project = projectOf(await planning.projects(), repo)
        return ok(project ? project.project.policy : [])
      }),
  }
}
