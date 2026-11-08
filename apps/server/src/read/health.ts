import type { Health, HealthLine, HealthLoop } from '@software-factory/contract'

export interface HealthFacts {
  version: string
  /** null when the database answered, else why it did not */
  databaseFailure: string | null
  /** the last successful tick; null until the tick exists and has run */
  tickAt: string | null
  /** the last change of the queue; null until there is one */
  queueMovedAt: string | null
  /** why the tick is stale (`tickProblem`), or null; left out, there is no tick to judge */
  tickFailure?: string | null
  /** the door's health lines; they inform and never change the status */
  lines?: readonly HealthLine[]
  loops?: readonly HealthLoop[]
}

/**
 * Why a tick that should run every `tickMs` is stale, or null. A server that has not had time for its first pass is not
 * stale yet; a tick of 0 is off (the scenarios drive it) and is never judged. Three missed intervals, and at least a
 * minute, make a stale tick.
 */
export function tickProblem(input: {
  tickMs: number
  now: Date
  startedAt: Date
  tickAt: Date | null
  /** the age that makes a tick stale, in place of three intervals and a minute (`FACTORY_HEARTBEAT_STALE_MS`, for a scenario) */
  limitMs?: number
}): string | null {
  if (input.tickMs === 0) return null
  const limit = input.limitMs ?? Math.max(3 * input.tickMs, 60_000)
  if (input.tickAt === null) {
    return input.now.getTime() - input.startedAt.getTime() > limit ? 'no tick has succeeded yet' : null
  }
  const age = input.now.getTime() - input.tickAt.getTime()
  return age > limit ? `the last successful tick was ${Math.round(age / 1000)} s ago` : null
}

/**
 * `/health` from what the server knows: the database answers and the tick is not stale. Either problem is the status
 * and the heartbeat's reason.
 */
export function healthOf(facts: HealthFacts): Health {
  const reason = facts.databaseFailure ?? facts.tickFailure ?? null
  return {
    status: reason === null ? 'ok' : 'unhealthy',
    version: facts.version,
    reason,
    heartbeat: { ok: reason === null, reason, tickAt: facts.tickAt, queueMovedAt: facts.queueMovedAt },
    lines: [...(facts.lines ?? [])],
    loops: [...(facts.loops ?? [])],
  }
}
