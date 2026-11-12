import {
  type AccountRank,
  type AccountReading,
  POLL_EVERY_MS,
  RANK_LANE,
  standing,
} from '../domains/capacity/accounts.ts'
import { checkAdmission, type LeadFit, type RefusalKind } from '../domains/capacity/admission.ts'
import { freeMibOf, headroomMib } from '../domains/capacity/costs.ts'
import { DEFAULT_TYPICAL_LEAD_MIB, SEAT_SAMPLE_MAX_AGE_MS, SEAT_SAMPLES, seatBonus } from '../domains/capacity/seats.ts'
import { learnedLeadMib, leadGrowthMib } from '../domains/capacity/leadcost.ts'
import { type MemoryCeilings, type MemoryReading, reservedOf, sustainedSwapoutMb } from '../domains/capacity/host.ts'
import { type LaneInput, laneRoom } from '../domains/capacity/lanes.ts'
import type { AccountRanker, AccountSource, Assignment, HostReader } from '../domains/capacity/ports.ts'
import { effectiveState, type QueueStates } from '../domains/capacity/queue-state.ts'
import { type Claim, type Claimant, claimRoom, holdsClaim } from '../domains/capacity/claims.ts'
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
  leadsPerAccount: number
  loadCeiling: number
  memoryCeilings: MemoryCeilings
  /** `FACTORY_SEATS_MAX_BONUS`: the most extra leads per account while the host idles; absent or 0: off */
  seatsMaxBonus?: number
}

export interface CapacityDeps extends PlanningDeps {
  host: HostReader
  accounts: AccountSource
  ranker: AccountRanker
  limits: CapacityLimits
}

/** What the host said this pass; a reading that could not be taken is null and admission goes on without it. */
export interface HostInputs {
  load: number | null
  memory: MemoryReading | null
  /** the machine's RAM in MiB; null: the lanes' memory cannot be counted */
  ramMib: number | null
  /** the memory free by the newest minute sample (not older than five minutes); null: unknown */
  freeMib: number | null
  /** per project name: what a lead is learned to take (null with fewer than three attempts) and the attempts sampled */
  learned: ReadonlyMap<string, { mib: number | null; attempts: number }>
  /** per Issue number: the MiB its lead holds by a sample not older than three minutes */
  rssByIssue: ReadonlyMap<number, number>
  /** the newest five minute samples, newest first; empty unless all five exist and none is older than six minutes */
  recent: readonly { load: number | null; swapUsedPct: number | null }[]
  notes: string[]
}

const NO_HOST: HostInputs = {
  load: null,
  memory: null,
  ramMib: null,
  freeMib: null,
  learned: new Map(),
  rssByIssue: new Map(),
  recent: [],
  notes: [],
}

/** A lead's own sample is read as what it holds now only when it is this fresh. */
const RSS_MAX_AGE_MS = 3 * 60_000

export type QueueReasonKind = ChainReason['kind'] | RefusalKind

/** Why a queued Issue stays queued: the word the owner reads, with the numbers. */
export interface QueueReason {
  kind: QueueReasonKind
  message: string
  /** when a reading says the reason may end */
  opensAt: Date | null
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
}

export interface Snapshot {
  now: Date
  projects: StoredProject[]
  issues: (OpenIssueRow & { project: string | null })[]
  edges: Edge[]
  prio: Map<IssueId, number>
  claims: Claim[]
  readings: AccountReading[]
  /** the picker's order of accounts; null: none stored */
  rank: AccountRank | null
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
  const now = deps.clock.now()
  const facts = await deps.uow.run(async ({ capacity }) =>
    ok({
      latest: await capacity.latestHostSample(),
      recent: await capacity.recentHostSamples(SEAT_SAMPLES),
      peaks: await capacity.leadPeaks(),
      rss: await capacity.leadRssSince(new Date(now.getTime() - RSS_MAX_AGE_MS)),
    }),
  )
  if (!facts.ok)
    notes.push(`the learned lead costs could not be read (${facts.error.detail}): admission goes on without them`)
  const fresh = facts.ok
    ? facts.value.recent.length === SEAT_SAMPLES &&
      facts.value.recent.every((s) => now.getTime() - s.at.getTime() <= SEAT_SAMPLE_MAX_AGE_MS)
    : false
  return {
    load: load.ok ? load.value : null,
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
    freeMib: facts.ok ? freeMibOf(facts.value.latest, ramMib, now) : null,
    learned: new Map(
      facts.ok
        ? facts.value.peaks.map((p) => [p.repo, { mib: learnedLeadMib(p.peaksNewestFirst), attempts: p.attempts }])
        : [],
    ),
    rssByIssue: facts.ok ? facts.value.rss : new Map(),
    recent: facts.ok && fresh ? facts.value.recent.map((s) => ({ load: s.load, swapUsedPct: s.swapUsedPct })) : [],
    notes,
  }
}

/**
 * Polls the account picker and stores the readings as facts, with the picker's rank when it answers. A failed rank
 * read leaves the stored rank to go stale and puts a note in `notes`: the readings are still stored and admission
 * orders new leads by lowest weekly use.
 */
export async function refreshAccounts(
  deps: CapacityDeps,
  notes: string[] = [],
): Promise<Result<AccountReading[], PortError>> {
  const at = deps.clock.now()
  const read = await deps.accounts.read(at)
  if (!read.ok) return read
  const rank = await deps.ranker.read(at)
  if (!rank.ok) {
    notes.push(`account rank read failed (${rank.error.detail}): new leads are ordered by lowest weekly use`)
  }
  const stored = await deps.uow.run(async ({ capacity }) => {
    await capacity.lock()
    await capacity.recordReadings(read.value)
    if (rank.ok) await capacity.recordRank(rank.value)
    return ok(read.value)
  })
  return stored
}

/** Polls when the newest reading is older than a minute; a failed poll leaves the stored readings (stale ones admit nothing). */
export async function pollIfDue(deps: CapacityDeps): Promise<string[]> {
  const latest = await deps.uow.run(async ({ capacity }) => ok(await capacity.latestReadings()))
  const now = deps.clock.now().getTime()
  const newest = latest.ok ? Math.max(0, ...latest.value.map((r) => r.readAt.getTime())) : 0
  if (latest.ok && newest > 0 && now - newest < POLL_EVERY_MS) return []
  const notes: string[] = []
  const polled = await refreshAccounts(deps, notes)
  if (!polled.ok) notes.push(`account poll failed (${polled.error.detail}): admission goes on the readings it has`)
  return notes
}

export async function snapshotOf(stores: PlanningStores, now: Date): Promise<Snapshot> {
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
    claims,
    readings: await stores.capacity.latestReadings(),
    rank: await stores.capacity.latestRank(RANK_LANE),
    states: await stores.capacity.queueStates(),
    assignments: await stores.capacity.recentAssignments(),
    owedAccounts: latestAccounts(await stores.capacity.latestAssignments(owedIds)),
  }
}

/** The claims of Issues that no longer work in their repo go back; run under the capacity lock. */
export async function sweepClaims(stores: PlanningStores, snap: Snapshot): Promise<IssueId[]> {
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
 * Every queued Issue in queue order with the reason it stays queued, or nothing when it may be admitted. Each Issue is
 * decided as if the ones before it were admitted (they take a claim and an account), so the reasons of the later ones
 * are the ones they would meet in turn. Pure: the snapshot and the host readings are passed in.
 */
export function evaluateQueue(snap: Snapshot, host: HostInputs, limits: CapacityLimits): QueueEntry[] {
  const base = decide(snap, host, limits, 0)
  const bonus = seatBonusOf(snap, host, limits, base)
  return bonus > 0 ? decide(snap, host, limits, bonus) : base
}

/**
 * The extra leads per account an idle host allows this pass: for the entries that stay queued for the account cap, as
 * many leads of the repos' typical learned size as the free memory holds. Never past a window: the pick still follows it.
 */
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

/** What each lead is learned to still take on beyond what it holds, summed over the claims held. */
function growthOf(claims: readonly Claim[], projects: readonly StoredProject[], host: HostInputs): number {
  // A claim carries its project's path; what is learned is keyed by the project's name.
  const nameOf = new Map(projects.map((p) => [p.repo, p.name]))
  return leadGrowthMib(
    claims.map((claim) => ({
      learnedMib: host.learned.get(nameOf.get(claim.repo) ?? '')?.mib ?? null,
      currentMib: host.rssByIssue.get(issueNumber(claim.issue)) ?? 0,
    })),
  )
}

/** The account each Issue was last admitted on (the newest attempt's, so a list of one attempt each or newest first). */
function latestAccounts(assignments: readonly Assignment[]): Map<IssueId, string> {
  const accounts = new Map<IssueId, string>()
  for (const a of assignments) if (!accounts.has(a.issue)) accounts.set(a.issue, a.account)
  return accounts
}

/**
 * The leads on each account for the cap: every claim, and every owed lead on the account it will resume on. A woken
 * lead is pinned to its own account and takes its place back whatever the cap says (see `resumeClaim`), so from the
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

function decide(snap: Snapshot, host: HostInputs, limits: CapacityLimits, bonus: number): QueueEntry[] {
  const open: OpenIssue[] = snap.issues.map((i) => ({
    id: i.id,
    project: i.project,
    kind: i.kind,
    state: i.state,
    waitReason: i.waitReason,
    finalizing: i.finalizing,
  }))
  const ordered = orderQueue({ open, edges: snap.edges, prio: snap.prio })
  const claims = [...snap.claims]
  const taken = new Set(claims.map((s) => s.issue))
  const loaded = new Set<string>()
  for (const reading of snap.readings) {
    if (!reading.sampledAt) continue
    if (snap.assignments.some((a) => a.account === reading.account && a.assignedAt >= (reading.sampledAt as Date))) {
      loaded.add(reading.account)
    }
  }
  const repoOf = new Map(snap.issues.map((i) => [i.id, i.repo]))
  const laneByIssue = new Map(snap.issues.map((i) => [i.id, i.lane]))
  const projectByName = new Map(snap.projects.map((p) => [p.name, p]))
  const owed = snap.issues.filter((i) => holdsClaim(i.state, i.waitReason) && !taken.has(i.id) && i.project !== null)

  return ordered.map((row): QueueEntry => {
    const { issue } = row
    const base = {
      issue: issue.id,
      repo: repoOf.get(issue.id) ?? '',
      project: issue.project,
      kind: issue.kind,
      prio: row.prio,
    }
    if (row.reason) return { ...base, reason: { ...row.reason, opensAt: null }, account: null }
    const project = issue.project === null ? undefined : projectByName.get(issue.project)
    if (!project) return { ...base, reason: null, account: null }
    const leadsByAccount = leadsOnAccounts(claims, owed, snap.owedAccounts)
    const learned = host.learned.get(project.name)
    const leadFit: LeadFit = {
      repo: project.name,
      candidateMib: learned?.mib ?? null,
      attempts: learned?.attempts ?? 0,
      freeMib: host.freeMib,
      growthMib: growthOf(claims, snap.projects, host),
      headroomMib: headroomMib(host.ramMib),
      running: claims.length,
    }
    const verdict = checkAdmission({
      lane: laneOf(issue.id, project, claims, owed, laneByIssue),
      now: snap.now,
      state: effectiveState(snap.states, project.name),
      leads: project.project.leads,
      holders: claims.filter((s) => s.repo === project.repo).map((s) => ({ issue: s.issue, urgent: s.urgent })),
      owed: owed.filter((o) => o.project === project.name).map((o) => claimantOf(o.id, o.kind, o.since)),
      candidate: claimantOf(issue.id, issue.kind),
      load: host.load,
      loadCeiling: limits.loadCeiling,
      memory: host.memory,
      memoryCeilings: limits.memoryCeilings,
      leadFit,
      reserved: reservedOf(
        reservedMib(issue.id, project, claims, owed, snap.projects, laneByIssue, host.learned),
        host.ramMib,
      ),
      accounts: snap.readings,
      loaded,
      leadsByAccount,
      leadsPerAccount: limits.leadsPerAccount + bonus,
      seatBonus: bonus,
      rank: snap.rank,
    })
    if (!verdict.admit) return { ...base, reason: verdict.refusal, account: null }
    claims.push({
      issue: issue.id,
      repo: project.repo,
      urgent: issue.kind === 'incident',
      account: verdict.account.account,
      takenAt: snap.now,
    })
    loaded.add(verdict.account.account)
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

/** The most Issues one pass admits; the rest wait for the next. */
export const PASS_LIMIT = 20

/**
 * The admission pass: poll the accounts if the readings are old, read the host once, then admit one Issue at a time,
 * each decided again in its own transaction, until nothing more may start. Replay-safe: the event key names the
 * attempt, so a second pass admits nothing twice.
 */
export async function admissionPass(
  deps: CapacityDeps,
  options: { limit?: number } = {},
): Promise<Result<PassResult, PortError>> {
  const notes = await pollIfDue(deps)
  const host = await readHost(deps)
  notes.push(...host.notes)
  const admitted: Admitted[] = []
  const skip = new Set<IssueId>()
  let queue: QueueEntry[] = []
  for (let i = 0; i < (options.limit ?? PASS_LIMIT); i++) {
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
  return ok({ admitted, queue, notes })
}

/** The queue as it stands, in order, with the reason each Issue stays queued. Reads only. */
export async function queueView(
  deps: CapacityDeps,
): Promise<Result<{ queue: QueueEntry[]; notes: string[] }, PortError>> {
  const notes = await pollIfDue(deps)
  const host = await readHost(deps)
  host.notes.unshift(...notes)
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
      seats: snap.readings.filter((r) => r.enabled).length * deps.limits.leadsPerAccount,
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
 * never a reason: the lead is pinned to the account it was admitted on and resumes there whatever the cap says. The
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
 * cap. The lead is the same session on the account it was admitted on and cannot move, so the cap governs new leads
 * only. Meanwhile admission counts the Issue as owed, in the repo's claims and on its account, so no new lead takes
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

/** When an account's window opens again by its newest reading, if the reading says: what a lead that hit the wall waits for. */
export async function windowOf(
  deps: PlanningDeps,
  account: string,
): Promise<Result<{ resetAt: Date | null }, PortError>> {
  return deps.uow.run(async ({ capacity }) => {
    const reading = (await capacity.latestReadings()).find((r) => r.account === account)
    if (!reading) return ok({ resetAt: null })
    const stand = standing(reading, deps.clock.now())
    return ok({ resetAt: stand.open ? null : stand.until })
  })
}
