import { type DismissRequest, type PromoteRequest, type SignalDismissed } from '@software-factory/contract'
import { type Received, type RepoSignals, type Triaged } from '../domains/intake/model.ts'
import { type SignalRow, type SignalState } from '../domains/intake/ports.ts'
import { issueKindOf } from '../domains/intake/rules.ts'
import { key as keyOf } from '../kernel/keys.ts'
import { ok } from '../kernel/result.ts'
import { fileIn, recordIn } from './issues.ts'
import { MAX_DISMISS_REASON, type Out, refuse, triaged, type IntakeDeps } from './intake-kit.ts'
import { type Routes } from './intake-routes.ts'

/** A held signal the owner (or the Judge) promotes to an Issue or dismisses. */
export function createHeld(d: { deps: IntakeDeps; routes: Routes }) {
  const { deps } = d
  const { uow, clock } = d.deps
  const { routeIn } = d.routes

  /** `steer`: what the lead of the new Issue is told first (a note from the factory). */
  async function promote(
    id: string,
    body: PromoteRequest,
    by: 'owner' | 'judge' = 'owner',
    steer?: string,
  ): Out<Triaged> {
    const probe = await uow.run(async (s) => ok(await s.intake.signal(id)))
    if (!probe.ok) return probe
    const row = probe.value
    if (!row) return refuse('not_found', `no signal ${id}`)
    const asked = body.repo ?? row.received.signal.repo
    if (!asked) return refuse('no_repo', 'this signal names no repo: promote it with one')
    const found = await deps.projects.find(asked)
    if (!found.ok) return found
    if (!found.value) return refuse('unknown_project', `${asked} is not a project the factory knows`)
    const repo = found.value.repo
    if ((row.received.alert?.facts as { unrouted?: unknown } | null)?.unrouted === true)
      return promoteUnrouted(id, found.value, by)
    return uow.run(async (s): Out<Triaged> => {
      await s.intake.lock(`promote:${id}`)
      const current = await s.intake.signal(id)
      if (!current) return refuse('not_found', `no signal ${id}`)
      if (current.state !== 'held') return refuse('not_held', `signal ${id} is ${current.state}`)
      const r: Received = { ...current.received, signal: { ...current.received.signal, repo } }
      const now = clock.now()
      const filed = await fileIn(s.work, deps, {
        key: keyOf('filed', 'signal', id),
        event: {
          kind: 'filed',
          payload: { repo, title: r.signal.title, kind: issueKindOf(r), origin: r.signal.origin },
          actor: by === 'owner' ? 'owner' : 'factory',
        },
      })
      if (!filed.ok) return filed
      const issue = filed.value.issue.id
      if (steer) {
        const steered = await recordIn(s.work, deps, {
          issueId: issue,
          key: keyOf('noted', 'promote', id),
          event: { kind: 'noted', payload: { text: steer }, actor: 'factory' },
        })
        if (!steered.ok) return steered
      }
      await s.intake.setSignal(id, { state: 'promoted', issueId: issue, repo })
      // A promoted signal is found by its fingerprint next time (an alert by its subject too): a duplicate amends the Issue.
      const fromBacklog = (r.alert?.facts as { backlog?: unknown } | null)?.backlog === true
      await s.intake.insertSubject({
        source: r.signal.source,
        subject: r.alert?.subject ?? r.signal.fingerprint,
        fingerprint: r.signal.fingerprint,
        issueId: issue,
        groupKey: null,
        filedAt: now,
        lastSeen: now,
        repeats: 0,
        upAt: null,
        // A stranger's issue is answered with a comment, never closed on GitHub; the backlog sweep's writes nothing.
        writeback: r.alert !== null && r.signal.source === 'github' && !fromBacklog,
        admitted: r.alert !== null && r.signal.source === 'github' && !fromBacklog ? 'label' : null,
      })
      return ok(triaged('filed', 'promoted', issue, id))
    })
  }

  /**
   * A held signal that is a monitor down with no route: promoting it sets the route in the repo and files the monitor's
   * last alert there (`routeIn`, which also answers this held signal). A monitor that came back up meanwhile has nothing
   * to file: the route stays and the signal is dismissed with that reason.
   */
  async function promoteUnrouted(id: string, info: RepoSignals, by: 'owner' | 'judge'): Out<Triaged> {
    // A route into a work repo would let a monitor file there: the work repo hears the owner only.
    if (info.work) return refuse('unknown_project', `${info.repo} is a work repo: it hears the owner only`)
    const topology = await deps.topology.load()
    if (!topology.ok) return topology
    return uow.run(async (s): Out<Triaged> => {
      await s.intake.lock(`promote:${id}`)
      const current = await s.intake.signal(id)
      if (!current) return refuse('not_found', `no signal ${id}`)
      if (current.state !== 'held') return refuse('not_held', `signal ${id} is ${current.state}`)
      const { source, subject } = { source: current.received.signal.source, subject: current.received.alert?.subject }
      if (!subject) return refuse('invalid', `signal ${id} names no monitor`)
      const routed = await routeIn(
        s,
        { source, monitor: subject, repo: info.repo },
        by === 'owner' ? 'owner' : 'factory:screen',
        info,
        topology.value,
      )
      if (!routed.ok) return routed
      const after = await s.intake.signal(id)
      if (after?.state === 'promoted') return ok(triaged('filed', 'promoted', after.issueId, id))
      await s.intake.setSignal(id, {
        state: 'dismissed',
        issueId: null,
        dismissal: { reason: `the monitor is up again; it now routes to ${info.repo}`, by, at: clock.now() },
      })
      return ok(triaged('dropped', 'promoted', null, id, `the monitor is up again; it now routes to ${info.repo}`))
    })
  }

  /** The owner (or the Judge) turns a held signal away: it files nothing and stays on record as dismissed. */
  async function dismiss(id: string, body: DismissRequest, by: 'owner' | 'judge' = 'owner'): Out<SignalDismissed> {
    const reason = body.reason.trim()
    if (reason.length === 0 || reason.length > MAX_DISMISS_REASON) {
      return refuse('invalid', `a reason of 1 to ${MAX_DISMISS_REASON} characters is required`)
    }
    return uow.run(async (s): Out<SignalDismissed> => {
      await s.intake.lock(`dismiss:${id}`)
      const current = await s.intake.signal(id)
      if (!current) return refuse('not_found', `no signal ${id}`)
      if (current.state !== 'held') return refuse('not_held', `signal ${id} is ${current.state}`)
      await s.intake.setSignal(id, {
        state: 'dismissed',
        issueId: null,
        dismissal: { reason, by, at: clock.now() },
      })
      return ok({ signal: id, state: 'dismissed' })
    })
  }

  function list(state: SignalState | null): Out<SignalRow[]> {
    return uow.run(async (s) => ok(await s.intake.signals(state, 200)))
  }

  return { promote, dismiss, list }
}
