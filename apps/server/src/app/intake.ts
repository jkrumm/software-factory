import {
  type AlertRequest,
  cleanText,
  type DoorReport,
  FEEDBACK_ROUTE_SOURCE,
  type FeedbackRequest,
  feedbackSource,
  feedbackTokenKey,
  MAX_TITLE_CHARS,
  type DismissRequest,
  type PromoteRequest,
  type SignalDismissed,
  type Signal,
  type SignalRequest,
  storable,
} from '@software-factory/contract'
import { doorSourceLines, unroutedLines } from '../domains/intake/health.ts'
import { NOT_SCREENED } from '../domains/intake/screen.ts'
import type { Alert, HealRule, OpenIssue, Received, RepoSignals, Triaged } from '../domains/intake/model.ts'
import type {
  Dismissal,
  IntakeSink,
  IntakeStore,
  IntakeTopology,
  OpenIssues,
  PendingRow,
  ProjectSignals,
  Runbook,
  SignalRow,
  SignalState,
  SubjectState,
  TriageWorkflow,
  Writeback,
} from '../domains/intake/ports.ts'
import {
  fingerprintOf,
  gate,
  groupOf,
  issueKindOf,
  matchOpen,
  noteOf,
  originOf,
  type Topology,
} from '../domains/intake/rules.ts'
import type { WorkStore } from '../domains/work/ports.ts'
import type { Issue } from '../domains/work/issue.ts'
import { replay } from '../domains/work/machine.ts'
import type { IssueId } from '../kernel/ids.ts'
import { idOf, issueRef } from '../kernel/ids.ts'
import { key as keyOf, type Key } from '../kernel/keys.ts'
import { err, ok, portError, type PortError, type Result } from '../kernel/result.ts'
import { fileIn, type IssueWriteError, recordIn, type WriteDeps } from './issues.ts'
import type { UnitOfWork } from './unit-of-work.ts'

export type Stores = { work: WorkStore; intake: IntakeStore }
export type IntakeWrites = UnitOfWork<Stores>

/** What a use case of intake refuses besides a failed write. */
export type IntakeRefusal = {
  kind: 'not_found' | 'not_held' | 'invalid' | 'no_repo' | 'unknown_project' | 'trust_refused'
  detail: string
}

/** Who is calling, as the token says (`api/policy.ts`); only the owner, an agent and the signal token may put a signal in. */
export type RequestCaller = 'owner' | 'agent' | 'machine' | 'signal' | 'read'

/** The one source the signal token files as: Hermes, carrying the owner's words. */
export const SIGNAL_SOURCE = 'owner:hermes'
export type IntakeError = IssueWriteError | PortError | IntakeRefusal

export interface IntakeSettings {
  /** alerts on one host join an incident while its last alert is younger than this */
  incidentWindowMs: number
  /** a stateless signal's fingerprint still matches an Issue closed this recently */
  fingerprintWindowMs: number
  /** a monitor with no route that stays down this long is filed once */
  unroutedGraceMs: number
  /** where an unrouted monitor's Issue is filed when no repo can be told from its name */
  homeRepo: string | null
}

export const DEFAULT_INTAKE_SETTINGS: IntakeSettings = {
  incidentWindowMs: 30 * 60_000,
  fingerprintWindowMs: 24 * 60 * 60_000,
  unroutedGraceMs: 10 * 60_000,
  homeRepo: null,
}

export interface IntakeDeps extends WriteDeps {
  uow: IntakeWrites
  projects: ProjectSignals
  topology: IntakeTopology
  openIssues: OpenIssues
  triage: TriageWorkflow
  runbook: Runbook
  settings: IntakeSettings
}

type Out<T> = Promise<Result<T, IntakeError>>

/** A runbook claimed and not recorded (a crash) is looked at again after this: its timeout and a margin. */
const RUNBOOK_LEASE_MS = 150_000
const SETTLE_BATCH = 20
const UNROUTED_BATCH = 20
const TAIL = 500
const MAX_DISMISS_REASON = 500
const PROBE_REASON = 'marked as a probe'

const refuse = (kind: IntakeRefusal['kind'], detail: string): Result<never, IntakeRefusal> => err({ kind, detail })

const triaged = (
  outcome: Triaged['outcome'],
  detail: Triaged['detail'],
  issue: IssueId | null = null,
  signal: string | null = null,
  reason: string | null = null,
): Triaged => ({ outcome, detail, issue, signal, reason })

const dropped = (detail: Triaged['detail'], reason: string): Triaged => triaged('dropped', detail, null, null, reason)

/** What a replayed event answers: what it answered the first time. */
function replayedOf(row: SignalRow): Triaged {
  const outcome = row.state === 'promoted' ? 'filed' : row.state === 'dismissed' ? 'dropped' : row.state
  return triaged(outcome, 'replayed', row.issueId, row.id)
}

const eventKeyOf = (received: Received): Key | null =>
  received.alert ? keyOf('signal', received.signal.source, received.alert.subject, received.alert.event) : null

/** The question a lead is asked is the signal's words; an owner's are the owner's, everyone else's are data. */
const noteText = (received: Received, lead?: string): string =>
  received.signal.trust === 'owner'
    ? [lead ?? received.signal.title, received.signal.text].filter(Boolean).join('\n')
    : noteOf(received, lead)

const actorOf = (received: Received): 'owner' | 'factory' => (received.signal.trust === 'owner' ? 'owner' : 'factory')

async function loadIssue(work: WorkStore, id: IssueId): Promise<Issue | null> {
  const history = await work.history(id)
  return history ? replay(id, history) : null
}

const isOpen = (issue: Issue | null): issue is Issue => issue !== null && issue.state !== 'closed'

const TRUST_RANK = { outside: 0, agent: 1, owner: 2 } as const

/**
 * The envelope for what a person or an agent put in. The caller's token decides the trust: the owner's is `owner`, an
 * agent's is `agent`. The claimed `from` is a source label that may lower the trust (an agent's token under
 * `feedback:<app>` is `outside`) and never raises it: `owner*` under an agent's token is refused. The signal token is
 * the owner's voice through Hermes and nothing else: its `from` is exactly `owner:hermes` (trust `owner`), any other is refused.
 */
export function envelopeOfRequest(body: SignalRequest, caller: RequestCaller): Result<Signal, IntakeRefusal> {
  if (caller === 'signal' && body.from !== SIGNAL_SOURCE) {
    return refuse('trust_refused', `the signal token may file only as ${SIGNAL_SOURCE}, not as ${body.from}`)
  }
  const [kind, who] = body.from.split(':') as [string, string | undefined]
  const claimed = kind === 'owner' ? 'owner' : kind === 'agent' ? 'agent' : 'outside'
  const ceiling = caller === 'owner' || caller === 'signal' ? 'owner' : caller === 'agent' ? 'agent' : 'outside'
  if (TRUST_RANK[claimed] > TRUST_RANK[ceiling]) {
    return refuse('trust_refused', `the ${caller} token may not file a signal as ${body.from}`)
  }
  const trust = claimed
  const repo = trust === 'agent' ? (body.repo ?? who ?? null) : trust === 'owner' ? (body.repo ?? null) : null
  return ok({
    source: body.from,
    kind: body.kind,
    origin: originOf(body.from),
    trust,
    repo: repo ?? null,
    fingerprint: fingerprintOf(repo, cleanText(body.title)),
    title: cleanText(body.title).slice(0, MAX_TITLE_CHARS) || 'untitled',
    text: cleanText(body.text),
    link: body.link ? cleanText(body.link) : null,
    madeBy: null,
    probe: body.probe,
  })
}

/** The facts of an alert as the text a lead reads: compact JSON, clipped. */
export function factsText(facts: unknown): string {
  const text = JSON.stringify(facts ?? {})
  return text === '{}' ? '' : text.slice(0, 6000)
}

const GROUP_MESSAGE = /child monitors? (down|up)/i

/** A group monitor's alert (Kuma: 'Child monitors down') names no thing of its own: the children are the alerts. */
function isGroupAlert(input: AlertRequest): boolean {
  const facts = input.facts as { msg?: unknown; heartbeat?: { msg?: unknown } } | null
  return [input.title, facts?.msg, facts?.heartbeat?.msg].some(
    (text) => typeof text === 'string' && GROUP_MESSAGE.test(text),
  )
}

/** The suffix Kuma monitors carry for a push or door check of a service. */
const SUFFIX = /\s+[-–—]\s+(push|door)$/i

export function createIntake(deps: IntakeDeps) {
  const { uow, clock, ids, settings } = deps

  const note = (s: Stores, issueId: IssueId, evKey: Key, received: Received, lead?: string) =>
    recordIn(s.work, deps, {
      issueId,
      key: evKey,
      event: { kind: 'noted', payload: { text: noteText(received, lead) }, actor: actorOf(received) },
    })

  async function store(
    s: Stores,
    received: Received,
    key: Key | null,
    state: SignalState,
    issueId: IssueId | null,
    dismissal: Dismissal | null = null,
  ): Promise<string> {
    const id = ids.next('signal')
    await s.intake.insertSignal({
      id,
      key,
      received,
      receivedAt: clock.now(),
      state,
      issueId,
      dismissal,
      screening: NOT_SCREENED,
    })
    return id
  }

  // ---- stateful: a monitor that goes down and comes up ----

  async function amendOpen(
    s: Stores,
    r: Received,
    alert: Alert,
    issue: Issue,
    subjectId: number,
    groupKey: string | null,
  ): Out<Triaged> {
    const now = clock.now()
    const evKey = eventKeyOf(r) as Key
    let detail: Triaged['detail'] = 'repeat'
    let recorded = false
    if (issue.state === 'watching') {
      // A `down` while the watch runs is the change breaking something: the machine takes it back to its lead.
      const regressed = await recordIn(s.work, deps, {
        issueId: issue.id,
        key: keyOf('regressed', 'signal', r.signal.source, alert.subject, alert.event),
        event: { kind: 'regressed', payload: { watch: issue.watch, detail: noteText(r) }, actor: 'factory' },
      })
      if (!regressed.ok) return regressed
      recorded = regressed.value.result === 'applied'
      if (recorded) detail = 'regression'
    }
    if (!recorded) {
      const noted = await note(
        s,
        issue.id,
        keyOf('noted', 'signal', r.signal.source, alert.subject, alert.event),
        r,
        'down again',
      )
      if (!noted.ok) return noted
    }
    await s.intake.touchSubject(subjectId, { at: now, upAt: null, repeat: true })
    if (groupKey) await s.intake.touchIncident(issue.id, now)
    const signal = await store(s, r, evKey, 'amended', issue.id)
    return ok(triaged('amended', detail, issue.id, signal))
  }

  async function join(s: Stores, r: Received, alert: Alert, issue: Issue, groupKey: string): Out<Triaged> {
    const now = clock.now()
    const noted = await note(
      s,
      issue.id,
      keyOf('noted', 'signal', r.signal.source, alert.subject, alert.event),
      r,
      'joins this incident',
    )
    if (!noted.ok) return noted
    await s.intake.insertSubject({
      source: r.signal.source,
      subject: alert.subject,
      fingerprint: null,
      issueId: issue.id,
      groupKey,
      filedAt: now,
      lastSeen: now,
      repeats: 0,
      upAt: null,
      writeback: false,
      admitted: null,
    })
    await s.intake.touchIncident(issue.id, now)
    const signal = await store(s, r, eventKeyOf(r), 'incident', issue.id)
    return ok(triaged('incident', 'joined', issue.id, signal))
  }

  async function fileNew(
    s: Stores,
    r: Received,
    filedKey: Key,
    options: { groupKey: string | null; writeback?: boolean; admitted?: string | null; stateKey?: Key | null },
  ): Out<Triaged> {
    const now = clock.now()
    const { signal } = r
    const filed = await fileIn(s.work, deps, {
      key: filedKey,
      event: {
        kind: 'filed',
        payload: { repo: signal.repo as string, title: signal.title, kind: issueKindOf(r), origin: signal.origin },
        actor: actorOf(r),
      },
    })
    if (!filed.ok) return filed
    const issue = filed.value.issue
    if (filed.value.result === 'replayed') return ok(triaged('filed', 'replayed', issue.id))
    const stored = await store(
      s,
      r,
      options.stateKey === undefined ? eventKeyOf(r) : options.stateKey,
      'filed',
      issue.id,
    )
    if (r.alert) {
      await s.intake.insertSubject({
        source: signal.source,
        subject: r.alert.subject,
        fingerprint: r.alert.status === 'event' ? signal.fingerprint : null,
        issueId: issue.id,
        groupKey: options.groupKey,
        filedAt: now,
        lastSeen: now,
        repeats: 0,
        upAt: null,
        writeback: options.writeback ?? false,
        admitted: options.admitted ?? null,
      })
    }
    if (options.groupKey) {
      await s.intake.insertIncident({ issueId: issue.id, groupKey: options.groupKey, openedAt: now, lastAlertAt: now })
    }
    return ok(triaged('filed', 'new', issue.id, stored))
  }

  async function downIn(
    s: Stores,
    r: Received,
    alert: Alert,
    ctx: { info: RepoSignals; topology: Topology; settle?: unknown },
  ): Out<Triaged> {
    const now = clock.now()
    const { signal } = r
    const evKey = eventKeyOf(r) as Key
    const prior = await s.intake.signalByKey(evKey)
    if (prior) return ok(replayedOf(prior))
    if (await s.intake.seen(evKey)) return ok(dropped('replayed', 'this event already settled'))

    const latest = await s.intake.latestSubject(signal.source, alert.subject)
    if (latest) {
      const issue = await loadIssue(s.work, latest.issueId)
      if (isOpen(issue)) return amendOpen(s, r, alert, issue, latest.id, latest.groupKey)
    }

    const groupKey = groupOf(ctx.topology, r, signal.repo as string)
    if (groupKey) {
      // Alerts on one host are serialized: two at once must see each other's incident, never open two.
      await s.intake.lock(`group:${groupKey}`)
      const incident = await s.intake.latestIncident(groupKey)
      if (incident && now.getTime() - incident.lastAlertAt.getTime() <= settings.incidentWindowMs) {
        const issue = await loadIssue(s.work, incident.issueId)
        if (isOpen(issue)) return join(s, r, alert, issue, groupKey)
      }
    }

    const rule = ctx.settle === undefined ? ctx.info.heal.find((h) => h.when === `${signal.source}.down`) : undefined
    if (rule) {
      if (!(await s.intake.pendingOf(signal.source, alert.subject))) {
        await s.intake.insertPending({
          source: signal.source,
          subject: alert.subject,
          repo: signal.repo as string,
          received: r,
          rule,
          openedAt: now,
          dueAt: new Date(now.getTime() + rule.graceMs),
          attempts: 0,
          results: [],
        })
      }
      return ok(
        triaged(
          'held',
          'settling',
          null,
          null,
          `waiting ${Math.round(rule.graceMs / 1000)} s for ${signal.source} to come back`,
        ),
      )
    }

    const withSettle: Received =
      ctx.settle === undefined ? r : { ...r, alert: { ...alert, facts: { details: alert.facts, settle: ctx.settle } } }
    return fileNew(s, withSettle, keyOf('filed', 'signal', signal.source, alert.subject, alert.event), { groupKey })
  }

  async function upIn(s: Stores, r: Received, alert: Alert): Out<Triaged> {
    const now = clock.now()
    const { signal } = r
    const evKey = eventKeyOf(r) as Key
    const prior = await s.intake.signalByKey(evKey)
    if (prior) return ok(replayedOf(prior))
    if (await s.intake.seen(evKey)) return ok(dropped('replayed', 'this event already settled'))

    const latest = await s.intake.latestSubject(signal.source, alert.subject)
    const issue = latest ? await loadIssue(s.work, latest.issueId) : null
    if (latest && isOpen(issue)) {
      // The same lock as a join: an up that checks "every alert is up" must not miss an alert joining at that moment.
      if (latest.groupKey) await s.intake.lock(`group:${latest.groupKey}`)
      await s.intake.touchSubject(latest.id, { at: now, upAt: now })
      const all = await s.intake.subjectsOfIssue(issue.id)
      const everyUp = all.every((subject) => subject.id === latest.id || subject.upAt !== null)
      if (everyUp && (issue.state === 'settling' || issue.state === 'queued')) {
        // No lead has started: nothing is left to do, and the machine closes it as healed.
        const healed = await recordIn(s.work, deps, {
          issueId: issue.id,
          key: keyOf('closed', 'signal', issue.id, 'healed'),
          event: {
            kind: 'closed',
            payload: { attempt: null, outcome: 'healed', reason: `${signal.source} is up again: ${signal.title}` },
            actor: 'factory',
          },
        })
        if (!healed.ok) return healed
        if (healed.value.result === 'applied') {
          const stored = await store(s, r, evKey, 'amended', issue.id)
          return ok(triaged('amended', 'healed', issue.id, stored))
        }
      }
      const noted = await note(
        s,
        issue.id,
        keyOf('noted', 'signal', signal.source, alert.subject, alert.event),
        r,
        'up again',
      )
      if (!noted.ok) return noted
      const stored = await store(s, r, evKey, 'amended', issue.id)
      return ok(triaged('amended', 'matched', issue.id, stored))
    }

    const pending = await s.intake.deletePending(signal.source, alert.subject)
    if (pending) {
      // The `down` that was waiting is settled too: its late retry opens no second row.
      const waiting = eventKeyOf(pending.received)
      await s.intake.remember([evKey, ...(waiting ? [waiting] : [])], now)
      return ok(dropped('healed', 'it came back up while settling; nothing filed'))
    }
    return ok(dropped('quiet', 'it is up and nothing of it is open'))
  }

  // ---- stateless: a GitHub issue, a person's request ----

  /** A signal whose fingerprint an Issue still carries: not closed, or filed in the window. */
  async function repeatIn(
    s: Stores,
    r: Received,
    noteKey: (issue: IssueId) => Key,
    stateKey: Key | null,
  ): Promise<Result<Triaged, IntakeError> | null> {
    const now = clock.now()
    const match = await s.intake.latestByFingerprint(r.signal.source, r.signal.fingerprint)
    if (!match) return null
    const issue = await loadIssue(s.work, match.issueId)
    const recent = now.getTime() - match.filedAt.getTime() < settings.fingerprintWindowMs
    if (!issue || (!isOpen(issue) && !recent)) return null
    await s.intake.touchSubject(match.id, { at: now, upAt: match.upAt, repeat: true })
    if (!isOpen(issue)) return ok(dropped('repeat', `it repeats ${match.issueId}, closed within the window`))
    const noted = await note(s, issue.id, noteKey(issue.id), r, 'repeated')
    if (!noted.ok) return noted
    const stored = await store(s, r, stateKey, 'amended', issue.id)
    return ok(triaged('amended', 'repeat', issue.id, stored))
  }

  async function eventIn(s: Stores, r: Received, alert: Alert): Out<Triaged> {
    const { signal } = r
    const evKey = eventKeyOf(r) as Key
    const prior = await s.intake.signalByKey(evKey)
    if (prior) return ok(replayedOf(prior))
    // One GitHub issue is one subject however often it is labelled: seen once, it is not filed again.
    if (await s.intake.latestSubject(signal.source, alert.subject))
      return ok(dropped('replayed', 'this subject was filed before'))
    const repeat = await repeatIn(s, r, (issue) => keyOf('noted', 'signal', signal.source, alert.subject, issue), evKey)
    if (repeat) return repeat
    const facts = alert.facts as { writeback?: unknown; admitted?: unknown } | null
    const filed = await fileNew(s, r, keyOf('filed', 'signal', signal.source, alert.subject), {
      groupKey: null,
      writeback: facts?.writeback === true,
      admitted: typeof facts?.admitted === 'string' ? facts.admitted : null,
    })
    if (filed.ok && filed.value.outcome === 'filed' && filed.value.detail === 'new') {
      // A held copy of the same subject became work by another road (its label): it is promoted.
      const held = await s.intake.signalByKey(keyOf('held', signal.source, alert.subject))
      if (held?.state === 'held') await s.intake.setSignal(held.id, { state: 'promoted', issueId: filed.value.issue })
    }
    return filed
  }

  async function humanIn(s: Stores, r: Received, decision: { amend: IssueId | null }): Out<Triaged> {
    const { signal } = r
    // The same words twice are one note (a replay); the same title with other text is a new one the lead must hear.
    const said = new Bun.CryptoHasher('sha256').update(signal.text).digest('hex').slice(0, 12)
    const repeat = await repeatIn(
      s,
      r,
      (issue) => keyOf('noted', 'signal', signal.source, signal.fingerprint, issue, said),
      null,
    )
    if (repeat) return repeat
    if (decision.amend) {
      const issue = await loadIssue(s.work, decision.amend)
      if (isOpen(issue)) {
        const noted = await note(
          s,
          issue.id,
          keyOf('noted', 'signal', signal.source, signal.fingerprint, issue.id, said),
          r,
        )
        if (!noted.ok) return noted
        const stored = await store(s, r, null, 'amended', issue.id)
        return ok(triaged('amended', 'matched', issue.id, stored))
      }
    }
    const id = ids.next('signal')
    const filedOut = await fileNew(s, r, keyOf('filed', 'signal', id), { groupKey: null, stateKey: null })
    if (!filedOut.ok || filedOut.value.outcome !== 'filed') return filedOut
    // A person's request has no subject row to match its fingerprint by next time: one is kept for it.
    const now = clock.now()
    if (!r.alert && filedOut.value.issue) {
      await s.intake.insertSubject({
        source: signal.source,
        subject: signal.fingerprint,
        fingerprint: signal.fingerprint,
        issueId: filedOut.value.issue,
        groupKey: null,
        filedAt: now,
        lastSeen: now,
        repeats: 0,
        upAt: null,
        writeback: false,
        admitted: null,
      })
    }
    return filedOut
  }

  // ---- quarantine ----

  /** A lead's own test signal: stored dismissed, never held, never work. A replay finds the stored one. */
  async function probeIn(s: Stores, r: Received): Out<Triaged> {
    const key = keyOf('probe', r.signal.source, r.signal.fingerprint)
    const existing = await s.intake.signalByKey(key)
    const id =
      existing?.id ??
      (await store(s, r, key, 'dismissed', null, { reason: PROBE_REASON, by: 'probe', at: clock.now() }))
    return ok(triaged('dropped', 'probe', null, id, 'marked as a probe: stored dismissed, never shown to the owner'))
  }

  async function hold(s: Stores, r: Received, again?: IssueId): Out<Triaged> {
    const base = r.alert
      ? ['held', r.signal.source, r.alert.subject]
      : again
        ? ['held', r.signal.source, r.signal.fingerprint, again]
        : ['held', r.signal.source, r.signal.fingerprint]
    // A dismissed report is answered; the next one with the same words is a new report, under the key after it.
    let heldKey = keyOf(...base)
    let existing = await s.intake.signalByKey(heldKey)
    while (existing?.state === 'dismissed') {
      heldKey = keyOf(...base, 'after', existing.id)
      existing = await s.intake.signalByKey(heldKey)
    }
    if (existing) return ok({ ...replayedOf(existing), outcome: 'held' })
    const id = await store(s, r, heldKey, 'held', null)
    return ok(triaged('held', 'quarantined', null, id, 'outside text waits for the owner or the Judge'))
  }

  /**
   * Outside text: held until promoted. The one exception is a complaint already promoted to an Issue that is still open,
   * which amends it (the note is fenced data); one whose Issue is closed is held again as new, under a key of that Issue
   * so a replay finds it. A duplicate of a still-held signal is the held one (a replay, no second row).
   */
  async function outsideIn(s: Stores, r: Received): Out<Triaged> {
    const { signal } = r
    if (r.alert) return hold(s, r)
    await s.intake.lock(`outside:${signal.source}:${signal.fingerprint}`)
    const match = await s.intake.latestByFingerprint(signal.source, signal.fingerprint)
    if (!match) return hold(s, r)
    const issue = await loadIssue(s.work, match.issueId)
    if (!isOpen(issue)) return hold(s, r, match.issueId)
    const said = new Bun.CryptoHasher('sha256').update(signal.text).digest('hex').slice(0, 12)
    const amendKey = keyOf('amended', 'signal', signal.source, signal.fingerprint, issue.id, said)
    const prior = await s.intake.signalByKey(amendKey)
    if (prior) return ok(replayedOf(prior))
    const noted = await note(
      s,
      issue.id,
      keyOf('noted', 'signal', signal.source, signal.fingerprint, issue.id, said),
      r,
      'repeated',
    )
    if (!noted.ok) return noted
    await s.intake.touchSubject(match.id, { at: clock.now(), upAt: match.upAt, repeat: true })
    const stored = await store(s, r, amendKey, 'amended', issue.id)
    return ok(triaged('amended', 'matched', issue.id, stored))
  }

  // ---- receive ----

  async function receive(r: Received): Out<Triaged> {
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
    if (!verdict.pass) return ok(dropped(verdict.detail, verdict.reason))
    if (signal.probe) return uow.run(async (s) => probeIn(s, r))
    const info = found.value as RepoSignals

    if (alert?.status === 'down' || alert?.status === 'up') {
      const topology = await deps.topology.load()
      if (!topology.ok) return topology
      const name = `subject:${signal.source}:${alert.subject}`
      return uow.run(async (s) => {
        await s.intake.lock(name)
        return alert.status === 'down' ? downIn(s, r, alert, { info, topology: topology.value }) : upIn(s, r, alert)
      })
    }
    if (alert) {
      return uow.run(async (s) => {
        await s.intake.lock(`subject:${signal.source}:${alert.subject}`)
        return eventIn(s, r, alert)
      })
    }

    // A person's or an agent's signal: amend an open Issue when the title says so, ask the workflow when it is unsure.
    const open = signal.repo ? await deps.openIssues.inRepo(signal.repo) : ok<OpenIssue[]>([])
    if (!open.ok) return open
    const match = matchOpen(signal.title, open.value)
    let decision: { amend: IssueId | null } = { amend: match.kind === 'match' ? match.issue.id : null }
    if (match.kind === 'unsure') {
      const asked = await deps.triage.amendOrNew({ signal, candidates: match.candidates })
      // An unanswered workflow files anew: a duplicate costs a note, a lost request costs the work.
      if (asked.ok) decision = asked.value
    }
    return uow.run(async (s) => {
      await s.intake.lock(`human:${signal.source}:${signal.fingerprint}`)
      return humanIn(s, r, decision)
    })
  }

  // ---- the owner's and agents' entry, and the door's ----

  async function file(body: SignalRequest, caller: RequestCaller): Out<Triaged> {
    const signal = envelopeOfRequest(body, caller)
    if (!signal.ok) return signal
    return receive({ signal: signal.value, alert: null })
  }

  async function promote(id: string, body: PromoteRequest, by: 'owner' | 'judge' = 'owner'): Out<Triaged> {
    const probe = await uow.run(async (s) => ok(await s.intake.signal(id)))
    if (!probe.ok) return probe
    const row = probe.value
    if (!row) return refuse('not_found', `no signal ${id}`)
    const repo = body.repo ?? row.received.signal.repo
    if (!repo) return refuse('no_repo', 'this signal names no repo: promote it with one')
    const found = await deps.projects.find(repo)
    if (!found.ok) return found
    if (!found.value) return refuse('unknown_project', `${repo} is not a project the factory knows`)
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
      await s.intake.setSignal(id, { state: 'promoted', issueId: issue, repo })
      // A promoted signal is found by its fingerprint next time (an alert by its subject too): a duplicate amends the Issue.
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
        // A stranger's issue is answered with a comment, never closed on GitHub.
        writeback: r.alert !== null && r.signal.source === 'github',
        admitted: r.alert !== null && r.signal.source === 'github' ? 'label' : null,
      })
      return ok(triaged('filed', 'promoted', issue, id))
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

  /** The door's alert: the route says which repo, the payload never does. */
  async function alert(raw: AlertRequest): Out<Triaged> {
    // Someone else's text, as the factory keeps it: control characters out, what Postgres cannot store replaced.
    const input: AlertRequest = {
      ...raw,
      monitor: cleanText(raw.monitor) || raw.source,
      event: cleanText(raw.event) || 'event',
      title: cleanText(raw.title).slice(0, MAX_TITLE_CHARS) || raw.source,
      facts: storable(raw.facts),
    }
    const routed = await uow.run(async (s) => {
      const route = await s.intake.routeFor(input.source, input.monitor)
      if (!route) {
        await s.intake.noteUnrouted({
          source: input.source,
          monitor: input.monitor,
          title: input.title,
          event: input.event,
          status: input.status,
          group: isGroupAlert(input),
          now: clock.now(),
        })
      }
      return ok(route)
    })
    if (!routed.ok) return routed
    if (!routed.value) return ok(dropped('unrouted', `no route for ${input.source} ${input.monitor}: counted`))
    const link = (input.facts as { link?: unknown } | null)?.link
    const received: Received = {
      signal: {
        source: input.source,
        kind: 'alert',
        origin: originOf(input.source),
        trust: 'machine',
        repo: routed.value.repo,
        fingerprint: `${input.source}:${input.monitor}`,
        title: input.title,
        text: factsText(input.facts),
        link: typeof link === 'string' ? link : null,
        madeBy: null,
        probe: false,
      },
      alert: { subject: input.monitor, event: input.event, status: input.status, facts: input.facts },
    }
    const out = await receive(received)
    if (!out.ok) return out
    // Bookkeeping for the health lines: the alert is dealt with, so a failure here is never the sender's.
    await uow.run(async (s) => {
      if (out.value.outcome === 'dropped' && out.value.detail === 'quiet') {
        const counted = await s.intake.countQuiet(input.source, input.monitor, input.event, clock.now())
        if (!counted) out.value.detail = 'replayed'
      }
      await s.intake.doorAccepted(input.source, clock.now())
      return ok(null)
    })
    return out
  }

  /**
   * The door's feedback from an app: the envelope's version and route head the text as data, the door route
   * (`feedback`, `<app>`) says which repo or none, and the payload never does. The fingerprint is the repo (or app) and the
   * title only: the same complaint from two builds or screens is one.
   */
  async function feedback(raw: FeedbackRequest): Out<Triaged> {
    const title = cleanText(raw.title).slice(0, MAX_TITLE_CHARS) || raw.app
    const routed = await uow.run(async (s) => ok(await s.intake.routeFor(FEEDBACK_ROUTE_SOURCE, raw.app)))
    if (!routed.ok) return routed
    const repo = routed.value?.repo ?? null
    const head = [`app: ${raw.app}`, `version: ${raw.version}`, `route: ${raw.route}`].map((line) =>
      cleanText(line).slice(0, 300),
    )
    const text = [head.join('\n'), cleanText(raw.text)].filter(Boolean).join('\n\n')
    const out = await receive({
      signal: {
        source: feedbackSource(raw.app),
        kind: 'feedback',
        origin: 'feedback',
        trust: 'outside',
        repo,
        fingerprint: fingerprintOf(repo ?? raw.app, title),
        title,
        text,
        link: raw.link ? cleanText(raw.link) : null,
        madeBy: null,
        probe: raw.probe,
      },
      alert: null,
    })
    if (!out.ok) return out
    await uow.run(async (s) => {
      await s.intake.doorAccepted(feedbackTokenKey(raw.app), clock.now())
      return ok(null)
    })
    return out
  }

  function doorReport(report: DoorReport): Out<null> {
    return uow.run(async (s) => {
      const now = clock.now()
      if (report.kind === 'start') await s.intake.doorStarted(report.sources, now)
      else if (report.kind === 'refused') await s.intake.doorRefused(report.source, now)
      else await s.intake.doorAccepted(report.source, now)
      return ok(null)
    })
  }

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
    if (!input.issue) return refuse('trust_refused', 'a lead names its Issue with --issue to route a monitor')
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
    return uow.run(async (s) => {
      const setBy = await setterOf(s, input, caller)
      if (!setBy.ok) return setBy
      return ok(await s.intake.setRoute(input.source, input.monitor, input.repo, setBy.value))
    })
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

  // ---- settle and heal, before any lead ----

  async function settleOne(source: string, subject: string, topology: Topology): Promise<Result<void, IntakeError>> {
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
        settle: { graceMs: row.rule.graceMs, attempts: row.attempts, results },
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

  /** Home for an unrouted monitor's down: the repo of a route of the same source for `<name> - Push|Door`, else the home repo. */
  async function placeFor(source: string, monitor: string): Promise<{ repo: string; mapped: boolean } | null> {
    const base = monitor.replace(SUFFIX, '')
    if (base !== monitor && base) {
      const known = await uow.run(async (s) => ok(await s.intake.routes()))
      const hit = known.ok
        ? known.value.find(
            (route) => route.source === source && route.monitor.toLowerCase().startsWith(`${base.toLowerCase()} - `),
          )
        : undefined
      if (hit) return { repo: hit.repo, mapped: true }
    }
    return settings.homeRepo ? { repo: settings.homeRepo, mapped: false } : null
  }

  const HOME_TITLE = 'No door route for a monitor that is down, pick its repo: '
  const HOME_ASK =
    'No door route exists for this monitor, so its alerts reach no repo. Decide which repo it belongs to and add the route with `factory door route-set`; fix the monitor if it is down for a reason of its own.'

  async function fileUnrouted(topology: Topology): Promise<Result<void, IntakeError>> {
    const due = await uow.run(async (s) =>
      ok(await s.intake.dueUnrouted(clock.now(), settings.unroutedGraceMs, UNROUTED_BATCH)),
    )
    if (!due.ok) return due
    for (const row of due.value) {
      const place = await placeFor(row.source, row.monitor)
      if (!place) continue
      const received: Received = {
        signal: {
          source: row.source,
          kind: 'alert',
          origin: originOf(row.source),
          trust: 'machine',
          repo: place.repo,
          fingerprint: `${row.source}:${row.monitor}`,
          title: place.mapped ? row.lastTitle : `${HOME_TITLE}${row.lastTitle}`,
          text: place.mapped ? '' : HOME_ASK,
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
      }
      const found = await deps.projects.find(place.repo)
      if (!found.ok || !found.value || found.value.work) continue
      const info = found.value
      const out = await uow.run(async (s) => {
        await s.intake.lock(`subject:${row.source}:${row.monitor}`)
        const filed = await downIn(s, received, received.alert as Alert, { info, topology })
        if (filed.ok && filed.value.issue)
          await s.intake.markUnroutedFiled(row.source, row.monitor, row.lastEvent, filed.value.issue, clock.now())
        return filed
      })
      if (!out.ok) return out
    }
    return ok(undefined)
  }

  /** The settle pass: due `down`s run their runbook or file; an unrouted monitor that stayed down is filed once. */
  async function settle(): Promise<Result<void, IntakeError>> {
    const topology = await deps.topology.load()
    if (!topology.ok) return topology
    const due = await uow.run(async (s) => ok(await s.intake.duePending(clock.now(), SETTLE_BATCH)))
    if (!due.ok) return due
    for (const { source, subject } of due.value) {
      const settled = await settleOne(source, subject, topology.value)
      if (!settled.ok) return settled
    }
    return fileUnrouted(topology.value)
  }

  // ---- what the pollers ask ----

  const sink: IntakeSink = {
    receive: async (r) => {
      const out = await receive(r)
      return out.ok ? out : err(failureOf(out.error))
    },

    subjects: async (source, prefix) => {
      const out = await uow.run(async (s) => {
        const states = new Map<string, SubjectState>()
        for (const subject of await s.intake.latestSubjects(source, prefix)) {
          states.set(subject.subject, {
            subject: subject.subject,
            open: isOpen(await loadIssue(s.work, subject.issueId)),
            since: subject.filedAt,
          })
        }
        for (const subject of await s.intake.pendingSubjects(source, prefix)) {
          states.set(subject.subject, { subject: subject.subject, open: true, since: subject.openedAt })
        }
        return ok([...states.values()])
      })
      return out.ok ? out : err(failureOf(out.error))
    },

    pendingWritebacks: async (limit) => {
      const out = await uow.run(async (s) => {
        const pending: Writeback[] = []
        for (const row of await s.intake.unwrittenBack(limit * 10)) {
          const history = await s.work.history(row.issueId)
          if (!history) continue
          const issue = replay(row.issueId, history)
          if (issue.state !== 'closed' || !issue.outcome) continue
          const closing = [...history].reverse().find((record) => record.kind === 'closed')
          const reason = (closing?.payload as { reason?: unknown } | undefined)?.reason
          pending.push({
            issueId: row.issueId,
            subject: row.subject,
            outcome: issue.outcome,
            admitted: row.admitted,
            summary: typeof reason === 'string' ? (reason.split('\n')[0] ?? null) : null,
          })
          if (pending.length >= limit) break
        }
        return ok(pending)
      })
      return out.ok ? out : err(failureOf(out.error))
    },

    wroteBack: async (issueId, result) => {
      const out = await uow.run(async (s) => {
        await s.intake.recordWriteback(issueId, result, clock.now())
        return ok(undefined)
      })
      return out.ok ? out : err(failureOf(out.error))
    },
  }

  return {
    receive,
    file,
    alert,
    feedback,
    promote,
    dismiss,
    list,
    doorReport,
    routes,
    setRoute,
    removeRoute,
    settle,
    healthLines,
    sink,
  }
}

export type Intake = ReturnType<typeof createIntake>

/** A write error as the port error a poller logs. */
function failureOf(error: IntakeError): PortError {
  if (error.kind === 'timeout' || error.kind === 'gone' || error.kind === 'refused' || error.kind === 'unreadable') {
    return error
  }
  return portError('refused', `${error.kind}: ${'detail' in error ? error.detail : JSON.stringify(error)}`)
}

/** An Issue id read from a request. */
export const issueIdOf = (text: string): IssueId | null => idOf('issue', text)

export type { HealRule }
