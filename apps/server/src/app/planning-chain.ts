import type { Kind } from '../domains/work/issue.ts'
import { cycleThrough, type Edge } from '../domains/planning/chain.ts'
import { type IssueId, issueNumber } from '../kernel/ids.ts'
import { type Key, key } from '../kernel/keys.ts'
import { err, ok, type Result } from '../kernel/result.ts'
import type { PortError } from '../kernel/result.ts'
import { type IssueWriteError, recordIn } from './issues.ts'
import type { PlanningDeps, PlanningError, PlanningStores } from './planning-deps.ts'

const lift = (error: IssueWriteError): PlanningError => {
  switch (error.kind) {
    case 'unknown_issue':
      return { kind: 'unknown_issue', issue: error.issueId }
    case 'version_conflict':
      return { kind: 'version_conflict', issue: error.issueId }
    default:
      return { kind: 'refused', detail: error.detail }
  }
}

/** The chain as it stands: the stored edges, and the dependency waits of leads (an Issue waits for others to close). */
async function chainOf({ planning, reads }: PlanningStores): Promise<Edge[]> {
  const waits = await reads.dependencyWaits()
  return [
    ...(await planning.edges()),
    ...waits.flatMap((wait) => wait.after.map((after) => ({ issue: wait.issue, after, satisfied: false }))),
  ]
}

/**
 * Adds the edges `issue -> after`: each blocker must exist and be open, and none may close a cycle through the open
 * edges or the leads' dependency waits. Refuses the whole set otherwise (nothing is stored).
 */
export async function addEdges(
  stores: PlanningStores,
  deps: PlanningDeps,
  issue: IssueId,
  after: readonly IssueId[],
): Promise<Result<number, PlanningError>> {
  if (after.length === 0) return ok(0)
  const states = await stores.reads.statesOf([issue, ...after])
  if (!states.has(issue)) return err({ kind: 'unknown_issue', issue })
  const edges = await chainOf(stores)
  let added = 0
  for (const blocker of new Set(after)) {
    const state = states.get(blocker)
    if (!state) return err({ kind: 'unknown_issue', issue: blocker })
    if (state === 'closed') return err({ kind: 'issue_closed', issue: blocker })
    const path = cycleThrough(edges, issue, blocker)
    if (path) return err({ kind: 'cycle', path: [issue, ...path] })
    edges.push({ issue, after: blocker, satisfied: false })
    if (await stores.planning.addEdge({ issue, after: blocker, key: '', at: deps.clock.now() })) added++
  }
  return ok(added)
}

export interface Settled {
  /** `settled`: the Issue is queued now; `replayed`: it was settled before; `ignored`: it was not settling */
  result: 'settled' | 'replayed' | 'ignored'
  edges: number
  state: string
}

/**
 * Records `settled` on a `settling` Issue once its edges are known: the Issues it must wait for (none is a known
 * answer too). The edges and the event are one transaction, so an Issue is never queued half-chained, and a repeat of
 * the call settles nothing twice.
 */
export async function settleIssue(
  deps: PlanningDeps,
  input: { issue: IssueId; after: readonly IssueId[]; kind?: Kind },
): Promise<Result<Settled, PlanningError | PortError>> {
  const settledPayload = input.kind ? { kind: input.kind } : {}
  return deps.uow.run(async (stores) => {
    // The cycle check reads the open edges and then writes one: two verbs at once must not both pass it.
    await stores.capacity.lock()
    const states = await stores.reads.statesOf([input.issue])
    if (!states.has(input.issue)) return err<PlanningError>({ kind: 'unknown_issue', issue: input.issue })
    // A repeat of a settle is a replay: it adds no edge and judges no blocker again (one may have closed meanwhile).
    const before = await stores.work.eventByKey(key('settled', input.issue))
    if (before) {
      const replayed = await recordIn(stores.work, deps, {
        issueId: input.issue,
        key: key('settled', input.issue),
        event: { kind: 'settled', payload: settledPayload, actor: 'factory' },
      })
      if (!replayed.ok) return err(lift(replayed.error))
      return ok<Settled>({ result: 'replayed', edges: 0, state: replayed.value.issue.state })
    }
    // Edges belong to an Issue still settling: on any other one the event is ignored and nothing is chained
    // (`addAfter` is the verb for a queued Issue).
    const open = (await stores.reads.open()).find((row) => row.id === input.issue)
    const edges = open?.state === 'settling' ? await addEdges(stores, deps, input.issue, input.after) : ok(0)
    if (!edges.ok) return edges
    const recorded = await recordIn(stores.work, deps, {
      issueId: input.issue,
      key: key('settled', input.issue),
      event: { kind: 'settled', payload: settledPayload, actor: 'factory' },
    })
    if (!recorded.ok) return err(lift(recorded.error))
    const result =
      recorded.value.result === 'applied' ? 'settled' : recorded.value.result === 'replayed' ? 'replayed' : 'ignored'
    return ok<Settled>({ result, edges: edges.value, state: recorded.value.issue.state })
  })
}

/**
 * Adds edges to an Issue that is settling, queued, working or watching: a later `after`, from the owner or the queue
 * loop. On a working or watching Issue the edge is what lets the steward see a claim deadlock (it holds the repo's claim
 * while it is after an Issue that waits for one).
 */
export async function addAfter(
  deps: PlanningDeps,
  input: { issue: IssueId; after: readonly IssueId[] },
): Promise<Result<{ edges: number }, PlanningError | PortError>> {
  return deps.uow.run(async (stores) => {
    await stores.capacity.lock()
    const open = (await stores.reads.open()).find((row) => row.id === input.issue)
    if (!open) {
      const states = await stores.reads.statesOf([input.issue])
      return err<PlanningError>(
        states.has(input.issue)
          ? { kind: 'issue_closed', issue: input.issue }
          : { kind: 'unknown_issue', issue: input.issue },
      )
    }
    if (!['settling', 'queued', 'working', 'watching'].includes(open.state)) {
      return err<PlanningError>({
        kind: 'wrong_state',
        issue: input.issue,
        detail: `Issue ${issueNumber(input.issue)} is ${open.state}: only a settling, queued, working or watching Issue takes an edge`,
      })
    }
    const edges = await addEdges(stores, deps, input.issue, input.after)
    return edges.ok ? ok({ edges: edges.value }) : edges
  })
}

export interface PrioInput {
  issue: IssueId
  value: number
  /** a repeated key records nothing again */
  key: Key
}

/**
 * The owner's `prio` of an Issue: higher runs first within its class, and nothing but this verb sets it (no loop does). The newest by
 * time wins; the same key again is a replay.
 */
export async function setPrio(
  deps: PlanningDeps,
  input: PrioInput,
): Promise<Result<{ recorded: boolean }, PlanningError | PortError>> {
  return deps.uow.run(async ({ planning, reads }) => {
    const states = await reads.statesOf([input.issue])
    const state = states.get(input.issue)
    if (!state) return err<PlanningError>({ kind: 'unknown_issue', issue: input.issue })
    if (state === 'closed') return err<PlanningError>({ kind: 'issue_closed', issue: input.issue })
    const recorded = await planning.recordPrio({
      key: input.key,
      issue: input.issue,
      value: input.value,
      actor: 'owner',
      at: deps.clock.now(),
    })
    return ok({ recorded })
  })
}
