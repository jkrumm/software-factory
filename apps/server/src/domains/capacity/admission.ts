import { type AccountReading, type AccountRank, pickAccount } from './accounts.ts'
import { type Claimant, claimRoom } from './claims.ts'
import {
  describeLoad,
  describeMemory,
  type MemoryCeilings,
  type MemoryReading,
  overLoad,
  overMemory,
  type Reserved,
} from './host.ts'
import { type LaneInput, laneRoom } from './lanes.ts'
import type { QueueState } from './queue-state.ts'

/**
 * Why a queued Issue that the chain lets through still stays queued, in the order the rules are looked at (the first
 * that says no wins). "Hold" is retired: an Issue is not waiting, it stays queued, and this names why.
 */
export const REFUSALS = ['drain', 'load', 'memory', 'lane', 'claim', 'window', 'cap'] as const
export type RefusalKind = (typeof REFUSALS)[number]

export interface Refusal {
  kind: RefusalKind
  /** names the reason and its numbers: "memory: swapouts 3100 MiB/300s (ceiling 2048), …" */
  message: string
  /** when a reading says the reason may end (a window's reset); null when nothing names a time */
  opensAt: Date | null
}

/**
 * What a repo's lead is learned to take, against what the host has free; every figure in MiB. The running leads' test
 * peaks are not reserved here: tests run inside the host's test slots, and the slot grant checks their memory.
 */
export interface LeadFit {
  repo: string
  /** the learned p80 of the candidate's repo; null: fewer than three attempts */
  candidateMib: number | null
  /** the attempts sampled for the repo */
  attempts: number
  /** free by the newest host sample; null: unknown */
  freeMib: number | null
  headroomMib: number
  /** the leads that hold a claim; a host that runs none always has room for one */
  running: number
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
  /** the candidate's lane with the repo's cap on it and who runs in it; null: no lane, or one the repo does not cap */
  lane: LaneInput | null
  /** null: the reading could not be taken, and the lead is admitted without it */
  load: number | null
  loadCeiling: number
  memory: MemoryReading | null
  memoryCeilings: MemoryCeilings
  /** the learned cost of the candidate's lead against the free memory; null: nothing learned is known */
  leadFit?: LeadFit | null
  /** the memory the running leads' lanes and the candidate's lane reserve (the lanes' `memory`); null: none */
  reserved: Reserved | null
  accounts: readonly AccountReading[]
  /** accounts that took a lead after their latest sample */
  loaded: ReadonlySet<string>
  /** leads that hold a claim on each account */
  leadsByAccount: ReadonlyMap<string, number>
  leadsPerAccount: number
  /** extra leads per account the idle host allows this pass (already in `leadsPerAccount`); named in a `cap` refusal */
  seatBonus?: number
  /** the picker's order of accounts; the gates above stay, only the pick among open accounts follows it */
  rank?: AccountRank | null
}

export type Admission = { admit: true; account: AccountReading } | { admit: false; refusal: Refusal }

const no = (kind: RefusalKind, message: string, opensAt: Date | null = null): Admission => ({
  admit: false,
  refusal: { kind, message, opensAt },
})

/**
 * Whether a new lead may start now, in the order of the rules: the queue state (`drain` starts nothing), the host's
 * load, its memory (the reading, then the learned fit of the candidate's lead), the candidate's lane (the repo's
 * cap on a resource class), the repo's claims (`leads: N` plus one for a fix; `pace` allows one), then an account with room.
 * Never spills: with every account closed the answer is to wait for the first opening. Pure: the readings are passed
 * in, and the caller decides again at every claim, inside one transaction.
 */
export function checkAdmission(input: AdmissionInputs): Admission {
  const pace = input.state === 'pace'
  if (input.state === 'drain') return no('drain', 'the queue is draining: nothing new starts')
  if (input.load !== null && overLoad(input.load, input.loadCeiling)) {
    return no('load', `the machine is busy: ${describeLoad(input.load, input.loadCeiling)}`)
  }
  if (input.memory !== null && overMemory(input.memory, input.memoryCeilings, input.reserved)) {
    return no(
      'memory',
      `the host is short of memory: ${describeMemory(input.memory, input.memoryCeilings, input.reserved)}`,
    )
  }
  const fit = input.leadFit ? fitRefusal(input.leadFit) : null
  if (fit) return no('memory', fit)
  const laneFree = laneRoom({ lane: input.lane, urgent: input.candidate.urgent })
  if (!laneFree.granted) return no('lane', laneFree.message)
  const room = claimRoom({
    leads: pace ? 1 : input.leads,
    holders: input.holders,
    owed: input.owed,
    candidate: input.candidate,
  })
  if (!room.granted) return no('claim', `no claim free in the repo: ${room.message}`)
  const pick = pickAccount({
    readings: input.accounts,
    loaded: input.loaded,
    leads: input.leadsByAccount,
    leadsPerAccount: input.leadsPerAccount,
    now: input.now,
    pace,
    rank: input.rank,
  })
  if (pick.picked) return { admit: true, account: pick.picked }
  if (!pick.capped) return no('window', pick.why, pick.opensAt)
  const raise = input.seatBonus ?? 0
  return no('cap', raise > 0 ? `${pick.why} (raised by ${raise}: the host is idle)` : pick.why)
}

const gib = (mib: number): number => Math.round((mib / 1024) * 10) / 10

/** The refusal of a lead that would not fit by what its repo's leads are learned to take; null: it fits or nothing is known. */
function fitRefusal(fit: LeadFit): string | null {
  if (fit.candidateMib === null || fit.freeMib === null) return null
  if (fit.running === 0) return null
  if (fit.candidateMib <= fit.freeMib - fit.headroomMib) return null
  return (
    `memory: a lead of ${fit.repo} takes ~${gib(fit.candidateMib)} GiB (p80 of ${fit.attempts} past leads), ` +
    `the host has ${gib(fit.freeMib)} GiB free, headroom ${gib(fit.headroomMib)} GiB`
  )
}
