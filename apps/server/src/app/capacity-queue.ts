import type { Relearn } from '../domains/capacity/ports.ts'
import {
  PROJECT_PRIO_MAX,
  PROJECT_PRIO_MIN,
  type QueueState,
  type QueueStates,
} from '../domains/capacity/queue-state.ts'
import { err, ok, portError, type PortError, type Result } from '../kernel/result.ts'
import type { PlanningDeps } from './planning-deps.ts'

/** Sets the state of a scope: the whole queue (`project` null) or one project. A lifted `drain` takes effect at the next pass. */
export async function setQueueState(
  deps: PlanningDeps,
  input: { project: string | null; state: QueueState },
): Promise<Result<QueueStates, PortError>> {
  return deps.uow.run(async ({ capacity }) => {
    await capacity.lock()
    await capacity.setQueueState(input.project, input.state, deps.clock.now())
    return ok(await capacity.queueStates())
  })
}

/** Sets a project's priority, an integer in an Issue's range; its queue state stays as it is. */
export async function setProjectPrio(
  deps: PlanningDeps,
  input: { project: string; prio: number },
): Promise<Result<QueueStates, PortError>> {
  if (!Number.isInteger(input.prio) || input.prio < PROJECT_PRIO_MIN || input.prio > PROJECT_PRIO_MAX) {
    return err(
      portError('refused', `a project priority is a whole number from ${PROJECT_PRIO_MIN} to ${PROJECT_PRIO_MAX}`),
    )
  }
  return deps.uow.run(async ({ capacity }) => {
    await capacity.lock()
    await capacity.setProjectPrio(input.project, input.prio, deps.clock.now())
    return ok(await capacity.queueStates())
  })
}

export async function getQueueStates(deps: PlanningDeps): Promise<Result<QueueStates, PortError>> {
  return deps.uow.run(async ({ capacity }) => ok(await capacity.queueStates()))
}

/**
 * Stores a repo's relearn point (`repo` is the project name): the lead samples before `at` (default now) are not learned
 * from, so a cost whose cause is fixed is not held up by the attempts that had it. A point in the future is refused.
 */
export async function setRelearn(
  deps: PlanningDeps,
  input: { repo: string; at: Date | null; actor: string },
): Promise<Result<Relearn, PortError>> {
  const now = deps.clock.now()
  const at = input.at ?? now
  if (at.getTime() > now.getTime()) return err(portError('refused', 'the relearn point is in the future'))
  const relearn: Relearn = { repo: input.repo, at, setAt: now, setBy: input.actor }
  return deps.uow.run(async ({ capacity }) => {
    await capacity.setRelearn(relearn)
    return ok(relearn)
  })
}
