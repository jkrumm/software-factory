import type { StoredProject } from '../domains/planning/sync.ts'
import { ok, type PortError, type Result } from '../kernel/result.ts'
import type { PlanningDeps } from './planning-deps.ts'
import { type PlanView, planViews } from './planning-pass.ts'

export interface ProjectState {
  project: StoredProject
  /** its plan with the state of every row; null: no plan on the default branch */
  plan: PlanView | null
}

/** Every project the factory has read, with its plan rows as they stand. Reads only. */
export async function projectStates(deps: PlanningDeps): Promise<Result<ProjectState[], PortError>> {
  return deps.uow.run(async (stores) => {
    const projects = await stores.planning.projects()
    const plans = await planViews(stores, deps.clock.now())
    return ok(projects.map((project) => ({ project, plan: plans.find((p) => p.project === project.name) ?? null })))
  })
}
