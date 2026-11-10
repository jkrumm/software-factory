import {
  type AccountRank,
  type AccountReading,
  isFresh,
  RANK_LANE,
  rankIsFresh,
  standing,
} from '../domains/capacity/accounts.ts'
import type { Claim } from '../domains/capacity/claims.ts'
import type { MemoryReading } from '../domains/capacity/host.ts'
import type { QueueStates } from '../domains/capacity/queue-state.ts'
import { type SlotRow, slotLines } from '../domains/capacity/slots.ts'
import { ok, type PortError, type Result } from '../kernel/result.ts'
import { type CapacityDeps, pollIfDue, readHost, refreshAccounts } from './capacity-admit.ts'

export interface AccountState {
  reading: AccountReading
  fresh: boolean
  open: boolean
  why: string | null
  opensAt: Date | null
  /** 1-based place in the applied order; null: not ranked, or the rank is stale */
  rank: number | null
  rankReason: string | null
}

export const accountState = (reading: AccountReading, now: Date, rank: AccountRank | null = null): AccountState => {
  const stand = standing(reading, now)
  const index = rank && rankIsFresh(rank, now) ? rank.order.findIndex((r) => r.account === reading.account) : -1
  return {
    reading,
    fresh: isFresh(reading, now),
    open: stand.open,
    why: stand.open ? null : stand.why,
    opensAt: stand.open ? null : stand.until,
    rank: index < 0 ? null : index + 1,
    rankReason: index < 0 ? null : (rank?.order[index]?.reason ?? null),
  }
}

export interface CapacityState {
  accounts: AccountState[]
  rank: AccountRank | null
  rankFresh: boolean
  host: { load: number | null; memory: MemoryReading | null; notes: string[] }
  claims: Claim[]
  states: QueueStates
  slots: SlotRow[]
  slotLines: string[]
}

/** The poll, now: what `factory capacity refresh` runs. */
export async function refreshState(deps: CapacityDeps): Promise<Result<AccountState[], PortError>> {
  const polled = await refreshAccounts(deps)
  if (!polled.ok) return polled
  const now = deps.clock.now()
  const rank = await deps.uow.run(async ({ capacity }) => ok(await capacity.latestRank(RANK_LANE)))
  if (!rank.ok) return rank
  return ok(polled.value.map((reading) => accountState(reading, now, rank.value)))
}

/** Accounts and their windows, the host, who holds which claim, the queue states and the test slots. Reads (and polls when the readings are old). */
export async function capacityState(deps: CapacityDeps): Promise<Result<CapacityState, PortError>> {
  const notes = await pollIfDue(deps)
  const host = await readHost(deps)
  const now = deps.clock.now()
  return deps.uow.run(async ({ capacity }) => {
    const slots = await capacity.slots()
    const rank = await capacity.latestRank(RANK_LANE)
    return ok<CapacityState>({
      accounts: (await capacity.latestReadings()).map((reading) => accountState(reading, now, rank)),
      rank,
      rankFresh: rank !== null && rankIsFresh(rank, now),
      host: { load: host.load, memory: host.memory, notes: [...notes, ...host.notes] },
      claims: await capacity.claims(),
      states: await capacity.queueStates(),
      slots,
      slotLines: slotLines(slots, now),
    })
  })
}
