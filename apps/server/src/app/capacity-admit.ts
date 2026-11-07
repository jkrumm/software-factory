import { type AccountReading, POLL_EVERY_MS, standing } from '../domains/capacity/accounts.ts'
import { checkAdmission, type RefusalKind } from '../domains/capacity/admission.ts'
import type { MemoryCeilings, MemoryReading } from '../domains/capacity/host.ts'
import type { AccountSource, Assignment, HostReader } from '../domains/capacity/ports.ts'
import { effectiveState, type QueueStates } from '../domains/capacity/queue-state.ts'
import { type Claim, type Claimant, claimRoom, holdsClaim } from '../domains/capacity/claims.ts'
import type { Edge } from '../domains/planning/chain.ts'
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
}

export interface CapacityDeps extends PlanningDeps {
  host: HostReader
  accounts: AccountSource
  limits: CapacityLimits
}

/** What the host said this pass; a reading that could not be taken is null and admission goes on without it. */
export interface HostInputs {
  load: number | null
  memory: MemoryReading | null
  notes: string[]
}

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
  states: QueueStates
  assignments: Assignment[]
}

/** Reads what a host reading and an account poll say, outside any transaction. */
export async function readHost(deps: CapacityDeps): Promise<HostInputs> {
  const notes: string[] = []
  const load = await deps.host.load()
  const memory = await deps.host.memory()
  if (!load.ok) notes.push(`load reading failed (${load.error.detail}): new leads are admitted without it`)
  if (!memory.ok) {
    notes.push(
      `memory reading failed (${memory.error.detail}): new leads are admitted without it, the next pass reads again`,
    )
  }
  return { load: load.ok ? load.value : null, memory: memory.ok ? memory.value : null, notes }
}

/** Polls the account picker and stores the readings as facts. */
export async function refreshAccounts(deps: CapacityDeps): Promise<Result<AccountReading[], PortError>> {
  const at = deps.clock.now()
  const read = await deps.accounts.read(at)
  if (!read.ok) return read
  const stored = await deps.uow.run(async ({ capacity }) => {
    await capacity.lock()
    await capacity.recordReadings(read.value)
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
  const polled = await refreshAccounts(deps)
  return polled.ok ? [] : [`account poll failed (${polled.error.detail}): admission goes on the readings it has`]
}

export async function snapshotOf(stores: PlanningStores, now: Date): Promise<Snapshot> {
  const projects = await stores.planning.projects()
  const rows = await stores.reads.open()
  return {
    now,
    projects,
    issues: rows.map((row) => ({ ...row, project: projectOf(projects, row.repo)?.name ?? null })),
    edges: await stores.planning.edges(),
    prio: await stores.planning.prios(),
    claims: await stores.capacity.claims(),
    readings: await stores.capacity.latestReadings(),
    states: await stores.capacity.queueStates(),
    assignments: await stores.capacity.recentAssignments(),
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

const claimantOf = (issue: IssueId, kind: string): Claimant => ({ issue, urgent: kind === 'incident' })

/**
 * Every queued Issue in queue order with the reason it stays queued, or nothing when it may be admitted. Each Issue is
 * decided as if the ones before it were admitted (they take a claim and an account), so the reasons of the later ones
 * are the ones they would meet in turn. Pure: the snapshot and the host readings are passed in.
 */
export function evaluateQueue(snap: Snapshot, host: HostInputs, limits: CapacityLimits): QueueEntry[] {
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
    const leadsByAccount = new Map<string, number>()
    for (const claim of claims)
      if (claim.account) leadsByAccount.set(claim.account, (leadsByAccount.get(claim.account) ?? 0) + 1)
    const verdict = checkAdmission({
      now: snap.now,
      state: effectiveState(snap.states, project.name),
      leads: project.project.leads,
      holders: claims.filter((s) => s.repo === project.repo).map((s) => ({ issue: s.issue, urgent: s.urgent })),
      owed: owed.filter((o) => o.project === project.name).map((o) => claimantOf(o.id, o.kind)),
      candidate: claimantOf(issue.id, issue.kind),
      load: host.load,
      loadCeiling: limits.loadCeiling,
      memory: host.memory,
      memoryCeilings: limits.memoryCeilings,
      accounts: snap.readings,
      loaded,
      leadsByAccount,
      leadsPerAccount: limits.leadsPerAccount,
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
 * outbox retries with its backoff, so no lead works in a repo without a place. Only the repo's claims are looked at: a
 * resume is never kept out by the load, the memory or an account's window, and it keeps the account it was admitted
 * on. Meanwhile admission counts the Issue as owed, so no new lead takes the place it waits for.
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
    const owed = snap.issues
      .filter(
        (i) =>
          i.project === project.name && holdsClaim(i.state, i.waitReason) && !snap.claims.some((s) => s.issue === i.id),
      )
      .map((i) => claimantOf(i.id, i.kind))
    const room = claimRoom({
      leads: project.project.leads,
      holders: snap.claims.filter((s) => s.repo === project.repo).map((s) => ({ issue: s.issue, urgent: s.urgent })),
      owed,
      candidate: claimantOf(issue, row.kind),
    })
    if (!room.granted)
      return err(
        portError('refused', `Issue ${issueNumber(issue)} waits for a claim in ${project.name}: ${room.message}`),
      )
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
