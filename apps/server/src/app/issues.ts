import type { WorkStore, StoredEvent } from '../domains/work/ports.ts'
import { OUTLIVES_CLOSE, type Effect } from '../domains/work/effects.ts'
import type { AnyIssueEvent, IssueEvent } from '../domains/work/events.ts'
import type { Issue } from '../domains/work/issue.ts'
import { apply, type Decided, file, replay } from '../domains/work/machine.ts'
import type { Clock } from '../kernel/clock.ts'
import type { EventId, IdSource, IssueId } from '../kernel/ids.ts'
import type { Key } from '../kernel/keys.ts'
import { err, ok, type PortError, type Result } from '../kernel/result.ts'
import type { UnitOfWork } from './unit-of-work.ts'

/** What recording an event did. `replayed`: its key was stored already, so nothing changed. */
export interface Recorded {
  result: 'applied' | 'refused' | 'ignored' | 'replayed'
  /** the Issue after the event (as it stands, for a replay) */
  issue: Issue
  event: StoredEvent
  /** the effects planned in the outbox; none for anything but an applied event */
  effects: Effect[]
}

export type IssueWriteError =
  | { kind: 'unknown_issue'; issueId: IssueId }
  /** another write moved the Issue first; nothing was stored. Load and try again. */
  | { kind: 'version_conflict'; issueId: IssueId; expected: number }
  /** the key is stored for another Issue or another kind of event: the caller built it wrong */
  | { kind: 'key_taken'; key: Key; detail: string }
  /** a filed event the machine refuses makes no Issue */
  | { kind: 'filing_refused'; detail: string }

export interface WriteDeps {
  clock: Clock
  ids: IdSource
}

export interface EventInput {
  issueId: IssueId
  key: Key
  event: AnyIssueEvent
  causation?: EventId | null
}

function stored(input: {
  id: EventId
  issueId: IssueId
  key: Key
  event: AnyIssueEvent
  at: Date
  causation: EventId | null
  from: Issue | null
  decided: Decided
}): StoredEvent {
  const { decided } = input
  return {
    id: input.id,
    issueId: input.issueId,
    key: input.key,
    kind: input.event.kind,
    payload: input.event.payload,
    actor: input.event.actor,
    at: input.at,
    causation: input.causation,
    from: input.from?.state ?? null,
    result: decided.result,
    version: decided.result === 'applied' ? decided.issue.version : null,
    detail: decided.result === 'applied' ? null : decided.detail,
    transition: decided.result === 'applied' ? decided.transition : null,
  }
}

async function replayed(work: WorkStore, existing: StoredEvent): Promise<Result<Recorded, IssueWriteError>> {
  const history = await work.history(existing.issueId)
  if (!history) return err({ kind: 'unknown_issue', issueId: existing.issueId })
  return ok({ result: 'replayed', issue: replay(existing.issueId, history), event: existing, effects: [] })
}

/**
 * Records one event on an Issue inside a transaction the caller holds: load, apply, then the version-guarded update,
 * the event and its effects. A domain package calls this from its own use case to write its rows in the same
 * transaction; `recordIssueEvent` is the same in a transaction of its own.
 */
export async function recordIn(
  work: WorkStore,
  deps: WriteDeps,
  input: EventInput,
): Promise<Result<Recorded, IssueWriteError>> {
  const existing = await work.eventByKey(input.key)
  if (existing) {
    if (existing.issueId !== input.issueId || existing.kind !== input.event.kind) {
      return err({ kind: 'key_taken', key: input.key, detail: `stored for ${existing.kind} on ${existing.issueId}` })
    }
    return replayed(work, existing)
  }
  const history = await work.history(input.issueId)
  if (!history) return err({ kind: 'unknown_issue', issueId: input.issueId })
  const issue = replay(input.issueId, history)
  const at = deps.clock.now()
  const decided = apply(issue, input.event, { now: at })
  const next = decided.result === 'applied' ? decided.issue : issue
  // A refusal or an ignore leaves the version, but it must still have been decided on the Issue as it stands.
  if (!(await work.updateIssue(next, issue.version))) {
    return err({ kind: 'version_conflict', issueId: issue.id, expected: issue.version })
  }
  const event = stored({
    id: deps.ids.next('event'),
    issueId: issue.id,
    key: input.key,
    event: input.event,
    at,
    causation: input.causation ?? null,
    from: issue,
    decided,
  })
  // Its copy committed between our look and now: the unit of work rolls the update back, and a retry finds the copy.
  if (!(await work.appendEvent(event)))
    return err({ kind: 'version_conflict', issueId: issue.id, expected: issue.version })
  if (decided.result !== 'applied') return ok({ result: decided.result, issue, event, effects: [] })
  if (next.state === 'closed') await work.cancelOpenEffects(issue.id, OUTLIVES_CLOSE, at)
  await work.planEffects(event, decided.effects)
  return ok({ result: 'applied', issue: next, event, effects: decided.effects })
}

/** Files a new Issue inside a transaction the caller holds (intake's, with its signal rows). */
export async function fileIn(
  work: WorkStore,
  deps: WriteDeps,
  input: { key: Key; event: IssueEvent<'filed'>; causation?: EventId | null },
): Promise<Result<Recorded, IssueWriteError>> {
  const existing = await work.eventByKey(input.key)
  if (existing) {
    if (existing.kind !== 'filed')
      return err({ kind: 'key_taken', key: input.key, detail: `stored for ${existing.kind}` })
    return replayed(work, existing)
  }
  const id = deps.ids.next('issue')
  const decided = file(id, input.event)
  if (decided.result !== 'applied') return err({ kind: 'filing_refused', detail: decided.detail })
  const event = stored({
    id: deps.ids.next('event'),
    issueId: id,
    key: input.key,
    event: input.event,
    at: deps.clock.now(),
    causation: input.causation ?? null,
    from: null,
    decided,
  })
  await work.insertIssue(decided.issue)
  if (!(await work.appendEvent(event))) return err({ kind: 'version_conflict', issueId: id, expected: 0 })
  return ok({ result: 'applied', issue: decided.issue, event, effects: [] })
}

export type IssueWrites = UnitOfWork<{ work: WorkStore }>

/** Records one event on an Issue in a transaction of its own. A version conflict comes back to retry. */
export function recordIssueEvent(
  deps: WriteDeps & { uow: IssueWrites },
  input: EventInput,
): Promise<Result<Recorded, IssueWriteError | PortError>> {
  return deps.uow.run(({ work }) => recordIn(work, deps, input))
}

/** Files a new Issue in a transaction of its own. */
export function fileIssue(
  deps: WriteDeps & { uow: IssueWrites },
  input: { key: Key; event: IssueEvent<'filed'>; causation?: EventId | null },
): Promise<Result<Recorded, IssueWriteError | PortError>> {
  return deps.uow.run(({ work }) => fileIn(work, deps, input))
}
