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
  /** once aborted (the server's drain) no further effect is started; the claimed ones left are given back */
  signal?: AbortSignal
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
  let ran = 0
  for (const [index, effect] of claimed.value.entries()) {
    if (deps.signal?.aborted) {
      // Unrun and uncounted: without this the lease holds them past the restart, for minutes.
      const rest = claimed.value.slice(index).map((left) => left.key)
      const released = await deps.uow.run(async ({ work }) => ok(await work.releaseEffects(rest)))
      if (!released.ok) return released
      break
    }
    if (deps.uow.inTransaction()) throw new Error('a port is never called inside a transaction')
    ran++
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
  return ok({ ran, failed })
}
