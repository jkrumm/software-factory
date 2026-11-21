import { doorSourceLines, unroutedLines } from '../domains/intake/health.ts'
import { type Alert, type Received, type RepoSignals } from '../domains/intake/model.ts'
import { type IntakeStore, type UnroutedRow } from '../domains/intake/ports.ts'
import { originOf, type Topology } from '../domains/intake/rules.ts'
import { issueRef } from '../kernel/ids.ts'
import { key as keyOf } from '../kernel/keys.ts'
import { ok } from '../kernel/result.ts'
import { loadIssue, type Out, refuse, type RequestCaller, type Stores, type IntakeDeps } from './intake-kit.ts'
import { type Alerts } from './intake-alerts.ts'

/** A monitor's route to a repo: set, remove, read, and the health lines of the door. */
export function createRoutes(d: { deps: IntakeDeps; alerts: Alerts }) {
  const { deps } = d
  const { uow, clock, settings } = d.deps
  const { downIn } = d.alerts

  const routes = () =>
    uow.run(async (s) => ok({ routes: await s.intake.routes(), unrouted: await s.intake.unrouted(200) }))

  /**
   * A lead (the agent token) names its Issue and may route or remove only a route of that Issue's repo: the owner's
   * registry stays the owner's for every other repo. Returns who sets the route, `owner` or `lead:<issue id>`.
   */
  async function setterOf(
    s: Stores,
    input: { source: string; monitor: string; repo?: string; issue?: string },
    caller: RequestCaller,
  ): Out<string> {
    if (caller !== 'agent') return ok('owner')
    if (!input.issue)
      return refuse(
        'trust_refused',
        'a lead names its Issue to route a monitor: --issue <id> (the CLI fills it in a lead session, where FACTORY_SESSION is set)',
      )
    const id = issueRef(input.issue)
    if (!id) return refuse('not_found', `no Issue ${input.issue}`)
    const issue = await loadIssue(s.work, id)
    if (!issue) return refuse('not_found', `no Issue ${input.issue}`)
    if (issue.state === 'closed') return refuse('trust_refused', `${id} is closed: a lead routes for an open Issue`)
    if (input.repo !== undefined && input.repo !== issue.repo)
      return refuse('trust_refused', `${id} is in ${issue.repo}: a lead routes only to its own repo`)
    const current = await s.intake.routeFor(input.source, input.monitor)
    if (current && current.repo !== issue.repo)
      return refuse(
        'trust_refused',
        `${input.source} ${input.monitor} routes to ${current.repo}: that is not a lead's to change`,
      )
    return ok(`lead:${id}`)
  }

  async function setRoute(
    input: { source: string; monitor: string; repo: string; issue?: string },
    caller: RequestCaller,
  ): Out<Awaited<ReturnType<IntakeStore['setRoute']>>> {
    const found = await deps.projects.find(input.repo)
    if (!found.ok) return found
    if (!found.value) return refuse('unknown_project', `${input.repo} is not a project the factory knows`)
    // A route into a work repo would let a monitor file there: the work repo hears the owner only.
    if (found.value.work) return refuse('unknown_project', `${input.repo} is a work repo: it hears the owner only`)
    const named = { ...input, repo: found.value.repo }
    const info = found.value
    // Kuma notifies on a change only: a monitor that is down now says nothing more, so its last alert is filed here.
    // The topology is read before the transaction, never inside it.
    const topology = await deps.topology.load()
    if (!topology.ok) return topology
    return uow.run(async (s) => {
      const setBy = await setterOf(s, named, caller)
      if (!setBy.ok) return setBy
      return routeIn(s, named, setBy.value, info, topology.value)
    })
  }

  /** Stores the route and, when the monitor was counted as down with no route, files its last alert in the route's repo. */
  async function routeIn(
    s: Stores,
    route: { source: string; monitor: string; repo: string },
    setBy: string,
    info: RepoSignals,
    topology: Topology,
  ): Out<Awaited<ReturnType<IntakeStore['setRoute']>>> {
    await s.intake.lock(`subject:${route.source}:${route.monitor}`)
    const waiting = await s.intake.unroutedOne(route.source, route.monitor)
    const stored = await s.intake.setRoute(route.source, route.monitor, route.repo, setBy)
    if (waiting?.status !== 'down' || waiting.group) return ok(stored)
    const received = unroutedSignal(waiting, route.repo, waiting.lastTitle, '')
    const filed = await downIn(s, received, received.alert as Alert, { info, topology })
    if (!filed.ok) return filed
    // The quarantined signal this monitor became while it had no route is answered by the Issue.
    const held = await s.intake.signalByKey(keyOf('held', waiting.source, waiting.monitor))
    if (held?.state === 'held' && filed.value.issue)
      await s.intake.setSignal(held.id, { state: 'promoted', issueId: filed.value.issue, repo: route.repo })
    return ok(stored)
  }

  const removeRoute = (input: { source: string; monitor: string; issue?: string }, caller: RequestCaller) =>
    uow.run(async (s) => {
      const setBy = await setterOf(s, input, caller)
      if (!setBy.ok) return setBy
      const gone = await s.intake.removeRoute(input.source, input.monitor)
      return gone ? ok(gone) : refuse('not_found', `no route for ${input.source} ${input.monitor}`)
    })

  /** The door's health lines (a refused source, a silent one, an unrouted monitor that stays down), derived at read. */
  const healthLines = (finishedMs: number): Out<string[]> =>
    uow.run(async (s) => {
      const now = clock.now()
      const lines = [
        ...doorSourceLines(await s.intake.doorSources(), now, finishedMs),
        ...unroutedLines(await s.intake.unrouted(200), now, settings.unroutedGraceMs),
      ]
      return ok(lines)
    })

  const unroutedSignal = (row: UnroutedRow, repo: string | null, title: string, text: string): Received => ({
    signal: {
      source: row.source,
      kind: 'alert',
      origin: originOf(row.source),
      trust: 'machine',
      repo,
      fingerprint: `${row.source}:${row.monitor}`,
      title,
      text,
      link: null,
      madeBy: null,
      probe: false,
    },
    alert: {
      subject: row.monitor,
      event: row.lastEvent,
      status: 'down',
      facts: { unrouted: true, downSince: row.downSince?.toISOString() ?? null },
    },
  })

  return { routes, setRoute, removeRoute, healthLines, routeIn, unroutedSignal }
}

export type Routes = ReturnType<typeof createRoutes>
