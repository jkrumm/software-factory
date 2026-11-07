import type { QueueState, QueueStates } from '../domains/capacity/queue-state.ts'
import { ok, type PortError, type Result } from '../kernel/result.ts'
import type { PlanningDeps } from './planning-deps.ts'

export interface QueueSetting {
  state: QueueState
  setAt: Date
}

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

export async function getQueueStates(deps: PlanningDeps): Promise<Result<QueueStates, PortError>> {
  return deps.uow.run(async ({ capacity }) => ok(await capacity.queueStates()))
}
