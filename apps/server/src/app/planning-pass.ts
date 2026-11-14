import { newlySatisfied } from '../domains/planning/chain.ts'
import {
  factsNote,
  filable,
  type PlanKind,
  type PlanOf,
  type PlanRow,
  rowStatuses,
  type RowStatus,
} from '../domains/planning/plan.ts'
import type { HeldRow } from '../domains/planning/replan.ts'
import { projectOf, repoTextOf, type StoredProject } from '../domains/planning/sync.ts'
import type { Kind } from '../domains/work/issue.ts'
import type { IssueId } from '../kernel/ids.ts'
import { key } from '../kernel/keys.ts'
import { err, ok, portError, type PortError, type Result } from '../kernel/result.ts'
import { fileIn, recordIn } from './issues.ts'
import type { PlanningDeps, PlanningStores } from './planning-deps.ts'
import { fileReplan } from './planning-replan.ts'
import { resolveSeat } from './seat.ts'
import { type SyncDeps, type SyncResult, syncProjects } from './planning-sync.ts'

/** The kinds a plan row may name are the Issue's own: this fails `tsc` when the two lists drift. */
const planKindsAreIssueKinds: PlanKind extends Kind ? (Kind extends PlanKind ? true : never) : never = true
void planKindsAreIssueKinds

export interface PlanView {
  project: string
  sha: string | null
  error: string | null
  warnings: string[]
  rows: RowStatus[]
}

/** Every stored plan with each row's state, derived from the Issues and the clock. Reads only. */
export async function planViews(stores: PlanningStores, now: Date): Promise<PlanView[]> {
  const projects = await stores.planning.projects()
  const withPlan = projects.filter((p) => p.plan !== null || p.planError !== null)
  const plans: PlanOf[] = withPlan.flatMap((p) => (p.plan ? [{ project: p.name, plan: p.plan }] : []))
  const filed = await stores.planning.filedRows()
  const adopted = plans.flatMap(({ plan }) =>
    plan.rows.flatMap((row) => (row.issue === undefined ? [] : [issueIdOf(row.issue)])),
  )
  const ids = [...filed.values(), ...adopted]
  const states = await stores.reads.statesOf(ids)
  const closedAt = plans.some(({ plan }) => plan.rows.some((row) => row.after_days !== undefined))
    ? await stores.reads.closedAtOf(ids)
    : new Map<IssueId, Date>()
  const outcomes = plans.some(({ plan }) => plan.rows.some((row) => row.after_needs === 'shipped'))
    ? await stores.reads.outcomesOf(ids)
    : new Map<IssueId, string>()
  const statuses = rowStatuses({
    plans,
    projects: new Set(projects.map((p) => p.name)),
    filed,
    states,
    outcomes,
    closedAt,
    now,
  })
  return withPlan.map((p) => ({
    project: p.name,
    sha: p.planSha,
    error: p.planError?.message ?? null,
    warnings: p.planWarnings,
    rows: statuses.filter((s) => s.project === p.name),
  }))
}

const issueIdOf = (n: number): IssueId => `issue_${n}` as IssueId

export interface Filed {
  project: string
  row: string
  issue: IssueId
}

/**
 * Files one row as an Issue, if it is still filable in this transaction (decided again, so a replayed pass or a row
 * another pass filed meanwhile files nothing twice): `filed` with the row's key, the row's facts as the first note its
 * lead reads, `settled` (its `after` rows are all closed, so no edge is open), and the row's Issue recorded.
 */
async function fileRow(
  stores: PlanningStores,
  deps: SyncDeps,
  at: { project: string; row: string },
): Promise<Result<Filed | null, PortError>> {
  const views = await planViews(stores, deps.clock.now())
  const status = views.flatMap((v) => v.rows).find((s) => s.project === at.project && s.key === at.row)
  if (status?.state !== 'filable' || status.target === null) return ok(null)
  const projects = await stores.planning.projects()
  const source = projects.find((p) => p.name === status.project)
  const row = source?.plan?.rows.find((r) => r.key === status.key)
  const target = projects.find((p) => p.name === status.target)
  if (!source || !row || !target) return ok(null)
  return fileFor(stores, deps, { source: source.name, row, target })
}

async function fileFor(
  stores: PlanningStores,
  deps: SyncDeps,
  input: { source: string; row: PlanRow; target: StoredProject },
): Promise<Result<Filed | null, PortError>> {
  const { row, target, source } = input
  // A role that no longer resolves files nothing; the pass names the row and the field, and the next pass tries again.
  const seat = row.seat ? await resolveSeat(deps.roles, row.seat) : null
  if (seat && !seat.ok) {
    return err(
      portError('refused', 'field' in seat.error ? `${seat.error.field}: ${seat.error.detail}` : seat.error.detail),
    )
  }
  const rowKey = key('plan', source, row.key)
  const filed = await fileIn(stores.work, deps, {
    key: rowKey,
    event: {
      kind: 'filed',
      payload: {
        repo: repoTextOf(target),
        title: row.title ?? row.key,
        kind: row.kind ?? 'feature',
        origin: 'factory',
        ...(seat?.ok ? { seat: seat.value } : {}),
        ...(row.lane ? { lane: row.lane } : {}),
        ...(row.checkpoint ? { checkpoint: row.checkpoint } : {}),
      },
      actor: 'factory',
    },
  })
  if (!filed.ok) return err(portError('refused', JSON.stringify(filed.error)))
  const issue = filed.value.issue.id
  const noted = await recordIn(stores.work, deps, {
    issueId: issue,
    key: key('plan', source, row.key, 'facts'),
    event: { kind: 'noted', payload: { text: factsNote(row) }, actor: 'factory' },
  })
  if (!noted.ok) return err(portError('refused', JSON.stringify(noted.error)))
  const settled = await recordIn(stores.work, deps, {
    issueId: issue,
    key: key('plan', source, row.key, 'settled'),
    event: { kind: 'settled', payload: {}, actor: 'factory' },
  })
  if (!settled.ok) return err(portError('refused', JSON.stringify(settled.error)))
  // The plan is the owner's file, so a row's `prio` is the owner's priority for its Issue; the key makes a replay record nothing twice.
  if (row.prio !== undefined && row.prio !== 0) {
    await stores.planning.recordPrio({
      key: key('plan', source, row.key, 'prio'),
      issue,
      value: row.prio,
      actor: 'plan',
      at: deps.clock.now(),
    })
  }
  await stores.planning.recordFiledRow({ project: source, key: row.key, issue, at: deps.clock.now() })
  return ok({ project: source, row: row.key, issue })
}

export interface PassResult {
  sync: SyncResult | null
  /** rows filed as Issues by this pass */
  filed: Filed[]
  /** chain edges whose blocker was seen closed */
  satisfied: number
  /** Issues whose wait ended without a person: every Issue they waited for closed, or the time they deferred to came */
  woken: IssueId[]
  errors: string[]
}

/** Marks the edges whose blocker is closed as satisfied, once. Returns how many. */
export async function satisfyEdges(stores: PlanningStores, now: Date): Promise<number> {
  const edges = await stores.planning.edges()
  const open = edges.filter((e) => !e.satisfied)
  if (open.length === 0) return 0
  const states = await stores.reads.statesOf(open.map((e) => e.after))
  const closed = new Set([...states].flatMap(([id, state]) => (state === 'closed' ? [id] : [])))
  const done = newlySatisfied(edges, closed)
  await stores.planning.markSatisfied(done, now)
  return done.length
}

/**
 * Wakes the Issues whose dependency wait is over: every Issue they deferred to has closed, in any outcome. `woken`
 * names the wait by the version that began it, so a late wake of an older wait changes nothing, and its key makes a
 * replayed pass wake once.
 */
async function wakeDependents(stores: PlanningStores, deps: PlanningDeps): Promise<Result<IssueId[], PortError>> {
  const waits = await stores.reads.dependencyWaits()
  if (waits.length === 0) return ok([])
  const states = await stores.reads.statesOf(waits.flatMap((w) => w.after))
  const woken: IssueId[] = []
  for (const wait of waits) {
    if (!wait.after.every((id) => states.get(id) === 'closed')) continue
    const recorded = await recordIn(stores.work, deps, {
      issueId: wait.issue,
      key: key('woken', wait.issue, 'dependency', wait.since),
      event: {
        kind: 'woken',
        payload: { since: wait.since, detail: 'every Issue it waited for has closed' },
        actor: 'factory',
      },
    })
    if (!recorded.ok) return err(portError('refused', JSON.stringify(recorded.error)))
    if (recorded.value.result === 'applied') woken.push(wait.issue)
  }
  return ok(woken)
}

/**
 * Wakes the Issues whose timer wait is over: the time the lead deferred to has come (a wait overdue by days ends on
 * the first pass). Named and keyed like `wakeDependents`, so a replayed pass wakes once.
 */
async function wakeTimers(stores: PlanningStores, deps: PlanningDeps): Promise<Result<IssueId[], PortError>> {
  const now = deps.clock.now().getTime()
  const woken: IssueId[] = []
  for (const wait of await stores.reads.timerWaits()) {
    if (Date.parse(wait.until) > now) continue
    const recorded = await recordIn(stores.work, deps, {
      issueId: wait.issue,
      key: key('woken', wait.issue, 'timer', wait.since),
      event: {
        kind: 'woken',
        payload: { since: wait.since, detail: `its time has come: ${wait.until}` },
        actor: 'factory',
      },
    })
    if (!recorded.ok) return err(portError('refused', JSON.stringify(recorded.error)))
    if (recorded.value.result === 'applied') woken.push(wait.issue)
  }
  return ok(woken)
}

/**
 * Files a stalled Replan for every long wait (a timed wait of `longWaitMs` or more with Issues behind it) in a known
 * project. While one is open for the project this files nothing, and its key makes a replayed pass a no-op. A wait whose
 * repo is no project is skipped. Returns the errors, one per wait that failed.
 */
async function replanStalled(deps: PlanningDeps, longWaitMs: number): Promise<string[]> {
  const read = await deps.uow.run(async (stores) =>
    ok({ waits: await stores.reads.longWaits(longWaitMs), projects: await stores.planning.projects() }),
  )
  if (!read.ok) return [`replan: ${read.error.detail}`]
  const errors: string[] = []
  for (const wait of read.value.waits) {
    const project = projectOf(read.value.projects, wait.repo)
    if (!project) continue
    const filed = await fileReplan(deps, {
      project: project.name,
      trigger: 'stalled',
      stalled: {
        issue: wait.issue,
        title: wait.title,
        since: wait.since.toISOString(),
        until: wait.until,
        held: wait.held,
        heldIssues: wait.heldIssues,
      },
      actor: 'owner',
    })
    if (!filed.ok) errors.push(`replan ${project.name}: ${JSON.stringify(filed.error)}`)
  }
  return errors
}

/**
 * Files a held Replan for every project with a plan row held behind an `after` row that closed without shipping
 * (`after_needs: shipped`): the Replan's lead proposes the plan change that releases or drops the row. While one is
 * open for the project this files nothing; its key (the first held row and the Issue holding it) makes a replayed pass
 * a no-op. Returns the errors, one per project that failed.
 */
async function replanHeld(deps: PlanningDeps): Promise<string[]> {
  const read = await deps.uow.run(async (stores) => ok(await planViews(stores, deps.clock.now())))
  if (!read.ok) return [`replan: ${read.error.detail}`]
  const errors: string[] = []
  for (const view of read.value) {
    const held: HeldRow[] = view.rows
      .filter((row) => row.heldBy.length > 0)
      .map((row) => ({
        row: `${row.project}:${row.key}`,
        by: row.heldBy.map((by) => ({ row: by.row, issue: by.issue, outcome: by.outcome })),
      }))
    if (held.length === 0) continue
    const filed = await fileReplan(deps, { project: view.project, trigger: 'held', held, actor: 'owner' })
    if (!filed.ok) errors.push(`replan ${view.project}: ${JSON.stringify(filed.error)}`)
  }
  return errors
}

/**
 * The planning part of a tick: read the projects, file the plan rows whose `after` rows have closed, mark the chain's
 * satisfied edges and wake the leads that waited on them or on a time. Every step is replay-safe, so a pass run twice does nothing
 * twice; a long wait with Issues behind it gets a Replan filed for its project. A failing step is an entry in `errors`; the others still go.
 */
export async function planningPass(
  deps: SyncDeps,
  options: { fetch: boolean; longWaitMs?: number } = { fetch: false },
): Promise<Result<PassResult, PortError>> {
  const errors: string[] = []
  const synced = await syncProjects(deps, options)
  if (!synced.ok) errors.push(`sync: ${synced.error.detail}`)

  const due = await deps.uow.run(async (stores) => {
    const rows = (await planViews(stores, deps.clock.now())).flatMap((view) => filable(view.rows))
    return ok(rows.map((row) => ({ project: row.project, row: row.key })))
  })
  if (!due.ok) return due

  const filed: Filed[] = []
  for (const at of due.value) {
    const result = await deps.uow.run((stores) => fileRow(stores, deps, at))
    if (!result.ok) errors.push(`${at.project}:${at.row}: ${result.error.detail}`)
    else if (result.value) filed.push(result.value)
  }

  const chain = await deps.uow.run(async (stores) => {
    const satisfied = await satisfyEdges(stores, deps.clock.now())
    const dependents = await wakeDependents(stores, deps)
    if (!dependents.ok) return dependents
    const timers = await wakeTimers(stores, deps)
    if (!timers.ok) return timers
    return ok({ satisfied, woken: [...dependents.value, ...timers.value] })
  })
  if (options.longWaitMs !== undefined) errors.push(...(await replanStalled(deps, options.longWaitMs)))
  errors.push(...(await replanHeld(deps)))
  if (!chain.ok) {
    errors.push(`chain: ${chain.error.detail}`)
    return ok({ sync: synced.ok ? synced.value : null, filed, satisfied: 0, woken: [], errors })
  }
  return ok({
    sync: synced.ok ? synced.value : null,
    filed,
    satisfied: chain.value.satisfied,
    woken: chain.value.woken,
    errors,
  })
}
