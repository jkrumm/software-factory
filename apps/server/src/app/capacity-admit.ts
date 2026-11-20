import { type AccountReading, pickAccount, POLL_EVERY_MS } from '../domains/capacity/accounts.ts'
import type { BootSample } from '../domains/capacity/boot.ts'
import { checkAdmission, type LeadFit, type RefusalKind, type TestLine } from '../domains/capacity/admission.ts'
import { freeMibOf, headroomMib, SAMPLE_MAX_AGE_MS } from '../domains/capacity/costs.ts'
import { type DoctorReader, doctorMessage } from '../domains/capacity/doctor.ts'
import { DEFAULT_TYPICAL_LEAD_MIB, SEAT_SAMPLE_MAX_AGE_MS, SEAT_SAMPLES, seatBonus } from '../domains/capacity/seats.ts'
import { type LeadGrowth, leadGrowth, learnLeadCost } from '../domains/capacity/leadcost.ts'
import { DISK_RAMP_MS, type DiskFit, diskHeadroomMib, learnedWorktreeMib } from '../domains/capacity/disk.ts'
import {
  type LoadTrip,
  loadTrip,
  type MemoryCeilings,
  type MemoryReading,
  reservedOf,
  SUSTAINED_LOAD_SAMPLES,
  sustainedSwapoutMb,
} from '../domains/capacity/host.ts'
import { testLineOf } from '../domains/capacity/slots.ts'
import { type LaneInput, laneRoom } from '../domains/capacity/lanes.ts'
import type { AccountDesk, AccountSource, Assignment, HostReader } from '../domains/capacity/ports.ts'
import { effectiveState, type QueueStates } from '../domains/capacity/queue-state.ts'
import { type Claim, type Claimant, claimRoom, holdsClaim } from '../domains/capacity/claims.ts'
import { planWaits, type SeenWait, waitKindOf } from '../domains/capacity/waits.ts'
import type { Edge } from '../domains/planning/chain.ts'
import type { CapacityFacts } from '../domains/loops/ports.ts'
import type { OpenIssueRow } from '../domains/planning/ports.ts'
import { type ChainReason, type OpenIssue, orderQueue } from '../domains/planning/queue.ts'
import { projectOf, type StoredProject } from '../domains/planning/sync.ts'
import { replay } from '../domains/work/machine.ts'
import { type IssueId, issueNumber } from '../kernel/ids.ts'
import { key } from '../kernel/keys.ts'
import { err, ok, portError, type PortError, type Result } from '../kernel/result.ts'
import { recordIn } from './issues.ts'
import type { PlanningDeps, PlanningStores } from './planning-deps.ts'
import { satisfyEdges } from './planning-pass.ts'

export interface CapacityLimits {
  /** the cap of an account `accountLeads` does not name */
  leadsPerAccount: number
  /** each named account's own cap (`FACTORY_ACCOUNT_LEADS`) */
  accountLeads?: ReadonlyMap<string, number>
  loadCeiling: number
  /** no new lead above this many processes; null or absent: no cap */
  processCap?: number | null
  memoryCeilings: MemoryCeilings
  /** `FACTORY_SEATS_MAX_BONUS`: the most extra leads per account while the host idles; absent or 0: off */
  seatsMaxBonus?: number
}

export interface CapacityDeps extends PlanningDeps {
  host: HostReader
  /** the projects' own doctors; absent: no project is asked whether this host can run it */
  doctor?: DoctorReader
  accounts: AccountSource
  /** the accounts' read model and the mode override, from `packages/accounts` (`GET /v1/accounts`) */
  desk: AccountDesk
  limits: CapacityLimits
}

/** What the host said this pass; a reading that could not be taken is null and admission goes on without it. */
export interface HostInputs {
  load: number | null
  /** the host's process count by the newest minute sample, not older than three minutes; null: unknown */
  processes: number | null
  memory: MemoryReading | null
  /** the machine's RAM in MiB; null: the lanes' memory cannot be counted */
  ramMib: number | null
  /** how long the host has been up; null: unread, and the boot grace does not apply */
  uptimeMs: number | null
  /** the newest minute samples of the host, newest first, for the boot grace */
  samples: readonly BootSample[]
  /** the memory free by the newest minute sample (not older than five minutes); null: unknown */
  freeMib: number | null
  /** when that sample was taken: a lead that started after it is not in `freeMib` yet */
  freeAt: Date | null
  /** per project name: what a lead is learned to take (null with fewer than three attempts since the relearn point), by which rule, and the attempts sampled */
  learned: ReadonlyMap<
    string,
    { mib: number | null; attempts: number; basis: 'median' | 'falling' | null; typicalMib: number | null }
  >
  /** the free and total disk of the volume the worktrees live on; null: unread, and no lead is kept out for disk */
  disk?: { freeMib: number; totalMib: number } | null
  /** per project name: what a worktree is learned to take on disk (null with fewer than three attempts measured), and the attempts measured */
  worktrees?: ReadonlyMap<string, { mib: number | null; attempts: number }>
  /** per project name: the relearn point, when the repo has one */
  relearns: ReadonlyMap<string, Date>
  /** per Issue number: the MiB its lead holds by a sample not older than three minutes */
  rssByIssue: ReadonlyMap<number, number>
  /** the newest five minute samples, newest first; empty unless all five exist and none is older than six minutes */
  recent: readonly { load: number | null; swapUsedPct: number | null }[]
  /** per project name: why its doctor says this host cannot run it; a project whose doctor is green, or has none, is absent */
  doctors: ReadonlyMap<string, string>
  /**
   * the lead aim (`domains/capacity/slot-aim.ts`): its count (0 before its first minute) and whether the newest minute sample,
   * not older than five minutes, read the pressure level; absent or null (an unread host): no aim, the memory fit decides alone
   */
  leadAim?: { target: number; pressureRead: boolean } | null
  /** the load tripwire over the minute samples; absent or null: too few fresh samples, the instant reading decides */
  loadTrip?: LoadTrip
  /** the host's test line now; absent or null: unread, it keeps nobody out */
  tests?: TestLine | null
  notes: string[]
}

const NO_HOST: HostInputs = {
  load: null,
  processes: null,
  memory: null,
  ramMib: null,
  uptimeMs: null,
  samples: [],
  freeMib: null,
  freeAt: null,
  learned: new Map(),
  relearns: new Map(),
  rssByIssue: new Map(),
  recent: [],
  doctors: new Map(),
  notes: [],
}

/** The steps whose median run is how long a step takes, for the test line (`lineRefusal`): those of the last day. */
const STEP_WINDOW_MS = 86_400_000

/** A lead's own sample is read as what it holds now only when it is this fresh. */
const RSS_MAX_AGE_MS = 3 * 60_000

export type QueueReasonKind = ChainReason['kind'] | RefusalKind

/** Why a queued Issue stays queued: the word the owner reads, with the numbers. */
export interface QueueReason {
  kind: QueueReasonKind
  message: string
  /** when a reading says the reason may end */
  opensAt: Date | null
  /** `fit`: the memory refusal is the learned cost of the candidate's lead (see `waitKindOf`); `aim`: the lead aim's count */
  part?: 'fit' | 'aim'
}

export interface QueueEntry {
  issue: IssueId
  repo: string
  project: string | null
  kind: string
  prio: number
  /** null: nothing keeps it out; it is admitted when it is its turn */
  reason: QueueReason | null
  /** the account it would run on, when nothing keeps it out */
  account: string | null
  /**
   * Only for an Issue its `after` edges hold: whether it would be admitted this look with the edges gone (nothing else keeps
   * it out and every admission rule passes for it). Absent for an Issue the chain does not hold.
   */
  readyWithoutEdges?: boolean
}

interface Snapshot {
  now: Date
  projects: StoredProject[]
  issues: (OpenIssueRow & { project: string | null })[]
  edges: Edge[]
  prio: Map<IssueId, number>
  /** the place of each Issue in the queue model's newest order: the tie-break of the queue order */
  queueOrder: Map<IssueId, number>
  claims: Claim[]
  readings: AccountReading[]
  states: QueueStates
  assignments: Assignment[]
  /** the account each owed lead resumes on: its newest assignment, however old */
  owedAccounts: Map<IssueId, string>
}

/** Reads what a host reading and an account poll say, outside any transaction. */
export async function readHost(deps: CapacityDeps): Promise<HostInputs> {
  const notes: string[] = []
  const load = await deps.host.load()
  const memory = await deps.host.memory()
  const ram = await deps.host.ramMib()
  if (!load.ok) notes.push(`load reading failed (${load.error.detail}): new leads are admitted without it`)
  if (!memory.ok) {
    notes.push(
      `memory reading failed (${memory.error.detail}): new leads are admitted without it, the next pass reads again`,
    )
  }
  if (!ram.ok) notes.push(`RAM reading failed (${ram.error.detail}): the memory that lanes reserve is not counted`)
  const ramMib = ram.ok ? ram.value : null
  const uptime = await deps.host.uptimeMs()
  if (!uptime.ok) notes.push(`uptime reading failed (${uptime.error.detail}): the boot grace does not apply this pass`)
  const now = deps.clock.now()
  const facts = await deps.uow.run(async ({ capacity, planning }) =>
    ok({
      projects: deps.doctor ? await planning.projects() : [],
      latest: await capacity.latestHostSample(),
      recent: await capacity.recentHostSamples(Math.max(SEAT_SAMPLES, SUSTAINED_LOAD_SAMPLES)),
      slots: await capacity.slots(),
      stepMs: await capacity.stepMedianMs(new Date(now.getTime() - STEP_WINDOW_MS)),
      peaks: await capacity.leadPeaks(now),
      sizes: await capacity.worktreeSizes(),
      relearns: await capacity.relearns(),
      rss: await capacity.leadRssSince(new Date(now.getTime() - RSS_MAX_AGE_MS)),
      leadAim: (await capacity.leadAim())?.target ?? 0,
    }),
  )
  if (!facts.ok)
    notes.push(`the learned lead costs could not be read (${facts.error.detail}): admission goes on without them`)
  const fresh = facts.ok
    ? facts.value.recent.length >= SEAT_SAMPLES &&
      facts.value.recent.slice(0, SEAT_SAMPLES).every((s) => now.getTime() - s.at.getTime() <= SEAT_SAMPLE_MAX_AGE_MS)
    : false
  const newest = facts.ok ? facts.value.recent[0] : undefined
  const doctors = await readDoctors(deps.doctor, facts.ok ? facts.value.projects : [])
  const disk = deps.host.disk ? await deps.host.disk() : null
  if (disk && !disk.ok) notes.push(`disk reading failed (${disk.error.detail}): new leads are admitted without it`)
  return {
    disk: disk?.ok ? disk.value : null,
    worktrees: new Map(
      facts.ok
        ? facts.value.sizes.map((s) => [
            s.repo,
            { mib: learnedWorktreeMib(s.sizesMibNewestFirst), attempts: s.attempts },
          ])
        : [],
    ),
    load: load.ok ? load.value : null,
    processes: newest && now.getTime() - newest.at.getTime() <= RSS_MAX_AGE_MS ? newest.processes : null,
    // The instant reading (a rate since the last pass) and the minute samples' 300 s window: the higher gates, so a lull
    // between swapout bursts does not open the gate (Issue 858).
    memory: memory.ok
      ? {
          ...memory.value,
          swapoutMbPer300s: Math.max(
            memory.value.swapoutMbPer300s,
            facts.ok ? sustainedSwapoutMb(facts.value.recent, now) : 0,
          ),
        }
      : null,
    ramMib,
    uptimeMs: uptime.ok ? uptime.value : null,
    // Without the samples the grace has nothing to go on, and a booting host admits nothing.
    samples: facts.ok ? facts.value.recent : [],
    freeMib: facts.ok ? freeMibOf(facts.value.latest, ramMib, now) : null,
    freeAt: facts.ok ? (facts.value.latest?.at ?? null) : null,
    learned: new Map(
      facts.ok
        ? facts.value.peaks.map((p) => {
            const lead = learnLeadCost(p.peaksNewestFirst)
            return [
              p.repo,
              {
                mib: lead?.mib ?? null,
                attempts: p.attempts,
                basis: lead?.basis ?? null,
                typicalMib: lead?.typicalMib ?? null,
              },
            ]
          })
        : [],
    ),
    relearns: new Map(facts.ok ? facts.value.relearns.map((r) => [r.repo, r.at]) : []),
    rssByIssue: facts.ok ? facts.value.rss : new Map(),
    recent:
      facts.ok && fresh
        ? facts.value.recent.slice(0, SEAT_SAMPLES).map((s) => ({ load: s.load, swapUsedPct: s.swapUsedPct }))
        : [],
    doctors,
    leadAim: facts.ok
      ? {
          target: facts.value.leadAim,
          pressureRead:
            newest !== undefined &&
            now.getTime() - newest.at.getTime() <= SAMPLE_MAX_AGE_MS &&
            newest.pressureLevel !== null,
        }
      : null,
    loadTrip: facts.ok ? loadTrip(facts.value.recent, deps.limits.loadCeiling, now, load.ok ? load.value : null) : null,
    tests: facts.ok ? { ...testLineOf(facts.value.slots, now), stepMs: facts.value.stepMs } : null,
    notes,
  }
}

/**
 * Asks the doctor of every project that declares one (the reader keeps a reading until it is due, so this is seldom a run) and
 * answers the refusal of each whose doctor is red. A doctor that cannot be run is no reading: that project is admitted.
 */
async function readDoctors(
  reader: DoctorReader | undefined,
  projects: readonly StoredProject[],
): Promise<Map<string, string>> {
  const red = new Map<string, string>()
  if (!reader) return red
  const asked = projects.filter((p) => p.project.doctor !== null && !p.project.work)
  const readings = await Promise.all(
    asked.map((p) => reader.read({ project: p.name, repo: p.repo, command: p.project.doctor as string })),
  )
  asked.forEach((p, i) => {
    const reading = readings[i]
    if (reading && !reading.ok) red.set(p.name, doctorMessage(p.name, reading))
  })
  return red
}

/**
 * Reads the accounts through `packages/accounts` (the registry, the cache files, the modes in force) and stores the readings
 * as facts, each with the package's verdict for the bulk lane: whether the account takes work, its place, why not and when
 * it opens. A failed read stores nothing; the stored readings go stale and admit nothing.
 */
export async function refreshAccounts(deps: CapacityDeps): Promise<Result<AccountReading[], PortError>> {
  const read = await deps.accounts.read(deps.clock.now())
  if (!read.ok) return read
  return deps.uow.run(async ({ capacity }) => {
    await capacity.lock()
    await capacity.recordReadings(read.value)
    return ok(read.value)
  })
}

/** Polls when the newest reading is older than a minute; a failed poll leaves the stored readings (stale ones admit nothing). */
export async function pollIfDue(deps: CapacityDeps): Promise<string[]> {
  const latest = await deps.uow.run(async ({ capacity }) => ok(await capacity.latestReadings()))
  const now = deps.clock.now().getTime()
  const newest = latest.ok ? Math.max(0, ...latest.value.map((r) => r.readAt.getTime())) : 0
  if (latest.ok && newest > 0 && now - newest < POLL_EVERY_MS) return []
  const notes: string[] = []
  const polled = await refreshAccounts(deps)
  if (!polled.ok) notes.push(`account poll failed (${polled.error.detail}): admission goes on the readings it has`)
  return notes
}

async function snapshotOf(stores: PlanningStores, now: Date): Promise<Snapshot> {
  const projects = await stores.planning.projects()
  const rows = await stores.reads.open()
  const claims = await stores.capacity.claims()
  const taken = new Set(claims.map((claim) => claim.issue))
  const owedIds = rows.filter((row) => holdsClaim(row.state, row.waitReason) && !taken.has(row.id)).map((row) => row.id)
  return {
    now,
    projects,
    issues: rows.map((row) => ({ ...row, project: projectOf(projects, row.repo)?.name ?? null })),
    edges: await stores.planning.edges(),
    prio: await stores.planning.prios(),
    queueOrder: await stores.planning.queueOrder(),
    claims,
    readings: await stores.capacity.latestReadings(),
    states: await stores.capacity.queueStates(),
    assignments: await stores.capacity.recentAssignments(),
    owedAccounts: latestAccounts(await stores.capacity.latestAssignments(owedIds)),
  }
}

/** The claims of Issues that no longer work in their repo go back; run under the capacity lock. */
async function sweepClaims(stores: PlanningStores, snap: Snapshot): Promise<IssueId[]> {
  const holding = new Set(snap.issues.filter((i) => holdsClaim(i.state, i.waitReason)).map((i) => i.id))
  const stale = snap.claims.filter((claim) => !holding.has(claim.issue)).map((claim) => claim.issue)
  if (stale.length === 0) return []
  const released = await stores.capacity.releaseClaims(stale)
  snap.claims = snap.claims.filter((claim) => !released.includes(claim.issue))
  return released
}

const claimantOf = (issue: IssueId, kind: string, since: Date | null = null): Claimant => ({
  issue,
  urgent: kind === 'incident',
  since,
})

/**
 * The candidate's lane with the repo's cap on it and the Issues running in it: the repo's claim holders and the leads
 * that work without a claim (owed, a resumed wait) both count, since both are leads at work. Null when the Issue has no
 * lane or the project declares no cap on it (an undeclared lane is unlimited within `leads`).
 */
function laneOf(
  candidate: IssueId,
  project: StoredProject,
  claims: readonly Claim[],
  owed: readonly (OpenIssueRow & { project: string | null })[],
  laneByIssue: ReadonlyMap<IssueId, string | null>,
): LaneInput | null {
  const name = laneByIssue.get(candidate)
  const cap = name ? project.project.lanes[name]?.leads : undefined
  if (!name || cap === undefined) return null
  const holders = [
    ...claims.filter((c) => c.repo === project.repo).map((c) => c.issue),
    ...owed.filter((o) => o.project === project.name).map((o) => o.id),
  ].filter((id) => id !== candidate && laneByIssue.get(id) === name)
  return { name, cap, holders }
}

/**
 * The host memory the lanes reserve for this candidate's admission, in MiB: every running lead (a claim holder or an owed
 * lead, in any repo, since memory is the host's) whose lane declares a `memory`, and the candidate's own lane. The
 * reading shows the memory a lead has taken; this is what a lead that has just started is about to take.
 */
function reservedMib(
  candidate: IssueId,
  candidateProject: StoredProject,
  claims: readonly Claim[],
  owed: readonly (OpenIssueRow & { project: string | null })[],
  projects: readonly StoredProject[],
  laneByIssue: ReadonlyMap<IssueId, string | null>,
  learned: HostInputs['learned'],
): number {
  // What a repo's leads are learned to take replaces the lane's constant; the constant stays the prior for a repo with fewer than three attempts.
  const memoryOf = (issue: IssueId, project: StoredProject | undefined): number => {
    const lane = laneByIssue.get(issue)
    if (project && learned.get(project.name)?.mib != null) return 0
    return (lane && project?.project.lanes[lane]?.memoryMib) || 0
  }
  const byRepo = new Map(projects.map((p) => [p.repo, p]))
  const byName = new Map(projects.map((p) => [p.name, p]))
  const running = [
    ...claims.map((c) => memoryOf(c.issue, byRepo.get(c.repo))),
    ...owed.map((o) => memoryOf(o.id, o.project === null ? undefined : byName.get(o.project))),
  ]
  return running.reduce((sum, mib) => sum + mib, 0) + memoryOf(candidate, candidateProject)
}

/**
 * What the running leads will take that the free reading does not show yet, host-wide (memory is the host's): a claim that
 * started within `RAMP_MS` of the host sample the free figure comes from, or after it, takes its repo's learned size less
 * what its newest sample holds. A lead this pass admitted has no sample and takes the whole figure, so one pass cannot
 * admit several against the same reading.
 */
function youngGrowth(claims: readonly Claim[], snap: Snapshot, host: HostInputs): LeadGrowth {
  const nameOf = new Map(snap.projects.map((p) => [p.repo, p.name]))
  return leadGrowth(
    claims.map((claim) => ({
      learnedMib: host.learned.get(nameOf.get(claim.repo) ?? '')?.mib ?? null,
      heldMib: host.rssByIssue.get(issueNumber(claim.issue)) ?? null,
      ageMs: (host.freeAt ?? snap.now).getTime() - claim.takenAt.getTime(),
    })),
  )
}

/**
 * Every queued Issue in queue order with the reason it stays queued, or nothing when it may be admitted. Each Issue is
 * decided as if the ones before it were admitted (they take a claim and an account), so the reasons of the later ones
 * are the ones they would meet in turn. Pure: the snapshot and the host readings are passed in.
 */
function evaluateQueue(snap: Snapshot, host: HostInputs, limits: CapacityLimits): QueueEntry[] {
  const base = decide(snap, host, limits, 0)
  const bonus = seatBonusOf(snap, host, limits, base)
  return bonus > 0 ? decide(snap, host, limits, bonus) : base
}

/**
 * The extra leads per account an idle host allows this pass: for the entries that stay queued for the account cap, as
 * many leads of the repos' typical learned size as the free memory holds. Never past a window: the pick still follows it.
 */
/**
 * What the claims that just started will still take on disk, host-wide: each claim younger than `DISK_RAMP_MS` is counted at its
 * repo's learned worktree size, since the checkout and the install that fill it take minutes and the free reading does not show
 * them yet. A lead admitted in this pass has no age and counts whole, so one pass cannot admit several against one reading.
 */
function youngDiskMib(claims: readonly Claim[], snap: Snapshot, host: HostInputs): number {
  const nameOf = new Map(snap.projects.map((p) => [p.repo, p.name]))
  return claims.reduce((sum, claim) => {
    if (snap.now.getTime() - claim.takenAt.getTime() >= DISK_RAMP_MS) return sum
    return sum + (host.worktrees?.get(nameOf.get(claim.repo) ?? '')?.mib ?? 0)
  }, 0)
}

function seatBonusOf(snap: Snapshot, host: HostInputs, limits: CapacityLimits, base: readonly QueueEntry[]): number {
  const capped = base.filter((entry) => entry.reason?.kind === 'cap')
  if (capped.length === 0) return 0
  const learnedOf = (entry: QueueEntry): number | null => {
    return entry.project === null ? null : (host.learned.get(entry.project)?.mib ?? null)
  }
  const known = capped.map(learnedOf).filter((mib): mib is number => mib !== null)
  return seatBonus({
    recent: host.recent,
    loadCeiling: limits.loadCeiling,
    swapCeilingPct: limits.memoryCeilings.swapUsedPct,
    queued: capped.length,
    freeMib: host.freeMib,
    typicalLeadMib: known.length > 0 ? Math.max(...known) : DEFAULT_TYPICAL_LEAD_MIB,
    headroomMib: headroomMib(host.ramMib),
    maxBonus: limits.seatsMaxBonus ?? 0,
  })
}

/** The account each Issue was last admitted on (the newest attempt's, so a list of one attempt each or newest first). */
function latestAccounts(assignments: readonly Assignment[]): Map<IssueId, string> {
  const accounts = new Map<IssueId, string>()
  for (const a of assignments) if (!accounts.has(a.issue)) accounts.set(a.issue, a.account)
  return accounts
}

/**
 * The leads on each account for the cap: every claim, and every owed lead on the account it will resume on. A woken
 * lead is pinned to the account of its latest assignment and takes its place back whatever the cap says (see `resumeClaim`), so from the
 * moment its wait ends the seat is its: a new lead must not take it, or the account would run over the cap the moment
 * the resume lands. Only owed leads count. A lead still in a wait that gave its claim up is idle and uses nothing.
 */
function leadsOnAccounts(
  claims: readonly Claim[],
  owed: readonly { id: IssueId }[],
  accountByIssue: ReadonlyMap<IssueId, string>,
): Map<string, number> {
  const leads = new Map<string, number>()
  const add = (account: string | null | undefined) => {
    if (account) leads.set(account, (leads.get(account) ?? 0) + 1)
  }
  for (const claim of claims) add(claim.account)
  for (const o of owed) add(accountByIssue.get(o.id))
  return leads
}

/** The accounts that took a lead after their latest sample: the sample does not show it yet. */
function loadedAccounts(snap: Snapshot): Set<string> {
  const loaded = new Set<string>()
  for (const reading of snap.readings) {
    if (!reading.sampledAt) continue
    if (snap.assignments.some((a) => a.account === reading.account && a.assignedAt >= (reading.sampledAt as Date))) {
      loaded.add(reading.account)
    }
  }
  return loaded
}

function decide(snap: Snapshot, host: HostInputs, limits: CapacityLimits, bonus: number): QueueEntry[] {
  const open: OpenIssue[] = snap.issues.map((i) => ({
    id: i.id,
    project: i.project,
    kind: i.kind,
    state: i.state,
    waitReason: i.waitReason,
    finalizing: i.finalizing,
    specPending: i.specPending,
    size: i.size,
    since: i.since,
  }))
  const ordered = orderQueue({ open, edges: snap.edges, prio: snap.prio, now: snap.now, modelOrder: snap.queueOrder })
  const claims = [...snap.claims]
  const taken = new Set(claims.map((s) => s.issue))
  const loaded = loadedAccounts(snap)
  const repoOf = new Map(snap.issues.map((i) => [i.id, i.repo]))
  const laneByIssue = new Map(snap.issues.map((i) => [i.id, i.lane]))
  const projectByName = new Map(snap.projects.map((p) => [p.name, p]))
  const owed = snap.issues.filter((i) => holdsClaim(i.state, i.waitReason) && !taken.has(i.id) && i.project !== null)
  // The boot grace's gap: the newest admission of any lead, and each one this look admits in turn.
  let lastAdmittedAt: Date | null = snap.assignments.reduce<Date | null>(
    (newest, a) => (newest === null || a.assignedAt > newest ? a.assignedAt : newest),
    null,
  )

  /** The admission rules for `issue` against the claims as they stand now; changes nothing. */
  const verdictFor = (issue: OpenIssue, project: StoredProject) => {
    const leadsByAccount = leadsOnAccounts(claims, owed, snap.owedAccounts)
    const learned = host.learned.get(project.name)
    const leadFit: LeadFit = {
      repo: project.name,
      candidateMib: learned?.mib ?? null,
      attempts: learned?.attempts ?? 0,
      basis: learned?.basis ?? 'median',
      typicalMib: learned?.typicalMib ?? null,
      relearnedAt: host.relearns.get(project.name) ?? null,
      freeMib: host.freeMib,
      // under the lead aim the headroom is the pressure level's to keep: the fit refuses only what cannot fit at all
      headroomMib: host.leadAim ? 0 : headroomMib(host.ramMib),
      running: claims.length,
      growing: youngGrowth(claims, snap, host),
    }
    const worktree = host.worktrees?.get(project.name)
    const diskFit: DiskFit | null = host.disk
      ? {
          repo: project.name,
          candidateMib: worktree?.mib ?? null,
          attempts: worktree?.attempts ?? 0,
          freeMib: host.disk.freeMib,
          headroomMib: diskHeadroomMib(host.disk.totalMib),
          running: claims.length,
          growingMib: youngDiskMib(claims, snap, host),
        }
      : null
    return checkAdmission({
      lane: laneOf(issue.id, project, claims, owed, laneByIssue),
      now: snap.now,
      state: effectiveState(snap.states, project.name),
      doctor: host.doctors.get(project.name) ?? null,
      leads: project.project.leads,
      holders: claims.filter((s) => s.repo === project.repo).map((s) => ({ issue: s.issue, urgent: s.urgent })),
      owed: owed.filter((o) => o.project === project.name).map((o) => claimantOf(o.id, o.kind, o.since)),
      candidate: claimantOf(issue.id, issue.kind),
      boot:
        host.uptimeMs === null
          ? null
          : {
              uptimeMs: host.uptimeMs,
              samples: host.samples,
              lastAdmittedAt,
              load: host.load,
              loadCeiling: limits.loadCeiling,
            },
      load: host.load,
      loadCeiling: limits.loadCeiling,
      loadTrip: host.loadTrip ?? null,
      tests: host.tests ?? null,
      processes: host.processes,
      processCap: limits.processCap ?? null,
      memory: host.memory,
      memoryCeilings: limits.memoryCeilings,
      leadFit,
      diskFit,
      leadAim: host.leadAim ? { ...host.leadAim, running: claims.length } : null,
      reserved: reservedOf(
        reservedMib(issue.id, project, claims, owed, snap.projects, laneByIssue, host.learned),
        host.ramMib,
      ),
      accounts: snap.readings,
      loaded,
      leadsByAccount,
      leadsPerAccount: limits.leadsPerAccount + bonus,
      accountLeads: limits.accountLeads,
      seatBonus: bonus,
    })
  }

  return ordered.map((row): QueueEntry => {
    const { issue } = row
    const base = {
      issue: issue.id,
      repo: repoOf.get(issue.id) ?? '',
      project: issue.project,
      kind: issue.kind,
      prio: row.prio,
    }
    if (row.reason) {
      const reason = { ...row.reason, opensAt: null }
      if (row.reason.kind !== 'chain') return { ...base, reason, account: null }
      // Held by its edges: would it run without them? Nothing of the chain's keeps it out and the rules let it in.
      const held = issue.project === null ? undefined : projectByName.get(issue.project)
      const ready = row.withoutEdges === null && held !== undefined && verdictFor(issue, held).admit
      return { ...base, reason, account: null, readyWithoutEdges: ready }
    }
    const project = issue.project === null ? undefined : projectByName.get(issue.project)
    if (!project) return { ...base, reason: null, account: null }
    const verdict = verdictFor(issue, project)
    if (!verdict.admit) return { ...base, reason: verdict.refusal, account: null }
    claims.push({
      issue: issue.id,
      repo: project.repo,
      urgent: issue.kind === 'incident',
      account: verdict.account.account,
      takenAt: snap.now,
    })
    loaded.add(verdict.account.account)
    lastAdmittedAt = snap.now
    return { ...base, reason: null, account: verdict.account.account }
  })
}

export interface Admitted {
  issue: IssueId
  attempt: number
  account: string
  repo: string
}

export interface PassResult {
  admitted: Admitted[]
  /** the queue as the last look found it, in order, each with the reason it stays queued */
  queue: QueueEntry[]
  notes: string[]
}

type Step = { admitted: Admitted | null; skipped: IssueId | null; queue: QueueEntry[] }

/**
 * Admits the first Issue in queue order that nothing keeps out, deciding everything again inside one transaction:
 * under the capacity lock, the chain, the claims, the queue state, the host and the accounts are looked at as they stand,
 * and `admitted` is recorded together with the claim and the account (its `start_lead` effect is package 4's).
 */
async function admitOne(
  deps: CapacityDeps,
  host: HostInputs,
  skip: ReadonlySet<IssueId>,
): Promise<Result<Step, PortError>> {
  return deps.uow.run(async (stores) => {
    await stores.capacity.lock()
    const now = deps.clock.now()
    await satisfyEdges(stores, now)
    const snap = await snapshotOf(stores, now)
    await sweepClaims(stores, snap)
    const queue = evaluateQueue(snap, host, deps.limits)
    const next = queue.find((entry) => entry.account !== null && entry.reason === null && !skip.has(entry.issue))
    if (!next || next.account === null) return ok<Step>({ admitted: null, skipped: null, queue })

    const history = await stores.work.history(next.issue)
    if (!history) return err(portError('refused', `Issue ${issueNumber(next.issue)} vanished`))
    const attempt = replay(next.issue, history).attempt + 1
    const recorded = await recordIn(stores.work, deps, {
      issueId: next.issue,
      key: key('admit', next.issue, attempt),
      event: { kind: 'admitted', payload: {}, actor: 'factory' },
    })
    if (!recorded.ok) return err(portError('refused', JSON.stringify(recorded.error)))
    // The machine said no (the Issue moved since the look): nothing is kept, the next look finds it as it is.
    if (recorded.value.result !== 'applied') return ok<Step>({ admitted: null, skipped: next.issue, queue })

    await stores.capacity.takeClaim({
      issue: next.issue,
      repo: snap.projects.find((p) => p.name === next.project)?.repo ?? next.repo,
      urgent: next.kind === 'incident',
      account: next.account,
      takenAt: now,
    })
    await stores.capacity.assign({
      issue: next.issue,
      attempt,
      account: next.account,
      repo: next.repo,
      assignedAt: now,
    })
    return ok<Step>({
      admitted: { issue: next.issue, attempt, account: next.account, repo: next.repo },
      skipped: null,
      queue,
    })
  })
}

/** The queue intervals are kept 400 days, as the hourly class rollups (a few rows per Issue). */
const WAITS_KEEP_MS = 400 * 86_400_000

/**
 * Records what the last look found each queued Issue waiting for (`factory.queue_intervals`): an Issue with a reason has an
 * open interval of that kind, a new one begins only when the kind changes, and an Issue that left the queue (admitted,
 * closed) or has no reason any more ends its interval at this look. A failure is a note, never the pass's.
 */
async function recordWaits(deps: CapacityDeps, queue: readonly QueueEntry[], notes: string[]): Promise<void> {
  const seen: SeenWait[] = queue.flatMap((entry) =>
    entry.reason
      ? [
          {
            issue: entry.issue,
            project: entry.project ?? entry.repo,
            kind: waitKindOf(entry.reason),
            message: entry.reason.message,
          },
        ]
      : [],
  )
  const stored = await deps.uow.run(async ({ capacity }) => {
    await capacity.lock()
    const now = deps.clock.now()
    await capacity.applyWaits(now, planWaits(await capacity.openWaits(), seen), new Date(now.getTime() - WAITS_KEEP_MS))
    return ok(undefined)
  })
  if (!stored.ok) notes.push(`the queue intervals could not be stored (${stored.error.detail})`)
}

/**
 * Records, on the unsatisfied edges of each Issue the chain holds, whether this look would have admitted it without them
 * (`planning_edges.ready_since`). A failure is a note, never the pass's.
 */
async function recordReadiness(deps: CapacityDeps, queue: readonly QueueEntry[], notes: string[]): Promise<void> {
  const held = queue.filter((entry) => entry.readyWithoutEdges !== undefined)
  const stored = await deps.uow.run(async ({ capacity, planning }) => {
    await capacity.lock()
    await planning.noteReadiness(deps.clock.now(), {
      ready: held.filter((entry) => entry.readyWithoutEdges).map((entry) => entry.issue),
      held: held.filter((entry) => !entry.readyWithoutEdges).map((entry) => entry.issue),
    })
    return ok(undefined)
  })
  if (!stored.ok) notes.push(`the edges' readiness could not be stored (${stored.error.detail})`)
}

/**
 * The host readings with the load read now. A reading that fails keeps the pass's last one (`readHost` already noted a
 * failure), so a host that answered before is never admitted into without a load because of one slow `sysctl`. A
 * tripped tripwire is cleared by a reading now back under the ceiling, as `loadTrip` clears it.
 */
async function withFreshLoad(deps: CapacityDeps, host: HostInputs): Promise<HostInputs> {
  const load = await deps.host.load()
  if (!load.ok) return host
  const cleared = host.loadTrip?.tripped && load.value <= deps.limits.loadCeiling
  return { ...host, load: load.value, ...(cleared ? { loadTrip: { tripped: false } as const } : {}) }
}

/** The most Issues one pass admits; the rest wait for the next. */
const PASS_LIMIT = 20

/**
 * The admission pass: poll the accounts if the readings are old, read the host once (the load is read again before each
 * admission), then admit one Issue at a time, each decided again in its own transaction, until nothing more may start. Replay-safe: the event key names the
 * attempt, so a second pass admits nothing twice.
 */
export async function admissionPass(
  deps: CapacityDeps,
  options: { limit?: number } = {},
): Promise<Result<PassResult, PortError>> {
  const notes = await pollIfDue(deps)
  const first = await readHost(deps)
  notes.push(...first.notes)
  let host = first
  const admitted: Admitted[] = []
  const skip = new Set<IssueId>()
  let queue: QueueEntry[] = []
  for (let i = 0; i < (options.limit ?? PASS_LIMIT); i++) {
    // The load is read again before every admission, not once for the pass: the doctors and the
    // admissions before this one all take time, and the 1-minute load moves by tens in a minute on a busy host (Issue 1742:
    // a lead admitted with the load over its ceiling on the samples either side).
    host = await withFreshLoad(deps, host)
    const step = await admitOne(deps, host, skip)
    if (!step.ok) return step
    queue = step.value.queue
    if (step.value.skipped) skip.add(step.value.skipped)
    if (!step.value.admitted) {
      if (step.value.skipped) continue
      break
    }
    admitted.push(step.value.admitted)
  }
  await recordWaits(deps, queue, notes)
  await recordReadiness(deps, queue, notes)
  return ok({ admitted, queue, notes })
}

/** One line per repo with a relearn point: since when its lead cost is learned and what that gives now. */
function relearnNotes(host: HostInputs): string[] {
  return [...host.relearns].map(([repo, at]) => {
    const learned = host.learned.get(repo)
    const figure =
      learned?.mib != null
        ? `a lead takes ~${Math.round((learned.mib / 1024) * 10) / 10} GiB (${learned.basis === 'falling' ? 'the largest of the newest 3 settled leads' : `median of the newest ${Math.min(learned.attempts, 10)}`})`
        : `${learned?.attempts ?? 0} attempts since, fewer than three: the lane's memory prior`
    return `${repo}: lead cost learned from after the relearn point ${at.toISOString()}: ${figure}`
  })
}

/** The queue as it stands, in order, with the reason each Issue stays queued. Reads only. */
export async function queueView(
  deps: CapacityDeps,
): Promise<Result<{ queue: QueueEntry[]; notes: string[] }, PortError>> {
  const notes = await pollIfDue(deps)
  const host = await readHost(deps)
  host.notes.unshift(...notes)
  host.notes.push(...relearnNotes(host))
  const viewed = await deps.uow.run(async (stores) => {
    const snap = await snapshotOf(stores, deps.clock.now())
    return ok(evaluateQueue(snap, host, deps.limits))
  })
  return viewed.ok ? ok({ queue: viewed.value, notes: host.notes }) : viewed
}

/**
 * What capacity holds right now, for the host loop's minute sample: the claims held, the Issues in the queue, the leads
 * the enabled accounts may hold and the load ceiling. From the stored readings alone (no poll, no host reading).
 */
export async function capacityFacts(deps: CapacityDeps): Promise<Result<CapacityFacts, PortError>> {
  return deps.uow.run(async (stores) => {
    const snap = await snapshotOf(stores, deps.clock.now())
    return ok({
      leads: snap.claims.length,
      queued: evaluateQueue(snap, NO_HOST, deps.limits).length,
      seats: snap.readings
        .filter((r) => r.enabled)
        .reduce((sum, r) => sum + (deps.limits.accountLeads?.get(r.account) ?? deps.limits.leadsPerAccount), 0),
      loadCeiling: deps.limits.loadCeiling,
    })
  })
}

/**
 * The queued Issues that stay queued for lack of a claim, from the stored readings alone: no account poll and no host
 * reading (a null load and memory are skipped, as in a failed reading), so what is left is the chain and the repo's
 * claims. A deadlock is a deadlock whatever the load is, and the steward calls this every pass.
 */
export async function claimQueued(deps: CapacityDeps): Promise<Result<{ issue: IssueId; repo: string }[], PortError>> {
  const viewed = await deps.uow.run(async (stores) => {
    const snap = await snapshotOf(stores, deps.clock.now())
    return ok(evaluateQueue(snap, NO_HOST, deps.limits))
  })
  if (!viewed.ok) return viewed
  return ok(viewed.value.filter((q) => q.reason?.kind === 'claim').map((q) => ({ issue: q.issue, repo: q.repo })))
}

/**
 * What keeps a lead back from a wait out of its repo's claim, or null when it would take it now: its lane's cap, then
 * the repo's claims with the resumed leads served first (oldest wait first, then the lower Issue). The account is
 * never a reason: the lead is pinned to the account of its latest assignment (`moveWalled` changes it only while the lead is walled) and resumes there whatever the cap says. The
 * resume itself and the steward's stall check both ask this, so the two cannot disagree about who is waiting.
 */
function resumeBlock(snap: Snapshot, row: Snapshot['issues'][number], project: StoredProject): string | null {
  const issue = row.id
  // A lead back from a wait gave its lane place up with its claim, so a lead of the lane may have started meanwhile.
  // Only the lane's claim holders count here: another owed lead of the lane would otherwise wait for this one.
  const laneFree = laneRoom({
    lane: laneOf(issue, project, snap.claims, [], new Map(snap.issues.map((i) => [i.id, i.lane]))),
    urgent: row.kind === 'incident',
  })
  if (!laneFree.granted) {
    return `Issue ${issueNumber(issue)} waits for its lane in ${project.name}: ${laneFree.message}`
  }
  const owed = snap.issues
    .filter(
      (i) =>
        i.project === project.name && holdsClaim(i.state, i.waitReason) && !snap.claims.some((s) => s.issue === i.id),
    )
    .map((i) => claimantOf(i.id, i.kind, i.since))
  const room = claimRoom({
    leads: project.project.leads,
    holders: snap.claims.filter((s) => s.repo === project.repo).map((s) => ({ issue: s.issue, urgent: s.urgent })),
    owed,
    candidate: claimantOf(issue, row.kind),
  })
  if (room.granted) return null
  const account = snap.owedAccounts.get(issue)
  const pinned = account ? `; it resumes on account ${account}, whose cap never holds a resume back` : ''
  return `Issue ${issueNumber(issue)} waits for a claim in ${project.name}: ${room.message}${pinned}`
}

export interface StalledClaim {
  issue: IssueId
  /** the account the lead resumes on; null: none on file */
  account: string | null
}

/**
 * Of these Issues, whose refusal for a claim is a stall: the repo's claim would be granted to them right now, in the
 * order that serves resumed leads (`resumeBlock`), so nothing explains the refusal. A repo that is full, or whose
 * free places go to resumed leads ahead of the Issue (a herd woken at once waits its turn), is a rightful wait.
 */
export async function claimStalled(
  deps: CapacityDeps,
  issues: readonly IssueId[],
): Promise<Result<StalledClaim[], PortError>> {
  return deps.uow.run(async (stores) => {
    const snap = await snapshotOf(stores, deps.clock.now())
    // The claims of Issues that stopped working are not released here (a read), but they are no one's any more.
    const holding = new Set(snap.issues.filter((i) => holdsClaim(i.state, i.waitReason)).map((i) => i.id))
    snap.claims = snap.claims.filter((claim) => holding.has(claim.issue))
    const stalled: StalledClaim[] = []
    for (const issue of issues) {
      const row = snap.issues.find((i) => i.id === issue)
      const project = row && snap.projects.find((p) => p.name === row.project)
      if (!row || !project || snap.claims.some((c) => c.issue === issue)) continue
      if (resumeBlock(snap, row, project)) continue
      stalled.push({ issue, account: snap.owedAccounts.get(issue) ?? null })
    }
    return ok(stalled)
  })
}

/** Gives an Issue's claim back (finalize calls this from every exit path). True when it held one. Idempotent. */
export async function releaseClaim(deps: PlanningDeps, issue: IssueId): Promise<Result<boolean, PortError>> {
  return deps.uow.run(async ({ capacity }) => {
    await capacity.lock()
    return ok((await capacity.releaseClaims([issue])).length > 0)
  })
}

export interface ResumeClaim {
  /** `held`: the Issue had its claim; `taken`: it took one now */
  result: 'held' | 'taken'
}

/**
 * **The claim on resume.** The machine has no claim wait, so the wait is here, at the one place that matters: a lead
 * whose wait ended (an answer, a verdict, a timer, a wake) takes its repo's claim back before anyone tells it so. The
 * `note_lead` effect that ends the wait calls this first and answers `refused` while the repo is full, which the
 * outbox retries with its backoff, so no lead works in a repo without a place (or beside another lead of a capped lane).
 * Only the repo's claims are looked at: a resume is never kept out by the load, the memory, an account's window or its
 * cap. The lead is the same session on the account of its latest assignment and moves only when it is walled (`moveWalled`),
 * so the cap governs new leads only. Meanwhile admission counts the Issue as owed, in the repo's claims and on its account, so no new lead takes
 * the place or the seat it waits for. Owed leads take a place in the order of their waits, oldest first.
 */
export async function resumeClaim(deps: PlanningDeps, issue: IssueId): Promise<Result<ResumeClaim, PortError>> {
  return deps.uow.run(async (stores) => {
    await stores.capacity.lock()
    const snap = await snapshotOf(stores, deps.clock.now())
    await sweepClaims(stores, snap)
    const row = snap.issues.find((i) => i.id === issue)
    if (!row) return err(portError('gone', `Issue ${issueNumber(issue)} is closed or unknown: nothing to resume`))
    if (snap.claims.some((s) => s.issue === issue)) return ok<ResumeClaim>({ result: 'held' })
    const project = snap.projects.find((p) => p.name === row.project)
    // A repo that is no project any more has no claim to wait for.
    if (!project) return ok<ResumeClaim>({ result: 'held' })
    const block = resumeBlock(snap, row, project)
    if (block) return err(portError('refused', block))
    const assignment = await stores.capacity.latestAssignment(issue)
    await stores.capacity.takeClaim({
      issue,
      repo: project.repo,
      urgent: row.kind === 'incident',
      account: assignment?.account ?? null,
      takenAt: deps.clock.now(),
    })
    return ok<ResumeClaim>({ result: 'taken' })
  })
}

/** The account an attempt was admitted on: `start_lead` of package 4 starts the lead there. */
export async function accountOf(
  deps: PlanningDeps,
  issue: IssueId,
  attempt: number,
): Promise<Result<string | null, PortError>> {
  return deps.uow.run(async ({ capacity }) => ok((await capacity.assignmentOf(issue, attempt))?.account ?? null))
}

/**
 * When an account's window opens again by its newest reading: what a lead that hit the wall at `since` waits for. A
 * reading that closes the account says when (the package's `opens_at`). A reading that takes work but was sampled before the
 * wall has not caught up with it: it names the window nearest its ceiling (`wallResetAt`, from the package), the one the lead
 * ran into, so a lead is never woken into a wall the reading does not show yet. A reading that takes work and was sampled
 * after the wall (or with no `since`) says the account is open. Null when no reset is known, and then the lead is woken at once.
 */
export async function windowOf(
  deps: PlanningDeps,
  account: string,
  since?: Date,
): Promise<Result<{ resetAt: Date | null }, PortError>> {
  return deps.uow.run(async ({ capacity }) => {
    const reading = (await capacity.latestReadings()).find((r) => r.account === account)
    if (!reading) return ok({ resetAt: null })
    const now = deps.clock.now()
    if (!reading.open) return ok({ resetAt: reading.opensAt && reading.opensAt > now ? reading.opensAt : null })
    const behind = since !== undefined && reading.sampledAt !== null && reading.sampledAt < since
    const wall = reading.wallResetAt
    return ok({ resetAt: behind && wall && wall > now ? wall : null })
  })
}

export interface AccountMove {
  from: string
  to: string
}

/**
 * **A walled lead moves to another open account.** The lead's account ran out (a `wall` stall of its attempt) and the
 * window is still closed: instead of waiting for it, the attempt is given to the account the picker would give a new
 * lead (`pickAccount`: open by the package's verdict, below its cap, never the account it left), and its claim goes with it.
 * The lead's session follows when its wake is delivered (`noteLead` starts the same session again under the new account;
 * the transcripts of every account lie in one `projects/` directory, so nothing is copied). The prompt cache is per account,
 * so the resumed session reads its whole context uncached once: cheaper than hours of waiting for a window, which is why
 * nothing else moves a running lead. Null when the Issue no longer waits on a wall of this attempt, or no other account has room.
 * The caller wakes the Issue afterwards; a pass that dies between the two is found by the next, which sees the new account open.
 */
export async function moveWalled(
  deps: PlanningDeps,
  limits: CapacityLimits,
  input: { issue: IssueId; attempt: number },
): Promise<Result<AccountMove | null, PortError>> {
  return deps.uow.run(async (stores) => {
    await stores.capacity.lock()
    const now = deps.clock.now()
    const snap = await snapshotOf(stores, now)
    const row = snap.issues.find((i) => i.id === input.issue)
    if (row?.state !== 'waiting' || row.waitReason !== 'wall') return ok(null)
    const latest = await stores.capacity.latestAssignment(input.issue)
    if (!latest || latest.attempt !== input.attempt) return ok(null)
    const taken = new Set(snap.claims.map((c) => c.issue))
    const owed = snap.issues.filter((i) => holdsClaim(i.state, i.waitReason) && !taken.has(i.id))
    const pick = pickAccount({
      readings: snap.readings.filter((r) => r.account !== latest.account),
      loaded: loadedAccounts(snap),
      leads: leadsOnAccounts(snap.claims, owed, snap.owedAccounts),
      leadsPerAccount: limits.leadsPerAccount,
      ...(limits.accountLeads ? { accountCaps: limits.accountLeads } : {}),
      now,
    })
    if (!pick.picked) return ok(null)
    if (!(await stores.capacity.reassign(input.issue, input.attempt, pick.picked.account, now))) return ok(null)
    return ok({ from: latest.account, to: pick.picked.account })
  })
}
