import { type AccountReading, pickAccount } from './accounts.ts'
import { type Claimant, claimRoom } from './claims.ts'
import { describeLoad, describeMemory, type MemoryCeilings, type MemoryReading, overLoad, overMemory } from './host.ts'
import type { QueueState } from './queue-state.ts'

/**
 * Why a queued Issue that the chain lets through still stays queued, in the order the rules are looked at (the first
 * that says no wins). "Hold" is retired: an Issue is not waiting, it stays queued, and this names why.
 */
export const REFUSALS = ['drain', 'load', 'memory', 'claim', 'window', 'cap'] as const
export type RefusalKind = (typeof REFUSALS)[number]

export interface Refusal {
  kind: RefusalKind
  /** names the reason and its numbers: "memory: swapouts 3100 MiB/300s (ceiling 2048), …" */
  message: string
  /** when a reading says the reason may end (a window's reset); null when nothing names a time */
  opensAt: Date | null
}

export interface AdmissionInputs {
  now: Date
  /** the effective queue state of the candidate's project */
  state: QueueState
  /** `leads: N` of the project */
  leads: number
  holders: readonly Claimant[]
  owed: readonly Claimant[]
  candidate: Claimant
  /** null: the reading could not be taken, and the lead is admitted without it */
  load: number | null
  loadCeiling: number
  memory: MemoryReading | null
  memoryCeilings: MemoryCeilings
  accounts: readonly AccountReading[]
  /** accounts that took a lead after their latest sample */
  loaded: ReadonlySet<string>
  /** leads that hold a seat on each account */
  leadsByAccount: ReadonlyMap<string, number>
  leadsPerAccount: number
}

export type Admission = { admit: true; account: AccountReading } | { admit: false; refusal: Refusal }

const no = (kind: RefusalKind, message: string, opensAt: Date | null = null): Admission => ({
  admit: false,
  refusal: { kind, message, opensAt },
})

/**
 * Whether a new lead may start now, in the order of the rules: the queue state (`drain` starts nothing), the host's
 * load, its memory, the repo's seats (`leads: N` plus one for a fix; `pace` allows one), then an account with room.
 * Never spills: with every account closed the answer is to wait for the first opening. Pure: the readings are passed
 * in, and the caller decides again at every claim, inside one transaction.
 */
export function checkAdmission(input: AdmissionInputs): Admission {
  const pace = input.state === 'pace'
  if (input.state === 'drain') return no('drain', 'the queue is draining: nothing new starts')
  if (input.load !== null && overLoad(input.load, input.loadCeiling)) {
    return no('load', `the machine is busy: ${describeLoad(input.load, input.loadCeiling)}`)
  }
  if (input.memory !== null && overMemory(input.memory, input.memoryCeilings)) {
    return no('memory', `the host is short of memory: ${describeMemory(input.memory, input.memoryCeilings)}`)
  }
  const room = claimRoom({
    leads: pace ? 1 : input.leads,
    holders: input.holders,
    owed: input.owed,
    candidate: input.candidate,
  })
  if (!room.granted) return no('claim', `no seat in the repo: ${room.message}`)
  const pick = pickAccount({
    readings: input.accounts,
    loaded: input.loaded,
    leads: input.leadsByAccount,
    leadsPerAccount: input.leadsPerAccount,
    now: input.now,
    pace,
  })
  if (pick.picked) return { admit: true, account: pick.picked }
  return pick.capped ? no('cap', pick.why) : no('window', pick.why, pick.opensAt)
}
