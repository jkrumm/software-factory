import { type Signal } from '@software-factory/contract'
import {
  type Alert,
  type ClosedIssue,
  type OpenIssue,
  type Received,
  type RepoSignals,
  type Triaged,
} from '../domains/intake/model.ts'
import { gate, groupOf, isRetroSignal, matchOpen, overlap, type Topology } from '../domains/intake/rules.ts'
import { type IssueId } from '../kernel/ids.ts'
import { type Key } from '../kernel/keys.ts'
import { ok, type Result } from '../kernel/result.ts'
import {
  type Decision,
  dropped,
  eventKeyOf,
  type IntakeError,
  isOpen,
  joinableIncident,
  loadIssue,
  type Out,
  type IntakeDeps,
} from './intake-kit.ts'
import { type Alerts } from './intake-alerts.ts'
import { type Signals } from './intake-signals.ts'
import { type Quarantine } from './intake-quarantine.ts'

/** The workflow sees the Issues closed this recently, so a restated ask can be answered "already covered". */
const SETTLED_WINDOW_MS = 24 * 60 * 60_000
const MAX_SETTLED = 20
const MAX_OPEN_SHOWN = 40

/** Taking a signal in: the gates, then the road its kind takes; the triage workflow decides amend or new for a person's ask and a `down`. */
export function createReceive(d: { deps: IntakeDeps; alerts: Alerts; signals: Signals; quarantine: Quarantine }) {
  const { deps } = d
  const { uow, clock, settings } = d.deps
  const { downIn, upIn } = d.alerts
  const { eventIn, humanIn, findingIn, withoutFindings } = d.signals
  const { probeIn, hold, outsideIn, fingerprintKnown } = d.quarantine

  /** The answer, or null when it is not there after `ms`: the call is not cancelled, only no longer waited for. */
  async function withinWait<T>(call: Promise<T>, ms: number): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms)
    })
    try {
      return await Promise.race([call, late])
    } finally {
      clearTimeout(timer)
    }
  }

  /** The workflow's call, outside any transaction: the open Issues and those closed in the last day; null when it did not answer. */
  async function askTriage(signal: Signal, open: readonly OpenIssue[]): Promise<Decision | null> {
    const closed = signal.repo
      ? await deps.openIssues.closedSince(signal.repo, new Date(clock.now().getTime() - SETTLED_WINDOW_MS), MAX_SETTLED)
      : ok<ClosedIssue[]>([])
    const settled = closed.ok ? closed.value : []
    if (open.length === 0 && settled.length === 0) return null
    const asked = await withinWait(deps.triage.amendOrNew({ signal, candidates: open, settled }), settings.triageWaitMs)
    return asked?.ok ? asked.value : null
  }

  /**
   * A `down` that no fingerprint-free road already handles (a replayed event, a subject with an open Issue, an open
   * incident of its host) goes to the workflow, which may amend an open Issue or call it already covered.
   */
  async function decideDown(
    r: Received,
    alert: Alert,
    info: RepoSignals,
    topology: Topology,
  ): Promise<Result<Decision | undefined, IntakeError>> {
    const { signal } = r
    const evKey = eventKeyOf(r) as Key
    const handled = await uow.run(async (s) => {
      if ((await s.intake.signalByKey(evKey)) || (await s.intake.seen(evKey))) return ok(true)
      const latest = await s.intake.latestSubject(signal.source, alert.subject)
      if (latest && isOpen(await loadIssue(s.work, latest.issueId))) return ok(true)
      const groupKey = groupOf(topology, r, signal.repo as string, info.host)
      if (!groupKey) return ok(false)
      return ok((await joinableIncident(s, groupKey, clock.now(), settings.incidentWindowMs)) !== null)
    })
    if (!handled.ok) return handled
    if (handled.value) return ok(undefined)
    const open = await deps.openIssues.inRepo(signal.repo as string)
    if (!open.ok) return open
    return ok((await askTriage(signal, open.value.slice(0, MAX_OPEN_SHOWN))) ?? undefined)
  }

  /** Whether an agent's signal is the follow-up of an Issue the owner filed, from that Issue's own repo (its lead). */
  async function ownerFiledBy(signal: Signal, filer: IssueId | null): Promise<boolean> {
    if (signal.trust !== 'agent' || filer === null) return false
    const issue = await uow.run(async (s) => ok(await loadIssue(s.work, filer)))
    if (!issue.ok || !issue.value) return false
    return issue.value.origin === 'you' && signal.source === `agent:${issue.value.repo}`
  }

  async function receive(
    r: Received,
    filer: IssueId | null = null,
    findingKey: Key | null = null,
    repeatWindowMs?: number,
  ): Out<Triaged> {
    const { signal, alert } = r
    // The loop guard: a change a loop made never fires an automatic sender again.
    if (signal.madeBy !== null && (signal.trust === 'machine' || signal.trust === 'agent')) {
      return ok(dropped('loop_guard', `${signal.madeBy} made the change this reports; it does not fire again`))
    }
    if (signal.trust === 'outside') {
      const where = signal.repo ? await deps.projects.find(signal.repo) : ok(null)
      if (!where.ok) return where
      if (where.value?.work) return ok(dropped('work_repo', `${signal.repo} is a work repo: it hears the owner only`))
      if (signal.probe) return uow.run(async (s) => probeIn(s, r))
      return uow.run(async (s) => outsideIn(s, r))
    }

    const found = signal.repo ? await deps.projects.find(signal.repo) : ok(null)
    if (!found.ok) return found
    const verdict = gate(signal, found.value)
    if (!verdict.pass) {
      // A work repo hears the owner only, but the lead of an Issue the owner filed may owe work there: its signal waits
      // as a held one for the owner to promote (never work by itself, never screened).
      if (verdict.detail === 'work_repo' && !signal.probe && (await ownerFiledBy(signal, filer))) {
        return uow.run(async (s) =>
          hold(s, r, undefined, 'a work repo hears the owner only: the signal waits for the owner to promote it'),
        )
      }
      return ok(dropped(verdict.detail, verdict.reason))
    }
    if (signal.probe) return uow.run(async (s) => probeIn(s, r))
    if (findingKey && !alert) {
      return uow.run(async (s) => {
        await s.intake.lock(findingKey)
        return findingIn(s, r, findingKey, repeatWindowMs)
      })
    }
    const info = found.value as RepoSignals

    if (alert?.status === 'down' || alert?.status === 'up') {
      const topology = await deps.topology.load()
      if (!topology.ok) return topology
      const name = `subject:${signal.source}:${alert.subject}`
      const decided = alert.status === 'down' ? await decideDown(r, alert, info, topology.value) : ok(undefined)
      if (!decided.ok) return decided
      const decision = decided.value
      return uow.run(async (s) => {
        await s.intake.lock(name)
        return alert.status === 'down'
          ? downIn(s, r, alert, { info, topology: topology.value, decision })
          : upIn(s, r, alert)
      })
    }
    if (alert) {
      return uow.run(async (s) => {
        await s.intake.lock(`subject:${signal.source}:${alert.subject}`)
        return eventIn(s, r, alert)
      })
    }

    // A person's or an agent's signal: amend an open Issue when the title clearly says so; otherwise the workflow sees
    // the open Issues and the ones closed in the last day, unless the fingerprint already settles it.
    // The Issue whose lead files this is never a candidate: its follow-up is work for others, not a note on itself.
    const inRepo = signal.repo ? await deps.openIssues.inRepo(signal.repo) : ok<OpenIssue[]>([])
    if (!inRepo.ok) return inRepo
    const others = inRepo.value.filter((issue) => issue.id !== filer)
    // An agent's words never land on an Issue a loop's finding filed: that Issue answers its own key.
    const kept = signal.trust === 'agent' ? await withoutFindings(others) : ok(others)
    if (!kept.ok) return kept
    const open = kept.value
    // A retro recommendation files its own Issue: only its own fingerprint (the same ask again) folds into an open one.
    const retro = isRetroSignal(signal.text)
    const match = retro ? ({ kind: 'none' } as const) : matchOpen(signal.title, open)
    let decision: Decision = { amend: match.kind === 'match' ? match.issue.id : null }
    if (!retro && match.kind !== 'match') {
      const known = await uow.run(async (s) => ok(await fingerprintKnown(s, r)))
      if (!known.ok) return known
      if (!known.value) {
        const ordered = open
          .map((issue) => ({ issue, score: overlap(signal.title, issue.title) }))
          .sort((a, b) => b.score - a.score || a.issue.id.localeCompare(b.issue.id))
          .slice(0, MAX_OPEN_SHOWN)
          .map((entry) => entry.issue)
        // An unanswered workflow files anew: a duplicate costs a note, a lost request costs the work.
        decision = (await askTriage(signal, ordered)) ?? decision
      }
    }
    return uow.run(async (s) => {
      await s.intake.lock(`human:${signal.source}:${signal.fingerprint}`)
      return humanIn(s, r, decision)
    })
  }

  return { receive }
}

export type Receive = ReturnType<typeof createReceive>
