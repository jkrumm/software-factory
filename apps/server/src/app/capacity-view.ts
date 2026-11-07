import { type AccountReading, isFresh, standing } from '../domains/capacity/accounts.ts'
import type { Seat } from '../domains/capacity/claims.ts'
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
}

export const accountState = (reading: AccountReading, now: Date): AccountState => {
  const stand = standing(reading, now)
  return {
    reading,
    fresh: isFresh(reading, now),
    open: stand.open,
    why: stand.open ? null : stand.why,
    opensAt: stand.open ? null : stand.until,
  }
}

export interface CapacityState {
  accounts: AccountState[]
  host: { load: number | null; memory: MemoryReading | null; notes: string[] }
  seats: Seat[]
  states: QueueStates
  slots: SlotRow[]
  slotLines: string[]
}

/** The poll, now: what `factory capacity refresh` runs. */
export async function refreshState(deps: CapacityDeps): Promise<Result<AccountState[], PortError>> {
  const polled = await refreshAccounts(deps)
  if (!polled.ok) return polled
  const now = deps.clock.now()
  return ok(polled.value.map((reading) => accountState(reading, now)))
}

/** Accounts and their windows, the host, who sits where, the queue states and the test slots. Reads (and polls when the readings are old). */
export async function capacityState(deps: CapacityDeps): Promise<Result<CapacityState, PortError>> {
  const notes = await pollIfDue(deps)
  const host = await readHost(deps)
  const now = deps.clock.now()
  return deps.uow.run(async ({ capacity }) => {
    const slots = await capacity.slots()
    return ok<CapacityState>({
      accounts: (await capacity.latestReadings()).map((reading) => accountState(reading, now)),
      host: { load: host.load, memory: host.memory, notes: [...notes, ...host.notes] },
      seats: await capacity.seats(),
      states: await capacity.queueStates(),
      slots,
      slotLines: slotLines(slots, now),
    })
  })
}
