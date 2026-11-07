import type { Actor } from '../../kernel/events.ts'
import type { IssueId } from '../../kernel/ids.ts'
import type { Effect } from './effects.ts'
import { type AnyIssueEvent, type EventKind, type IssueEvent, PAYLOADS, SENDERS } from './events.ts'
import type { Issue, Outcome, State, Wait } from './issue.ts'
import { type Cell, type Ctx, TABLE } from './table.ts'

/** What an applied event did to the Issue, stored with the event so a load replays it without deciding again. */
export interface Transition {
  /** null for `filed`, which makes the Issue */
  from: State | null
  to: State
  wait: Wait | null
  outcome: Outcome | null
}

export type Applied = { result: 'applied'; issue: Issue; transition: Transition; effects: Effect[] }
export type Decided = Applied | { result: 'refused' | 'ignored'; detail: string }

/** An applied event as stored: enough to replay the Issue. */
export interface AppliedRecord {
  kind: EventKind
  payload: unknown
  at: Date
  version: number
  transition: Transition
}

const senderRefusal = (event: { kind: EventKind; actor: Actor }): string | null =>
  SENDERS[event.kind].includes(event.actor) ? null : `${event.kind} is not the ${event.actor}'s to send`

/** The counts and times an event changes besides the state. */
function evolve(
  issue: Issue,
  kind: EventKind,
  at: Date,
  version: number,
  transition: Transition,
  payload: unknown,
): Issue {
  const refined = kind === 'settled' ? PAYLOADS.settled.parse(payload).kind : undefined
  return {
    ...issue,
    kind: refined ?? issue.kind,
    version,
    state: transition.to,
    wait: transition.wait,
    outcome: transition.outcome,
    attempt: kind === 'admitted' ? issue.attempt + 1 : issue.attempt,
    watch: kind === 'shipped' ? issue.watch + 1 : issue.watch,
    restarts: kind === 'lead_gone' && transition.to === 'queued' ? issue.restarts + 1 : issue.restarts,
    regressions: kind === 'regressed' ? issue.regressions + 1 : issue.regressions,
    closedAt: transition.to === 'closed' ? at : kind === 'reopened' ? null : issue.closedAt,
  }
}

function opened(id: IssueId, event: IssueEvent<'filed'>): Issue {
  return {
    id,
    version: 1,
    state: 'settling',
    wait: null,
    outcome: null,
    ...event.payload,
    attempt: 0,
    watch: 0,
    restarts: 0,
    regressions: 0,
    closedAt: null,
  }
}

/** A new Issue from its `filed` event: version 1, `settling`. */
export function file(id: IssueId, event: IssueEvent<'filed'>): Decided {
  const refusal = senderRefusal(event)
  if (refusal) return { result: 'refused', detail: refusal }
  const issue = opened(id, event)
  return {
    result: 'applied',
    issue,
    transition: { from: null, to: 'settling', wait: null, outcome: null },
    effects: [],
  }
}

/** The transition a cell asked for, made whole: a kept wait, a new wait's `since`. */
function transitionOf(
  issue: Issue,
  event: { actor: Actor },
  cell: Exclude<Cell, { refuse: string } | { ignore: string }>,
): Transition {
  const version = issue.version + 1
  if (cell.to === 'waiting') {
    // The lead heard its own verb; a wait the factory began (a wall, the third regression) is news to it.
    const told = issue.wait?.told ?? (event.actor === 'lead' ? version : issue.version)
    const wait = cell.wait ? { ...cell.wait, since: version, told } : issue.wait
    if (!wait) throw new Error(`a cell kept the wait of a ${issue.state} Issue, which has none`)
    return { from: issue.state, to: 'waiting', wait, outcome: null }
  }
  if (cell.to === 'closed') return { from: issue.state, to: 'closed', wait: null, outcome: cell.outcome }
  return { from: issue.state, to: cell.to, wait: null, outcome: null }
}

/**
 * The one decision: the Issue's next state and its effects, or why the event changes nothing. Pure: the same Issue,
 * event and time give the same answer.
 */
export function apply(issue: Issue, event: AnyIssueEvent, ctx: { now: Date }): Decided {
  const refusal = senderRefusal(event)
  if (refusal) return { result: 'refused', detail: refusal }
  if (event.kind === 'filed') return { result: 'ignored', detail: 'it is filed already' }
  const run = TABLE[issue.state][event.kind] as (ctx: Ctx) => Cell
  const cell = run({ issue, event, now: ctx.now })
  if ('refuse' in cell) return { result: 'refused', detail: cell.refuse }
  if ('ignore' in cell) return { result: 'ignored', detail: cell.ignore }
  const transition = transitionOf(issue, event, cell)
  return {
    result: 'applied',
    issue: evolve(issue, event.kind, ctx.now, issue.version + 1, transition, event.payload),
    transition,
    effects: cell.effects,
  }
}

/** The Issue from its applied events, oldest first: the stored transitions, never a new decision. */
export function replay(id: IssueId, records: readonly AppliedRecord[]): Issue {
  const [first, ...rest] = records
  if (first?.kind !== 'filed' || first.version !== 1) throw new Error(`issue ${id}: its log does not begin with filed`)
  let issue = opened(id, { kind: 'filed', payload: PAYLOADS.filed.parse(first.payload), actor: 'factory' })
  for (const record of rest) {
    if (record.version !== issue.version + 1) {
      throw new Error(`issue ${id}: version ${record.version} follows ${issue.version}`)
    }
    issue = evolve(issue, record.kind, record.at, record.version, record.transition, record.payload)
  }
  return issue
}
