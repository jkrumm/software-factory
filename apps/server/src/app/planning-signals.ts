import { type RepoSignalsView, signalsView } from '../domains/planning/signals.ts'
import { projectOf } from '../domains/planning/sync.ts'
import { ok, type PortError, type Result } from '../kernel/result.ts'
import type { PlanningDeps } from './planning-deps.ts'

/**
 * Planning's side of intake's `ProjectSignals` port, which is the only thing intake needs from the projects: which
 * repos are projects and which automatic sources each hears, read from the stored `project.yaml`. `RepoSignalsView` is
 * intake's `RepoSignals` field for field, so `main.ts` passes this object where intake asks for its port.
 */
export interface ProjectSignalsPort {
  find(repo: string): Promise<Result<RepoSignalsView | null, PortError>>
  /** every project with automatic sources to poll */
  polled(): Promise<Result<RepoSignalsView[], PortError>>
  /** the names of the projects that are not work repos, sorted */
  names(): Promise<Result<string[], PortError>>
}

export function projectSignals(deps: PlanningDeps): ProjectSignalsPort {
  return {
    find: (repo) =>
      deps.uow.run(async ({ planning }) => {
        const project = projectOf(await planning.projects(), repo)
        return ok(project ? signalsView(project) : null)
      }),
    polled: () =>
      deps.uow.run(async ({ planning }) => {
        const views = (await planning.projects()).map(signalsView)
        return ok(views.filter((view) => view.sources.length > 0))
      }),
    names: () =>
      deps.uow.run(async ({ planning }) => {
        const views = (await planning.projects()).map(signalsView)
        return ok(
          views
            .filter((view) => !view.work)
            .map((view) => view.repo)
            .sort(),
        )
      }),
  }
}
