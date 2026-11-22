/** `run`: admission decides. `pace`: one lead at a time in a project. `drain`: no new lead. */
export const QUEUE_STATES = ['run', 'pace', 'drain'] as const
export type QueueState = (typeof QUEUE_STATES)[number]

const RESTRICTIVENESS: Record<QueueState, number> = { run: 0, pace: 1, drain: 2 }

/** A project's priority and an Issue's share one range. */
export const PROJECT_PRIO_MIN = -1000
export const PROJECT_PRIO_MAX = 1000

/** The scopes with a state set: global, and per project. No row is `run`. `prios`: the project priorities set (absent: 0). */
export interface QueueStates {
  global: QueueState
  projects: ReadonlyMap<string, QueueState>
  prios: ReadonlyMap<string, number>
}

/**
 * The most restrictive state that applies to a project: its own and the global one. `project` is the project's name when its
 * own state is the one that applies (strictly more restrictive than the queue's); null when the queue's state does.
 */
export const effectiveScope = (states: QueueStates, project: string): { state: QueueState; project: string | null } => {
  const own = states.projects.get(project) ?? 'run'
  return RESTRICTIVENESS[own] > RESTRICTIVENESS[states.global]
    ? { state: own, project }
    : { state: states.global, project: null }
}
