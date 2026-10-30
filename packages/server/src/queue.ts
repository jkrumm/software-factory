import type { QueueState, QueueView } from '@software-factory/contract'
import type { SQL } from 'bun'
import { lockCapacity, wakeWaiting } from './capacity.ts'

const RESTRICTIVENESS: Record<QueueState, number> = { run: 0, pace: 1, drain: 2 }

export const moreRestrictive = (a: QueueState, b: QueueState): QueueState =>
  RESTRICTIVENESS[a] >= RESTRICTIVENESS[b] ? a : b

/** The scopes with a state set, global (`project` null) and per project. Initiative scopes are F4's and not read yet. */
export interface QueueStates {
  global: QueueState
  projects: ReadonlyMap<string, QueueState>
}

interface Row {
  project: string | null
  state: QueueState
  set_at: Date
}

async function rows(sql: SQL): Promise<Row[]> {
  return sql`
    SELECT project, state, set_at FROM factory.queue_states WHERE initiative IS NULL ORDER BY project NULLS FIRST`
}

export async function loadQueueStates(sql: SQL): Promise<QueueStates> {
  const all = await rows(sql)
  return {
    global: all.find((r) => r.project === null)?.state ?? 'run',
    projects: new Map(all.flatMap((r) => (r.project === null ? [] : [[r.project, r.state] as const]))),
  }
}

/** The most restrictive state that applies to a spawn in `repo`: its project's and the global one. */
export const effectiveState = (states: QueueStates, repo: string): QueueState =>
  moreRestrictive(states.global, states.projects.get(repo) ?? 'run')

export async function getQueue(sql: SQL, project: string | null): Promise<QueueView> {
  const all = await rows(sql)
  const global = all.find((r) => r.project === null)
  const own = project === null ? global : all.find((r) => r.project === project)
  const state = own?.state ?? 'run'
  return {
    scope: { project },
    state,
    effective: project === null ? state : moreRestrictive(global?.state ?? 'run', state),
    setAt: own?.set_at.toISOString() ?? null,
    scopes: all.map((r) => ({ project: r.project, state: r.state, setAt: r.set_at.toISOString() })),
  }
}

/**
 * Sets the state of a scope. A queued spawn held by the old state, and every waiting one, is due now, so a lifted
 * `drain` or `pace` takes effect on the next tick instead of after the recheck delay.
 */
export async function setQueue(sql: SQL, project: string | null, state: QueueState, now: Date): Promise<QueueView> {
  await sql.begin(async (tx) => {
    await lockCapacity(tx)
    await tx`
      INSERT INTO factory.queue_states (project, state, set_at) VALUES (${project}, ${state}, ${now})
      ON CONFLICT ((COALESCE(project, '')), (COALESCE(initiative, ''))) DO UPDATE SET state = EXCLUDED.state, set_at = EXCLUDED.set_at`
    await tx`UPDATE factory.spawns SET resume_at = NULL WHERE status = 'queued' AND hold IS NOT NULL`
    await wakeWaiting(tx, now)
  })
  return getQueue(sql, project)
}
