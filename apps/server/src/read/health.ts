import type { Health } from '@software-factory/contract'

export interface HealthFacts {
  version: string
  /** null when the database answered, else why it did not */
  databaseFailure: string | null
  /** the last successful tick; null until the tick exists and has run */
  tickAt: string | null
  /** the last change of the queue; null until there is one */
  queueMovedAt: string | null
}

/**
 * `/health` from what the server knows. Until a tick exists, a server whose database answers is ok; the package that
 * brings the tick adds its staleness to both the status and the heartbeat.
 */
export function healthOf(facts: HealthFacts): Health {
  const reason = facts.databaseFailure
  return {
    status: reason === null ? 'ok' : 'unhealthy',
    version: facts.version,
    reason,
    heartbeat: { ok: reason === null, reason, tickAt: facts.tickAt, queueMovedAt: facts.queueMovedAt },
  }
}
