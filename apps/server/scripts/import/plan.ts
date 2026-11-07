/**
 * The old core's Issue, as the new machine would have lived it. Pure: the old rows go in, the new core's events (each
 * decided by the machine itself, at the time the old event happened), the derived Issue and the facts that belong in
 * other tables come out. No SQL, no clock, no randomness: the same rows give the same plan, so a second run changes
 * nothing.
 *
 * The mapping is the importer's one table of decisions. Every old event kind is mapped to new events, folded into
 * another table, or dropped with a reason; `dispositions` records which, per old event, and the import stores them.
 */
import { isInert } from '../../src/domains/quality/evidence.ts'
import type { AnyIssueEvent } from '../../src/domains/work/events.ts'
import { KINDS, type Issue, ORIGINS, type Kind, type Origin, WAITS } from '../../src/domains/work/issue.ts'
import { apply, type Decided, file } from '../../src/domains/work/machine.ts'
import type { Actor } from '../../src/kernel/events.ts'
import { type IssueId, issueId } from '../../src/kernel/ids.ts'
import { key } from '../../src/kernel/keys.ts'

export interface LegacyIssue {
  id: number
  state: string
  reason: string | null
  source: string
  sourceKey: string
  repo: string
  title: string
  facts: unknown
  kind: string | null
  outcome: string | null
  attempt: number
  createdAt: Date
  closedAt: Date | null
}

export interface LegacyEvent {
  id: number
  kind: string
  from: string | null
  to: string | null
  at: Date
  payload: Record<string, unknown> | null
}

export interface LegacyDecision {
  id: number
  question: string
  options: unknown
  defaultOption: string | null
  expiresAt: Date | null
  answer: string | null
  answeredBy: string | null
  answeredAt: Date | null
  createdAt: Date
}

/** One event the machine was given, and what it decided. */
export interface Entry {
  key: string
  /** the old event it stands for; 0 for the Issue's first events, which stand for the old row */
  legacyEvent: number
  at: Date
  actor: Actor
  event: { kind: string; payload: unknown; actor: Actor }
  decided: Decided
  /** the state the machine found; null for `filed` */
  from: Issue['state'] | null
}

type FiledPayload = { repo: string; title: string; kind: Kind; origin: Origin }

export interface Disposition {
  legacyEvent: number
  kind: string
  disposition: 'mapped' | 'dropped' | 'folded'
  reason: string | null
  keys: string[]
}

export interface DecisionRow {
  id: string
  key: string
  attempt: number
  question: string
  recommendation: string
  checked: string
  options: { label: string; reversible: boolean; cost: string }[]
  noAnswer: { consequence: string; default: string | null; waitMinutes: number | null }
  askedAt: Date
  answer: string | null
  settledBy: 'policy' | 'judge' | 'default' | 'owner' | null
  source: string | null
  answeredAt: Date | null
  /** the machine did not take the old answer, or a note ended the wait: the Decision is on no list of open work */
  withdrawnAt: Date | null
  withdrawnReason: string | null
}

export interface DecisionStep {
  decisionId: string
  step: 'judge' | 'default'
  outcome: 'answered' | 'passed'
  detail: string
  at: Date
}

export interface ShipRow {
  id: string
  attempt: number
  eventKey: string
  at: Date
  result: 'accepted' | 'refused'
  detail: string | null
  reported: string[]
}

export interface EvidenceRow {
  id: string
  attempt: number
  sourceKey: string
  kind: 'commits' | 'review'
  at: Date
  payload: Record<string, unknown>
}

export interface WatchRow {
  key: string
  attempt: number
  watch: number
  startedAt: Date
  windowMs: number
  answer: 'passed' | 'regressed' | 'ended' | null
  answeredAt: Date | null
}

export interface CheckRow {
  watchKey: string
  n: number
  at: Date
  outcome: 'green' | 'red'
  checks: { name: string; ok: boolean; detail: string }[]
}

export interface PrioRow {
  key: string
  value: number
  actor: string
  at: Date
}

export interface FinalizationRow {
  attempt: number
  at: Date
  worktreeKept: string | null
  worktreePath: string | null
}

export interface Plan {
  issue: Issue
  entries: Entry[]
  dispositions: Disposition[]
  decisions: DecisionRow[]
  decisionSteps: DecisionStep[]
  ships: ShipRow[]
  evidence: EvidenceRow[]
  watches: WatchRow[]
  checks: CheckRow[]
  prios: PrioRow[]
  writeback: { result: string; at: Date } | null
  finalizations: FinalizationRow[]
  /** what the plan did that is not a plain mapping: a reconciliation, a forced close, a divergence */
  notes: string[]
}

const NOT_RECORDED = 'not recorded: imported from the old core, which had no such field'

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
const whole = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const clip = (value: string, max = 2000): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value)

/** The new origin of an old Issue, from its source (and, for an alert, which system raised it). */
export function originOf(source: string, sourceKey: string): Origin {
  if (source === 'request') return 'you'
  if (source === 'github') return 'github'
  if (source === 'plan' || source === 'upkeep') return 'factory'
  if (source === 'alert') return sourceKey.startsWith('hyperdx:') ? 'application' : 'infrastructure'
  return source === 'beszel' ? 'infrastructure' : ORIGINS.includes(source as Origin) ? (source as Origin) : 'you'
}

const kindOf = (kind: string | null): Kind => (KINDS.includes(kind as Kind) ? (kind as Kind) : 'chore')

/** The repo as the new core names it: the directory under its source root. */
export const repoName = (path: string): string => path.replace(/\/+$/, '').split('/').at(-1) ?? path

/** Who an old note or answer came from, as one of the new actors. */
function actorOf(who: unknown, allowed: readonly Actor[]): Actor {
  const named = text(who)
  if (named === 'steward' && allowed.includes('steward')) return 'steward'
  if (named === 'owner' && allowed.includes('owner')) return 'owner'
  if ((named === 'judge' || named === 'steward') && allowed.includes('judge')) return 'judge'
  return allowed.includes('factory') ? 'factory' : (allowed[0] ?? 'factory')
}

const settledBy = (who: string | null): DecisionRow['settledBy'] =>
  who === 'owner' ? 'owner' : who === 'default' ? 'default' : who === 'policy' ? 'policy' : 'judge'

/** The old Issue's request text and facts as one note for the lead that takes it next. */
function requestText(issue: LegacyIssue): string {
  const facts = record(issue.facts)
  const lines = [`Imported from the old core (Issue ${issue.id}, source ${issue.source}).`, issue.title]
  for (const [name, value] of Object.entries(facts)) {
    if (value === null || value === undefined) continue
    const rendered = typeof value === 'string' ? value : JSON.stringify(value)
    lines.push(`${name}: ${clip(rendered, 1500)}`)
  }
  return clip(lines.join('\n\n'), 12000)
}

class Planner {
  issue: Issue | null = null
  readonly entries: Entry[] = []
  readonly dispositions: Disposition[] = []
  readonly decisions: DecisionRow[] = []
  readonly decisionSteps: DecisionStep[] = []
  readonly ships: ShipRow[] = []
  readonly evidence: EvidenceRow[] = []
  readonly watches: WatchRow[] = []
  readonly checks: CheckRow[] = []
  readonly prios: PrioRow[] = []
  writeback: Plan['writeback'] = null
  readonly finalizations: FinalizationRow[] = []
  readonly notes: string[] = []
  private index = 0
  private sent: string[] = []
  private lastDecision: DecisionRow | null = null

  constructor(
    readonly row: LegacyIssue,
    private readonly decisionRows: LegacyDecision[],
  ) {}

  get id(): IssueId {
    return issueId(this.row.id)
  }

  get now(): Issue {
    if (!this.issue) throw new Error(`issue ${this.row.id}: used before it was filed`)
    return this.issue
  }

  /** Gives the machine one event; the answer is kept whether it applied or not. */
  send(legacyEvent: number, at: Date, actor: Actor, event: AnyIssueEvent, name?: string): Decided {
    const entryKey = name
      ? key('import', this.row.id, name)
      : key('import', this.row.id, 'e', legacyEvent, this.index++)
    const before = this.now
    const decided = apply(before, { ...event, actor }, { now: at })
    this.entries.push({
      key: entryKey,
      legacyEvent,
      at,
      actor,
      event: { ...event, actor },
      decided,
      from: before.state,
    })
    this.sent.push(entryKey)
    if (decided.result === 'applied') this.issue = decided.issue
    return decided
  }

  /** The keys sent since the last call, and the machine's complaints about them. */
  take(): { keys: string[]; complaints: string[] } {
    const keys = this.sent
    this.sent = []
    this.index = 0
    const complaints: string[] = []
    for (const k of keys) {
      const entry = this.entries.find((e) => e.key === k)
      if (entry && entry.decided.result !== 'applied') {
        complaints.push(`${entry.event.kind} ${entry.decided.result}: ${entry.decided.detail}`)
      }
    }
    return { keys, complaints }
  }

  file(at: Date): void {
    const payload: FiledPayload = {
      repo: repoName(this.row.repo),
      title: this.row.title,
      kind: kindOf(this.row.kind),
      origin: originOf(this.row.source, this.row.sourceKey),
    }
    const decided = file(this.id, { kind: 'filed', payload, actor: 'factory' })
    if (decided.result !== 'applied') throw new Error(`issue ${this.row.id}: filed was ${decided.result}`)
    this.issue = decided.issue
    const entryKey = key('import', this.row.id, 'filed')
    this.entries.push({
      key: entryKey,
      legacyEvent: 0,
      at,
      actor: 'factory',
      event: { kind: 'filed', payload, actor: 'factory' },
      decided,
      from: null,
    })
    this.sent.push(entryKey)
    this.send(
      0,
      at,
      'factory',
      { kind: 'noted', payload: { text: requestText(this.row) }, actor: 'factory' },
      'request',
    )
    this.send(0, at, 'factory', { kind: 'settled', payload: {}, actor: 'factory' }, 'settled')
  }

  disposition(event: LegacyEvent, disposition: Disposition['disposition'], reason: string | null): void {
    const { keys, complaints } = this.take()
    const said = complaints.length > 0 ? `machine: ${complaints.join('; ')}` : null
    this.dispositions.push({
      legacyEvent: event.id,
      kind: event.kind,
      disposition,
      reason: [reason, said].filter(Boolean).join(' | ') || null,
      keys,
    })
  }

  /** The old core's state after an event, brought about in the new machine by the event a person or the factory would have sent. */
  reconcile(event: LegacyEvent): void {
    const target = event.to
    if (!target) return
    for (let round = 0; round < 2; round++) {
      const state = this.now.state
      if (state === target) return
      // the old core's claim wait (after an answer, a wake or a timer) is capacity's now: the Issue is working
      if (target === 'waiting' && state === 'working' && ['answer', 'wake', 'phase', 'note'].includes(event.kind))
        return
      const wait = this.now.wait
      if (state === 'waiting' && wait && (target === 'working' || target === 'queued')) {
        if (WAITS[wait.reason].exit === 'machine') {
          this.send(event.id, event.at, 'factory', {
            kind: 'woken',
            payload: { since: wait.since, detail: `imported: the old core moved the Issue to ${target}` },
            actor: 'factory',
          })
          continue
        }
        if (wait.reason === 'decision') {
          this.send(event.id, event.at, 'owner', {
            kind: 'answered',
            payload: { decision: wait.holds.id, answer: 'imported: the old core ended this wait without an answer' },
            actor: 'owner',
          })
          const row = this.decisions.find((d) => d.id === wait.holds.id)
          if (row?.answeredAt === null) {
            row.withdrawnAt = event.at
            row.withdrawnReason = 'imported: the old core let something else end this wait'
          }
          this.notes.push(
            `Issue ${this.row.id}: a decision wait was ended by ${event.kind}, which the new machine reads as an answer`,
          )
          continue
        }
      }
      return
    }
  }

  /** A wait that needs nobody ended: the factory wakes it. A person's wait is left to its answer. */
  wakeNow(event: LegacyEvent, detail: string): void {
    const wait = this.now.wait
    if (this.now.state !== 'waiting' || !wait || WAITS[wait.reason].exit !== 'machine') return
    this.send(event.id, event.at, 'factory', {
      kind: 'woken',
      payload: { since: wait.since, detail },
      actor: 'factory',
    })
  }

  ask(event: LegacyEvent): void {
    const payload = record(event.payload)
    const row = this.decisionRows.shift() ?? null
    const options = list(row?.options ?? payload.options)
      .map((option) => (typeof option === 'string' ? option : text(record(option).label)))
      .filter((label): label is string => label !== null)
    const defaultOption = row?.defaultOption ?? text(payload.default)
    const question = row?.question ?? text(payload.question) ?? 'not recorded'
    const id = `decision_legacy-${row?.id ?? `ask${event.id}`}`
    const minutes = row?.expiresAt
      ? Math.max(1, Math.round((row.expiresAt.getTime() - row.createdAt.getTime()) / 60_000))
      : null
    const taken = defaultOption !== null && options.includes(defaultOption)
    const decision: DecisionRow = {
      id,
      key: key('import', 'decision', row?.id ?? `ask${event.id}`),
      attempt: this.now.attempt >= 1 ? this.now.attempt : 1,
      question,
      recommendation: defaultOption ?? NOT_RECORDED,
      checked: NOT_RECORDED,
      options: options.map((label) => ({ label, reversible: true, cost: NOT_RECORDED })),
      noAnswer: {
        consequence: NOT_RECORDED,
        default: taken ? defaultOption : null,
        waitMinutes: taken ? (minutes ?? 60) : null,
      },
      askedAt: row?.createdAt ?? event.at,
      answer: row?.answer ?? null,
      settledBy: row?.answer ? settledBy(row.answeredBy) : null,
      source: row?.answer ? 'imported from the old core' : null,
      answeredAt: row?.answer ? (row.answeredAt ?? event.at) : null,
      withdrawnAt: null,
      withdrawnReason: null,
    }
    this.decisions.push(decision)
    this.lastDecision = decision
    this.send(event.id, event.at, 'lead', {
      kind: 'asked',
      payload: { attempt: this.now.attempt, decision: { id, summary: clip(question, 200) } },
      actor: 'lead',
    })
  }

  watchKey(watch: number): string {
    return key('start_watch', this.id, watch)
  }

  ship(event: LegacyEvent): void {
    const payload = record(event.payload)
    const derived = record(payload.derived)
    const attempt = this.now.attempt
    const decided = this.send(event.id, event.at, 'lead', { kind: 'shipped', payload: { attempt }, actor: 'lead' })
    if (decided.result !== 'applied') return
    const shipped = this.entries.at(-1)?.key ?? key('import', this.row.id, 'e', event.id, 0)
    const commits = list(derived.commits ?? payload.commits).filter((c): c is string => typeof c === 'string')
    const paths = list(derived.paths).filter((p): p is string => typeof p === 'string')
    this.ships.push({
      id: `ship_import_${event.id}`,
      attempt,
      eventKey: shipped,
      at: event.at,
      result: 'accepted',
      detail: null,
      reported: commits,
    })
    this.evidence.push({
      id: `evidence_import_${event.id}_commits`,
      attempt,
      sourceKey: shipped,
      kind: 'commits',
      at: event.at,
      payload: {
        commits,
        landedAt: text(derived.landedAt),
        mergedAt: text(derived.mergedAt),
        deploys: paths.some((path) => !isInert(path)),
        paths: paths.slice(0, 100),
      },
    })
    const review = derived.review === null || derived.review === undefined ? null : record(derived.review)
    this.evidence.push({
      id: `evidence_import_${event.id}_review`,
      attempt,
      sourceKey: shipped,
      kind: 'review',
      at: event.at,
      payload: review
        ? {
            status: review.covered === true ? 'covered' : 'uncovered',
            tier: text(review.tier),
            ranges: list(review.ranges),
            uncovered: list(review.uncovered),
            reason: null,
          }
        : {
            status: 'unknown',
            tier: null,
            ranges: [],
            uncovered: [],
            reason: 'imported: the old core recorded no review',
          },
    })
    this.watches.push({
      key: this.watchKey(this.now.watch),
      attempt,
      watch: this.now.watch,
      startedAt: event.at,
      windowMs: Math.max(0, whole(derived.holdMs) ?? 0),
      answer: null,
      answeredAt: null,
    })
  }

  /** A verify run of the current watch: green, or red with what failed. */
  check(event: LegacyEvent, outcome: 'green' | 'red', answer: WatchRow['answer']): void {
    const watch = this.watches.find((w) => w.key === this.watchKey(this.now.watch))
    if (!watch) return
    const checks = list(record(event.payload).checks).map((item) => {
      const c = record(item)
      return { name: text(c.name) ?? 'check', ok: c.ok === true, detail: clip(text(c.detail) ?? '', 4000) }
    })
    const n = this.checks.filter((c) => c.watchKey === watch.key).length + 1
    this.checks.push({ watchKey: watch.key, n, at: event.at, outcome, checks })
    if (answer) {
      watch.answer = answer
      watch.answeredAt = event.at
    }
  }
}

/** The old events that never reach the Issue's machine, with why. */
const DROPPED: Record<string, string> = {
  classified:
    'its size, tier and kind live in the filed event and the project; triage in the new core decides them again',
  classify_failed: 'a failed call of the old classifier; triage in the new core keeps its own calls (loop_calls)',
  hold_over: 'the old watch hold timer; the new watch has its own window and checks',
  steward_verify: 'the old steward re-check line; the new steward records its calls in loop_calls',
  transcript_missing: 'a worry about an ended session; nothing in the new core reads it',
  retier: 'a lead tier is a role, not a fact of the Issue',
  lapsed: 'a question past its expiry; the new Decision pass takes the default or pages by itself',
  phase: 'a phase is derived from the state in the new core (the lead has no phase verb)',
}

/**
 * The plan for one old Issue: every old event in order, mapped, folded or dropped, and the machine's own verdict on
 * each mapped one. `decisions` are the old rows of this Issue in id order.
 */
export function planIssue(
  row: LegacyIssue,
  events: readonly LegacyEvent[],
  decisions: readonly LegacyDecision[],
): Plan {
  const p = new Planner(
    row,
    [...decisions].sort((a, b) => a.id - b.id),
  )
  const ordered = [...events].sort((a, b) => a.id - b.id)
  const created = ordered.find((e) => e.kind === 'created')
  p.file(created?.at ?? row.createdAt)
  const startup = p.take()

  for (const event of ordered) {
    const payload = record(event.payload)
    const at = event.at
    if (event.kind === 'created') {
      p.dispositions.push({
        legacyEvent: event.id,
        kind: event.kind,
        disposition: 'mapped',
        reason: 'filed, a note with the request text and facts, and settled',
        keys: startup.keys,
      })
      continue
    }
    switch (event.kind) {
      case 'admitted':
        p.send(event.id, at, 'factory', { kind: 'admitted', payload: {}, actor: 'factory' })
        p.reconcile(event)
        p.disposition(event, 'mapped', null)
        break
      case 'ask':
        p.ask(event)
        p.reconcile(event)
        p.disposition(event, 'mapped', 'a Decision row was written from the old decision')
        break
      case 'answer': {
        const old = whole(payload.decision)
        const answer = text(payload.answer) ?? 'imported: no answer text recorded'
        p.send(event.id, at, actorOf(payload.who, ['owner', 'judge', 'factory']), {
          kind: 'answered',
          payload: {
            decision:
              old === null
                ? p.now.wait && 'holds' in p.now.wait
                  ? p.now.wait.holds.id
                  : 'decision_unknown'
                : `decision_legacy-${old}`,
            answer,
          },
          actor: 'factory',
        })
        p.reconcile(event)
        p.disposition(event, 'mapped', null)
        break
      }
      case 'ask_judged': {
        const target = p.decisions.at(-1)
        if (target) {
          p.decisionSteps.push({
            decisionId: target.id,
            step: payload.source === 'default' ? 'default' : 'judge',
            outcome: payload.outcome === 'answered' ? 'answered' : 'passed',
            detail: clip(text(payload.reason) ?? 'imported from the old core', 2000),
            at,
          })
        }
        p.disposition(event, 'folded', target ? 'decision_steps' : 'no Decision to attach it to')
        break
      }
      case 'wait': {
        const until = text(payload.until)
        if (until === null) {
          p.disposition(event, 'dropped', 'a wait with no time cannot be a timed wait')
          break
        }
        p.send(event.id, at, 'lead', { kind: 'deferred', payload: { attempt: p.now.attempt, until }, actor: 'lead' })
        p.reconcile(event)
        p.disposition(event, 'mapped', null)
        break
      }
      case 'block':
        p.send(event.id, at, 'lead', {
          kind: 'stalled',
          payload: { attempt: p.now.attempt, cause: 'blocked', detail: clip(text(payload.reason) ?? 'blocked', 4000) },
          actor: 'lead',
        })
        p.reconcile(event)
        p.disposition(event, 'mapped', null)
        break
      case 'park':
        p.send(event.id, at, 'lead', {
          kind: 'stalled',
          payload: { attempt: p.now.attempt, cause: 'blocked', detail: 'parked in the old core' },
          actor: 'lead',
        })
        p.disposition(event, 'mapped', 'the old park is a blocked stall')
        break
      case 'unreported':
        p.send(event.id, at, 'factory', {
          kind: 'stalled',
          payload: {
            attempt: p.now.attempt,
            cause: 'unreported',
            detail: 'the lead stopped twice with nothing reported',
          },
          actor: 'factory',
        })
        p.disposition(event, 'mapped', null)
        break
      case 'limit_stop':
        p.send(event.id, at, 'factory', {
          kind: 'stalled',
          payload: { attempt: p.now.attempt, cause: 'wall', detail: 'the account hit its limit' },
          actor: 'factory',
        })
        p.disposition(event, 'mapped', null)
        break
      case 'lead_gone':
        p.send(event.id, at, 'factory', {
          kind: 'lead_gone',
          payload: { attempt: p.now.attempt, detail: text(payload.detail) ?? 'the lead is gone' },
          actor: 'factory',
        })
        p.disposition(event, 'mapped', null)
        break
      case 'restart':
        p.wakeNow(event, 'imported: the steward restarted the attempt')
        p.disposition(event, 'mapped', 'the steward restart is a wake of a lead_gone stall')
        break
      case 'note': {
        const actor = actorOf(payload.who, ['owner', 'steward', 'judge', 'factory'])
        const body = text(payload.text)
        if (body === null) {
          p.disposition(event, 'dropped', 'a note with no text')
          break
        }
        p.send(event.id, at, actor, { kind: 'noted', payload: { text: clip(body, 12000) }, actor })
        p.reconcile(event)
        p.disposition(event, 'mapped', null)
        break
      }
      case 'signal': {
        const facts = record(payload.facts)
        const body = text(facts.summary) ?? text(payload.event) ?? 'a signal arrived'
        p.send(event.id, at, 'factory', {
          kind: 'noted',
          payload: { text: clip(`signal: ${body}`, 2000) },
          actor: 'factory',
        })
        p.disposition(event, 'mapped', 'a signal on an Issue is a note from the factory')
        break
      }
      case 'wake':
        if (payload.for === 'claim') {
          p.disposition(event, 'dropped', "the claim hand-off after a wait is capacity's in the new core, not a state")
          break
        }
        p.wakeNow(event, 'imported: a timed wait ended')
        p.disposition(event, 'mapped', 'a timed wait ended: woken')
        break
      case 'turn_started':
        p.wakeNow(event, 'imported: the lead started a turn again')
        p.disposition(event, 'mapped', "the wall or unreported stall ended with the lead's next turn: woken")
        break
      case 'ship':
        p.ship(event)
        p.reconcile(event)
        p.disposition(event, 'mapped', 'ship, with its ship row, commits and review evidence, and the watch it opened')
        break
      case 'refused': {
        if (payload.event === 'ship') {
          const attempt = Math.max(1, p.now.attempt)
          p.ships.push({
            id: `ship_import_${event.id}`,
            attempt,
            eventKey: key('import', row.id, 'refused', event.id),
            at,
            result: 'refused',
            detail: clip(text(payload.detail) ?? 'the old gate refused the ship', 4000),
            reported: [],
          })
          p.disposition(event, 'folded', 'quality_ships (a refused ship is a fact friction counts)')
          break
        }
        p.disposition(event, 'dropped', 'a refusal of another verb; the new core records its own refusals')
        break
      }
      case 'verified':
        p.check(event, 'green', 'passed')
        p.send(event.id, at, 'factory', { kind: 'watch_passed', payload: { watch: p.now.watch }, actor: 'factory' })
        p.disposition(event, 'mapped', 'watch_passed, with the watch answered and its green check')
        break
      case 'verify_red':
        p.check(event, 'red', null)
        p.disposition(event, 'folded', 'quality_checks (a red run of the watch)')
        break
      case 'regression': {
        p.check(event, 'red', 'regressed')
        const title = text(payload.title) ?? 'regression'
        p.send(event.id, at, 'factory', {
          kind: 'regressed',
          payload: { watch: p.now.watch, detail: clip(title, 2000) },
          actor: 'factory',
        })
        p.reconcile(event)
        p.disposition(event, 'mapped', 'regressed, with the watch answered and its red check')
        break
      }
      case 'close':
        p.send(event.id, at, 'lead', {
          kind: 'closed',
          payload: {
            attempt: p.now.attempt,
            outcome: 'done',
            reason: clip(text(payload.summary) ?? 'closed by its lead', 4000),
          },
          actor: 'lead',
        })
        p.disposition(event, 'mapped', null)
        break
      case 'drop':
        p.send(event.id, at, 'lead', {
          kind: 'closed',
          payload: {
            attempt: p.now.attempt,
            outcome: 'dropped',
            reason: clip(text(payload.reason) ?? 'dropped by its lead', 4000),
          },
          actor: 'lead',
        })
        p.disposition(event, 'mapped', null)
        break
      case 'stop':
        p.send(event.id, at, 'owner', {
          kind: 'cancelled',
          payload: { reason: clip(text(payload.reason) ?? 'stopped', 4000) },
          actor: 'owner',
        })
        p.disposition(event, 'mapped', "the old stop closed as dropped; the language's Cancel is cancelled")
        break
      case 'healed':
        p.send(event.id, at, 'factory', {
          kind: 'closed',
          payload: { attempt: null, outcome: 'healed', reason: 'healed before a lead started' },
          actor: 'factory',
        })
        p.disposition(event, 'mapped', null)
        break
      case 'settled':
        p.disposition(event, 'dropped', 'the Issue is settled when imported')
        break
      case 'reopen':
        p.send(event.id, at, 'owner', {
          kind: 'reopened',
          payload: { reason: clip(text(payload.reason) ?? 'reopened', 2000) },
          actor: 'owner',
        })
        p.reconcile(event)
        p.disposition(event, 'mapped', null)
        break
      case 'prio': {
        const value = whole(payload.value)
        if (value === null) {
          p.disposition(event, 'dropped', 'a priority with no value')
          break
        }
        p.prios.push({
          key: key('import', 'prio', event.id),
          value: Math.max(-1000, Math.min(1000, value)),
          actor: text(payload.who) ?? 'owner',
          at,
        })
        p.disposition(event, 'folded', 'planning_prios')
        break
      }
      case 'dep':
        p.disposition(event, 'folded', 'planning_edges, from issue_deps')
        break
      case 'github_writeback':
        p.writeback = { result: text(payload.result) ?? 'written', at }
        p.disposition(event, 'folded', 'intake_writebacks')
        break
      case 'issue_finalized': {
        const attempt = whole(payload.attempt) ?? Math.max(1, p.now.attempt)
        if (!p.finalizations.some((f) => f.attempt === attempt)) {
          p.finalizations.push({ attempt, at, worktreeKept: null, worktreePath: null })
        }
        p.disposition(event, 'folded', 'lead_finalizations')
        break
      }
      case 'worktree_kept': {
        const attempt = whole(payload.attempt) ?? Math.max(1, p.now.attempt)
        const done = p.finalizations.find((f) => f.attempt === attempt)
        const kept = text(payload.kept) ?? 'kept'
        if (done) {
          done.worktreeKept = kept
          done.worktreePath = text(payload.path)
        } else {
          p.finalizations.push({ attempt, at, worktreeKept: kept, worktreePath: text(payload.path) })
        }
        p.disposition(event, 'folded', 'lead_finalizations')
        break
      }
      case 'phase':
        p.reconcile(event)
        p.disposition(event, 'dropped', DROPPED.phase ?? 'derived from the state')
        break
      default: {
        const why = DROPPED[event.kind]
        p.disposition(event, 'dropped', why ?? `unknown old event kind ${event.kind}: nothing maps it`)
        if (!why) p.notes.push(`Issue ${row.id}: unknown old event kind ${event.kind} (event ${event.id})`)
      }
    }
  }

  // The old core closed it and the new machine did not take the events: close it by the owner's cancel rather than leave it open.
  if (row.state === 'closed' && p.now.state !== 'closed') {
    p.send(
      0,
      row.closedAt ?? p.now.closedAt ?? row.createdAt,
      'owner',
      {
        kind: 'cancelled',
        payload: {
          reason: `imported: closed in the old core as ${row.outcome ?? 'dropped'}; the new machine did not take the old events`,
        },
        actor: 'owner',
      },
      'forced-close',
    )
    p.notes.push(`Issue ${row.id}: closed by force (old outcome ${row.outcome ?? 'none'})`)
    p.take()
  }

  return {
    issue: p.now,
    entries: p.entries,
    dispositions: p.dispositions,
    decisions: p.decisions,
    decisionSteps: p.decisionSteps,
    ships: p.ships,
    evidence: p.evidence,
    watches: p.watches,
    checks: p.checks,
    prios: p.prios,
    writeback: p.writeback,
    finalizations: p.finalizations,
    notes: p.notes,
  }
}
