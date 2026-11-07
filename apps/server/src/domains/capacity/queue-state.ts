/** `run`: admission decides. `pace`: one lead at a time, spending only toward the weekly pace. `drain`: no new lead. */
export const QUEUE_STATES = ['run', 'pace', 'drain'] as const
export type QueueState = (typeof QUEUE_STATES)[number]

const RESTRICTIVENESS: Record<QueueState, number> = { run: 0, pace: 1, drain: 2 }

export const moreRestrictive = (a: QueueState, b: QueueState): QueueState =>
  RESTRICTIVENESS[a] >= RESTRICTIVENESS[b] ? a : b

/** The scopes with a state set: global, and per project. No row is `run`. */
export interface QueueStates {
  global: QueueState
  projects: ReadonlyMap<string, QueueState>
}

/** The most restrictive state that applies to a project: its own and the global one. */
export const effectiveState = (states: QueueStates, project: string): QueueState =>
  moreRestrictive(states.global, states.projects.get(project) ?? 'run')
