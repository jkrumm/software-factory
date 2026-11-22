import { type AccountReading, pickAccount } from './accounts.ts'
import { type BootInputs, bootRefusal } from './boot.ts'
import { type Claimant, claimRoom } from './claims.ts'
import {
  describeLoad,
  describeMemory,
  describeProcesses,
  describeTrip,
  type LoadTrip,
  type MemoryCeilings,
  type MemoryReading,
  overLoad,
  overMemory,
  overProcesses,
  type Reserved,
} from './host.ts'
import { type DiskFit, diskRefusal } from './disk.ts'
import { type LaneInput, laneRoom } from './lanes.ts'
import type { LeadGrowth } from './leadcost.ts'
import type { QueueState } from './queue-state.ts'

/**
 * Why a queued Issue that the chain lets through still stays queued, in the order the rules are looked at (the first
 * that says no wins). "Hold" is retired: an Issue is not waiting, it stays queued, and this names why.
 */
const REFUSALS = [
  'drain',
  'doctor',
  'boot',
  'load',
  'memory',
  'disk',
  'tests',
  'lane',
  'claim',
  'window',
  'cap',
] as const
export type RefusalKind = (typeof REFUSALS)[number]

export interface Refusal {
  kind: RefusalKind
  /** names the reason and its numbers: "memory: swapouts 3100 MiB/300s (ceiling 2048), …" */
  message: string
  /** when a reading says the reason may end (a window's reset); null when nothing names a time */
  opensAt: Date | null
  /** `fit`: the memory refusal is the learned cost of the candidate's lead, not the host's reading; `aim`: the lead aim's count (the host's pressure) holds it; absent otherwise */
  part?: 'fit' | 'aim'
}

/**
 * What a repo's lead is learned to take, against what the host has free; every figure in MiB. The running leads' test
 * peaks are not reserved here: tests run inside the host's test slots, and the slot grant checks their memory.
 */
export interface LeadFit {
  repo: string
  /** the learned median peak of the candidate's repo; null: fewer than three attempts */
  candidateMib: number | null
  /** the attempts sampled for the repo */
  attempts: number
  /** by which rule the figure is learned: the median of the newest ten, or (`falling`) the largest of the newest three settled attempts, all below that median */
  basis?: 'median' | 'falling'
  /** the median of the newest ten, which a `falling` figure is below */
  typicalMib?: number | null
  /** the repo's relearn point, when it has one: the figure is learned from the attempts since */
  relearnedAt?: Date | null
  /** free by the newest host sample; null: unknown */
  freeMib: number | null
  headroomMib: number
  /** the leads that hold a claim; a host that runs none always has room for one */
  running: number
  /** what the young leads (under the age their figure counts as settled) are still learned to grow by; absent: none */
  growing?: LeadGrowth
}

export interface AdmissionInputs {
  now: Date
  /** the effective queue state of the candidate's project */
  state: QueueState
  /** the project whose own state is `state` (more restrictive than the queue's); null or absent: the queue's state */
  stateProject?: string | null
  /** why the project's own doctor says this host cannot run it (`doctor:` of its `project.yaml`); null or absent: it says nothing, or says it can */
  doctor?: string | null
  /** `leads: N` of the project */
  leads: number
  holders: readonly Claimant[]
  owed: readonly Claimant[]
  candidate: Claimant
  /** the candidate's lane with the repo's cap on it and who runs in it; null: no lane, or one the repo does not cap */
  lane: LaneInput | null
  /** the host's boot grace; null: the uptime could not be read, or the grace does not apply */
  boot?: BootInputs | null
  /** null: the reading could not be taken, and the lead is admitted without it */
  load: number | null
  loadCeiling: number
  /**
   * the load tripwire over the minute samples (`loadTrip`): a lead waits only while it is tripped, never for one peak.
   * Absent or null (too few fresh samples): the reading of the instant decides, as before.
   */
  loadTrip?: LoadTrip
  /** the host's test line as it stands (`testLine`); null or absent: unread, and the line keeps nobody out */
  tests?: TestLine | null
  /** the host's process count by the newest minute sample; null: unread, and the cap does not apply */
  processes?: number | null
  /** no new lead above this many processes; null or absent: no cap */
  processCap?: number | null
  memory: MemoryReading | null
  memoryCeilings: MemoryCeilings
  /** the learned cost of the candidate's lead against the free memory; null: nothing learned is known */
  leadFit?: LeadFit | null
  /** the learned worktree footprint of the candidate's repo against the free disk (`disk.ts`); null or absent: nothing learned or no reading, and disk keeps nobody out */
  diskFit?: DiskFit | null
  /**
   * The lead aim: the count of leads the host takes at its pressure now, and the leads running. Then the
   * memory fit above is only the guard of what cannot fit at all, and this count is the gate. Null or absent (an unread host): no aim, the fit
   * decides alone.
   */
  leadAim?: LeadAimGate | null
  /** the memory the running leads' lanes and the candidate's lane reserve (the lanes' `memory`); null: none */
  reserved: Reserved | null
  accounts: readonly AccountReading[]
  /** accounts that took a lead after their latest sample */
  loaded: ReadonlySet<string>
  /** leads that hold a claim on each account */
  leadsByAccount: ReadonlyMap<string, number>
  /** the cap of an account `accountLeads` does not name; the idle host's raise is already in it */
  leadsPerAccount: number
  /** an account's own cap (`FACTORY_ACCOUNT_LEADS`), before the idle host's raise */
  accountLeads?: ReadonlyMap<string, number>
  /** extra leads per account the idle host allows this pass (already in `leadsPerAccount`, added to `accountLeads`); named in a `cap` refusal */
  allowanceBonus?: number
}

export type Admission = { admit: true; account: AccountReading } | { admit: false; refusal: Refusal }

/** The lead aim as the admission sees it: its count, the leads running (this pass's admissions included), and whether the pressure was read. */
export interface LeadAimGate {
  target: number
  running: number
  pressureRead: boolean
}

const no = (kind: RefusalKind, message: string, opensAt: Date | null = null, part?: 'fit' | 'aim'): Admission => ({
  admit: false,
  refusal: { kind, message, opensAt, ...(part ? { part } : {}) },
})

/** Why a drain holds an Issue, and how it ends: a project's drain names the project, the queue's names the whole queue. */
const drainMessage = (project: string | null): string =>
  project
    ? `${project} is draining: nothing new of it starts; factory queue set run --project ${project} sets it back`
    : 'the whole queue is draining: nothing new starts; factory queue set run sets it back'

/**
 * Whether a new lead may start now, in the order of the rules: the queue state (`drain` starts nothing), the host's
 * boot grace, its load (the tripwire: sustained minutes over the ceiling), its memory (the reading, then the learned fit
 * of the candidate's lead), its disk (the learned worktree footprint of the candidate's repo against the free disk), the host's test line (`lineRefusal`), the candidate's lane (the repo's
 * cap on a resource), the repo's claims (`leads: N` plus one for a fix; `pace` allows one), then an account with room.
 * Never spills: with every account closed the answer is to wait for the first opening. Pure: the readings are passed
 * in, and the caller decides again at every claim, inside one transaction.
 */
export function checkAdmission(input: AdmissionInputs): Admission {
  const pace = input.state === 'pace'
  if (input.state === 'drain') return no('drain', drainMessage(input.stateProject ?? null))
  if (input.doctor) return no('doctor', input.doctor)
  const booting = input.boot ? bootRefusal(input.boot, input.now) : null
  if (booting) return no('boot', booting.message, booting.opensAt)
  const trip = input.loadTrip
  if (trip?.tripped) return no('load', `the machine is busy: ${describeTrip(trip, input.loadCeiling)}`)
  if (!trip && input.load !== null && overLoad(input.load, input.loadCeiling)) {
    return no('load', `the machine is busy: ${describeLoad(input.load, input.loadCeiling)}`)
  }
  if (input.processes != null && input.processCap != null && overProcesses(input.processes, input.processCap)) {
    return no('load', `the machine runs too many processes: ${describeProcesses(input.processes, input.processCap)}`)
  }
  if (input.memory !== null && overMemory(input.memory, input.memoryCeilings, input.reserved)) {
    return no(
      'memory',
      `the host is short of memory: ${describeMemory(input.memory, input.memoryCeilings, input.reserved)}`,
    )
  }
  const fit = input.leadFit ? fitRefusal(input.leadFit) : null
  if (fit) return no('memory', fit, null, 'fit')
  const diskFull = input.diskFit ? diskRefusal(input.diskFit) : null
  if (diskFull) return no('disk', diskFull)
  const line = input.tests && !input.candidate.urgent ? lineRefusal(input.tests) : null
  if (line) return no('tests', line)
  const laneFree = laneRoom({ lane: input.lane, urgent: input.candidate.urgent })
  if (!laneFree.granted) return no('lane', laneFree.message)
  const room = claimRoom({
    leads: pace ? 1 : input.leads,
    holders: input.holders,
    owed: input.owed,
    candidate: input.candidate,
  })
  if (!room.granted) return no('claim', `no claim free in the repo: ${room.message}`)
  const raise = input.allowanceBonus ?? 0
  const pick = pickAccount({
    readings: input.accounts,
    loaded: input.loaded,
    leads: input.leadsByAccount,
    leadsPerAccount: input.leadsPerAccount,
    accountCaps: new Map([...(input.accountLeads ?? [])].map(([account, cap]) => [account, cap + raise])),
    now: input.now,
  })
  // Last: the aim holds back only a lead every other rule lets in, so its reason is the true one and what it holds back is
  // what the aim's count binds (`leadWaiters`).
  if (pick.picked) {
    const aimed = input.leadAim ? aimRefusal(input.leadAim) : null
    return aimed ? no('memory', aimed, null, 'aim') : { admit: true, account: pick.picked }
  }
  if (!pick.capped) return no('window', pick.why, pick.opensAt)
  return no('cap', raise > 0 ? `${pick.why} (raised by ${raise}: the host is idle)` : pick.why)
}

const gib = (mib: number): number => Math.round((mib / 1024) * 10) / 10

/**
 * The host's test line as the admission sees it. A lead costs little while it thinks and much while it tests, so the
 * steps waiting for a test slot are what more leads would lengthen.
 */
export interface TestLine {
  /** steps waiting for a slot */
  waiters: number
  /** steps running in a slot */
  holders: number
  /** the median of how long the waiters have waited so far */
  medianWaitMs: number
  /** how long a step takes: the median run of the last day's steps; null: none ran */
  stepMs: number | null
}

const minutes = (ms: number): string => `${Math.round(ms / 6000) / 10} min`

/**
 * No new lead while the test line is long: more steps wait than run, and half of them have already waited longer than a
 * step takes. Then the slots, not the allowance, are the bottleneck, and another lead only adds to the line. It opens again
 * as soon as the line drains (fewer waiting than running, or the waits shorter than a step). Not a constant: both sides
 * are measured, the line now and the steps of the last day. A fix (`urgent`) is never kept out by it.
 */
export function lineRefusal(line: TestLine): string | null {
  if (line.stepMs === null || line.waiters <= line.holders || line.medianWaitMs <= line.stepMs) return null
  return (
    `the test line is long: ${line.waiters} steps wait for a slot beside ${line.holders} running, half of them for over ` +
    `${minutes(line.medianWaitMs)}, longer than the ${minutes(line.stepMs)} a step takes (median of the last day)`
  )
}

/**
 * The lead aim's refusal: no new lead while as many run as the host takes at its pressure, and none while the pressure is not
 * read (a missing reading admits nothing beyond what runs). Null: the aim has room.
 */
export function aimRefusal(aim: LeadAimGate): string | null {
  if (!aim.pressureRead) return `memory: the host's pressure is not read, so no lead beyond the ${aim.running} running`
  if (aim.running < aim.target) return null
  return `memory: the host takes ${aim.target} leads at its pressure now (the aim adds one after two quiet minutes), ${aim.running} run`
}

/** The refusal of a lead that would not fit by what its repo's leads are learned to take; null: it fits or nothing is known. */
function fitRefusal(fit: LeadFit): string | null {
  if (fit.candidateMib === null || fit.freeMib === null) return null
  if (fit.running === 0) return null
  const growth = fit.growing?.mib ?? 0
  if (fit.candidateMib <= fit.freeMib - growth - fit.headroomMib) return null
  const basis =
    fit.basis === 'falling'
      ? `the largest of the newest 3 settled leads, all below the median of ${gib(fit.typicalMib ?? fit.candidateMib)} GiB`
      : `median of ${fit.attempts} past leads`
  const since = fit.relearnedAt ? `, learned from the attempts since ${fit.relearnedAt.toISOString()}` : ''
  const growing =
    fit.growing && growth > 0
      ? `, of which ${fit.growing.leads} young ${fit.growing.leads === 1 ? 'lead still takes' : 'leads still take'} ${gib(growth)} GiB more`
      : ''
  return (
    `memory: a lead of ${fit.repo} takes ~${gib(fit.candidateMib)} GiB outside test slots (${basis}${since}), ` +
    `the host has ${gib(fit.freeMib)} GiB free${growing}${fit.headroomMib > 0 ? `, headroom ${gib(fit.headroomMib)} GiB` : ''}`
  )
}
