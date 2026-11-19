import { type AccountReading, isFresh, orderOf, RANK_LANE, READING_MAX_AGE_MS } from '../domains/capacity/accounts.ts'
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
  /** the leads that hold a claim on it */
  leads: number
  /** the most leads it carries at once, before an idle host's raise */
  cap: number
}

const accountState = (reading: AccountReading, now: Date, options: { leads?: number; cap: number }): AccountState => ({
  reading,
  fresh: isFresh(reading, now),
  open: reading.open,
  why: reading.open ? null : reading.closedWhy,
  opensAt: reading.open ? null : reading.opensAt,
  rank: reading.position,
  rankReason: reading.reason,
  leads: options.leads ?? 0,
  cap: options.cap,
})

export interface CapacityState {
  accounts: AccountState[]
  /** the package's order of the open accounts for the bulk lane, as the newest poll read it; null: nothing read yet */
  rank: { lane: string; at: Date; readAt: Date; order: { account: string; reason: string; weight: null }[] } | null
  rankFresh: boolean
  host: { load: number | null; memory: MemoryReading | null; notes: string[] }
  claims: Claim[]
  states: QueueStates
  slots: SlotRow[]
  slotLines: string[]
}

const optionsOf = (deps: CapacityDeps, reading: AccountReading, claims: readonly Claim[]) => ({
  leads: claims.filter((claim) => claim.account === reading.account).length,
  cap: deps.limits.accountLeads?.get(reading.account) ?? deps.limits.leadsPerAccount,
})

const rankOf = (readings: readonly AccountReading[]): CapacityState['rank'] => {
  const readAt = readings.reduce<Date | null>((newest, r) => (!newest || r.readAt > newest ? r.readAt : newest), null)
  return readAt ? { lane: RANK_LANE, at: readAt, readAt, order: orderOf(readings) } : null
}

/** The poll, now: what `factory capacity refresh` runs. */
export async function refreshState(deps: CapacityDeps): Promise<Result<AccountState[], PortError>> {
  const polled = await refreshAccounts(deps)
  if (!polled.ok) return polled
  const now = deps.clock.now()
  const seen = await deps.uow.run(async ({ capacity }) =>
    ok({ readings: await capacity.latestReadings(), claims: await capacity.claims() }),
  )
  if (!seen.ok) return seen
  return ok(
    seen.value.readings.map((reading) => accountState(reading, now, optionsOf(deps, reading, seen.value.claims))),
  )
}

/** Accounts and their windows, the host, who holds which claim, the queue states and the test slots. Reads (and polls when the readings are old). */
export async function capacityState(deps: CapacityDeps): Promise<Result<CapacityState, PortError>> {
  const notes = await pollIfDue(deps)
  const host = await readHost(deps)
  const now = deps.clock.now()
  return deps.uow.run(async ({ capacity }) => {
    const slots = await capacity.slots()
    const readings = await capacity.latestReadings()
    const claims = await capacity.claims()
    const rank = rankOf(readings)
    return ok<CapacityState>({
      accounts: readings.map((reading) => accountState(reading, now, optionsOf(deps, reading, claims))),
      rank,
      rankFresh: rank !== null && now.getTime() - rank.readAt.getTime() <= READING_MAX_AGE_MS,
      host: { load: host.load, memory: host.memory, notes: [...notes, ...host.notes] },
      claims,
      states: await capacity.queueStates(),
      slots,
      slotLines: slotLines(slots, now),
    })
  })
}
