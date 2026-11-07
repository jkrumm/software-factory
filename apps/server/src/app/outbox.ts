import { retryDelayMs } from '../domains/work/effects.ts'
import type { ClaimedEffect, EffectPorts } from '../domains/work/ports.ts'
import type { Clock } from '../kernel/clock.ts'
import { ok, type PortError, type Result } from '../kernel/result.ts'
import type { IssueWrites } from './issues.ts'

export interface OutboxDeps {
  uow: IssueWrites
  clock: Clock
  ports: EffectPorts
  /** how long a claim holds; a runner that dies lets its effects go after this */
  leaseMs?: number
  /** effects per pass */
  limit?: number
}

const LEASE_MS = 15 * 60_000
const LIMIT = 16

function call(ports: EffectPorts, effect: ClaimedEffect): Promise<Result<void>> {
  switch (effect.kind) {
    case 'start_lead':
      return ports.start_lead(effect)
    case 'note_lead':
      return ports.note_lead(effect)
    case 'start_watch':
      return ports.start_watch(effect)
    case 'finalize':
      return ports.finalize(effect)
  }
}

/**
 * One pass of the outbox: claim, commit, call, record. The claim is its own transaction; each port is called with no
 * transaction open; each result is recorded in a transaction of its own. A failed effect waits before it runs again,
 * and nothing of its Issue overtakes it.
 */
export async function runOutbox(deps: OutboxDeps): Promise<Result<{ ran: number; failed: number }, PortError>> {
  const now = deps.clock.now()
  const claimed = await deps.uow.run(async ({ work }) =>
    ok(
      await work.claimEffects({
        now,
        until: new Date(now.getTime() + (deps.leaseMs ?? LEASE_MS)),
        limit: deps.limit ?? LIMIT,
      }),
    ),
  )
  if (!claimed.ok) return claimed
  let failed = 0
  for (const effect of claimed.value) {
    if (deps.uow.inTransaction()) throw new Error('a port is never called inside a transaction')
    const result = await call(deps.ports, effect)
    const at = deps.clock.now()
    if (!result.ok) failed++
    const run = result.ok
      ? { at, ok: true as const }
      : {
          at,
          ok: false as const,
          error: result.error,
          retryAt: new Date(at.getTime() + retryDelayMs(effect.failures + 1)),
        }
    const recorded = await deps.uow.run(async ({ work }) => ok(await work.recordRun(effect.key, run)))
    if (!recorded.ok) return recorded
  }
  return ok({ ran: claimed.value.length, failed })
}
