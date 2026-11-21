import { placeByName } from '../domains/intake/place.ts'
import { type Alert } from '../domains/intake/model.ts'
import { type PendingRow, type UnroutedRow } from '../domains/intake/ports.ts'
import { type Topology } from '../domains/intake/rules.ts'
import { ok, type Result } from '../kernel/result.ts'
import { type IntakeError, type Out, type IntakeDeps } from './intake-kit.ts'
import { type Alerts } from './intake-alerts.ts'
import { type Routes } from './intake-routes.ts'
import { type Quarantine } from './intake-quarantine.ts'

/** A runbook claimed and not recorded (a crash) is looked at again after this: its timeout and a margin. */
const RUNBOOK_LEASE_MS = 150_000
const HEAL_BATCH = 20
const UNROUTED_BATCH = 20
const TAIL = 500

/** The suffix Kuma monitors carry for a push or door check of a service. */
const SUFFIX = /\s+[-–—]\s+(push|door)$/i

/** The heal pass: a due `down` runs its runbook or files, an unrouted monitor that stayed down is placed or filed once. */
export function createHeal(d: { deps: IntakeDeps; alerts: Alerts; routes: Routes; quarantine: Quarantine }) {
  const { deps } = d
  const { uow, clock, settings } = d.deps
  const { downIn } = d.alerts
  const { routeIn, unroutedSignal } = d.routes
  const { hold } = d.quarantine

  async function healOne(source: string, subject: string, topology: Topology): Promise<Result<void, IntakeError>> {
    const waiting = await uow.run(async (s) => ok(await s.intake.pendingOf(source, subject)))
    if (!waiting.ok) return waiting
    if (!waiting.value) return ok(undefined)
    const found = await deps.projects.find(waiting.value.repo)
    if (!found.ok) return found
    const info = found.value

    // (a) Claim the run, or file: one short transaction, no port.
    const claimed = await uow.run(async (s): Out<{ row: PendingRow } | null> => {
      const now = clock.now()
      // The subject's lock comes first, as in `receive`: the other order is a deadlock with an `up` deleting this row.
      await s.intake.lock(`subject:${source}:${subject}`)
      const row = await s.intake.claimPending(source, subject, now)
      if (!row) return ok(null)
      if (row.rule.runbook && row.attempts < row.rule.max) {
        await s.intake.leasePending(source, subject, {
          attempts: row.attempts + 1,
          dueAt: new Date(now.getTime() + RUNBOOK_LEASE_MS),
        })
        return ok({ row })
      }
      const reason = !row.rule.runbook ? 'no runbook' : 'attempts spent'
      const results = [...row.results, { at: now.toISOString(), skipped: reason }]
      await s.intake.deletePending(source, subject)
      // The repo stopped being a project meanwhile: nothing files, and the row is gone rather than retried for ever.
      if (!info || info.work) return ok(null)
      const filed = await downIn(s, row.received, row.received.alert as Alert & { status: 'down' }, {
        info,
        topology,
        heal: { graceMs: row.rule.graceMs, attempts: row.attempts, results },
      })
      return filed.ok ? ok(null) : filed
    })
    if (!claimed.ok) return claimed
    if (!claimed.value) return ok(undefined)
    const { row } = claimed.value

    // (b) The runbook, outside any transaction.
    const ran = await deps.runbook.run({ repo: row.repo, runbook: row.rule.runbook as 'make restart' })
    const at = clock.now()
    const entry = !ran.ok
      ? { at: at.toISOString(), exit: -1, tail: ran.error.detail.slice(-TAIL) }
      : ran.value.ran
        ? { at: at.toISOString(), exit: ran.value.exit, tail: ran.value.tail.slice(-TAIL) }
        : { at: at.toISOString(), skipped: ran.value.reason }
    const skipped = ran.ok && !ran.value.ran

    // (c) Record it; the grace starts over from the end of the run, and a skipped runbook is due at once. A row an
    // `up` deleted meanwhile stays gone.
    return uow.run(async (s) => {
      await s.intake.recordPendingRun(source, subject, entry, skipped ? at : new Date(at.getTime() + row.rule.graceMs))
      if (skipped) await s.intake.leasePending(source, subject, { attempts: row.rule.max, dueAt: at })
      return ok(undefined)
    })
  }

  /**
   * Where an unrouted monitor belongs: the repo of a route of the same source for `<name> - Push|Door`, else the project
   * its name says (`placeByName`), else nothing. Both are `mapped`: the monitor gets that route.
   */
  async function placeFor(source: string, monitor: string, names: readonly string[]): Promise<string | null> {
    const base = monitor.replace(SUFFIX, '')
    if (base !== monitor && base) {
      const known = await uow.run(async (s) => ok(await s.intake.routes()))
      const hit = known.ok
        ? known.value.find(
            (route) => route.source === source && route.monitor.toLowerCase().startsWith(`${base.toLowerCase()} - `),
          )
        : undefined
      if (hit) return hit.repo
    }
    return placeByName(monitor, names)
  }

  const HOME_TITLE = 'No repo hears this alert, pick its repo: '
  /** What the owner reads when the factory has no repo to ask: what fired, since when, and what the one answer does. */
  const heldAsk = (row: UnroutedRow): string => {
    const since = row.downSince ? ` since ${row.downSince.toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''
    return `The alert "${row.lastTitle}" from ${row.source} has been firing${since} and reached no repo, because no repo is assigned to ${row.monitor}. Pick the repo it belongs to: the monitor gets that route and the alert is filed there.`
  }
  const HOME_ASK =
    'No door route exists for this monitor, so its alerts reach no repo. Decide which repo it belongs to and add the route with `factory door route-set`; fix the monitor if it is down for a reason of its own.'

  /**
   * A monitor with no route, in three steps and never the owner first: (1) one the factory can place by its name gets
   * that route, up or down, and files its last alert when it is down; (2) one down past the grace with no place is
   * filed in the home repo, asking for a route; (3) with no home repo, one down past `unroutedHeldMs` is held in
   * Needs you, once.
   */
  async function fileUnrouted(topology: Topology): Promise<Result<void, IntakeError>> {
    const names = await deps.projects.names()
    if (!names.ok) return names
    const all = await uow.run(async (s) => ok(await s.intake.unrouted(200)))
    if (!all.ok) return all
    let routed = 0
    for (const row of all.value) {
      if (routed >= UNROUTED_BATCH) break
      const repo = await placeFor(row.source, row.monitor, names.value)
      if (!repo) continue
      const found = await deps.projects.find(repo)
      if (!found.ok || !found.value || found.value.work) continue
      const info = found.value
      const out = await uow.run(async (s) => {
        // A route set meanwhile (by the owner) stays his.
        if (await s.intake.routeFor(row.source, row.monitor)) return ok(null)
        return routeIn(s, { source: row.source, monitor: row.monitor, repo: info.repo }, 'factory:name', info, topology)
      })
      if (!out.ok) return out
      routed++
    }

    const due = await uow.run(async (s) =>
      ok(await s.intake.dueUnrouted(clock.now(), settings.unroutedGraceMs, UNROUTED_BATCH)),
    )
    if (!due.ok) return due
    for (const row of due.value) {
      const title = `${HOME_TITLE}${row.lastTitle}`
      const home = settings.homeRepo ? await deps.projects.find(settings.homeRepo) : null
      if (home && !home.ok) return home
      const info = home?.ok ? home.value : null
      if (info && !info.work) {
        const received = unroutedSignal(row, info.repo, title, HOME_ASK)
        const out = await uow.run(async (s) => {
          await s.intake.lock(`subject:${row.source}:${row.monitor}`)
          const filed = await downIn(s, received, received.alert as Alert, { info, topology })
          if (filed.ok && filed.value.issue)
            await s.intake.markUnroutedFiled(row.source, row.monitor, row.lastEvent, filed.value.issue, clock.now())
          return filed
        })
        if (!out.ok) return out
        continue
      }
      if (!row.downSince || clock.now().getTime() - row.downSince.getTime() < settings.unroutedHeldMs) continue
      const held = unroutedSignal(row, null, title, heldAsk(row))
      const out = await uow.run(async (s) => {
        await s.intake.lock(`subject:${row.source}:${row.monitor}`)
        const stored = await hold(s, held, undefined, 'a monitor down with no route and no repo to place it in')
        if (stored.ok) await s.intake.markUnroutedHeld(row.source, row.monitor, row.lastEvent, clock.now())
        return stored
      })
      if (!out.ok) return out
    }
    return ok(undefined)
  }

  /** The heal pass: due `down`s run their runbook or file; an unrouted monitor that stayed down is filed once. */
  async function heal(): Promise<Result<void, IntakeError>> {
    const topology = await deps.topology.load()
    if (!topology.ok) return topology
    const due = await uow.run(async (s) => ok(await s.intake.duePending(clock.now(), HEAL_BATCH)))
    if (!due.ok) return due
    for (const { source, subject } of due.value) {
      const healed = await healOne(source, subject, topology.value)
      if (!healed.ok) return healed
    }
    return fileUnrouted(topology.value)
  }

  return { heal }
}
