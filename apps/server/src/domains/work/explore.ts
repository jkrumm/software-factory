import type { Actor } from '../../kernel/events.ts'
import type { IssueId } from '../../kernel/ids.ts'
import { type AnyIssueEvent, EVENT_KINDS, type EventKind, type IssueEvent } from './events.ts'
import {
  type Issue,
  MAX_REGRESSIONS,
  MAX_RESTARTS,
  type State,
  STATES,
  WAIT_REASONS,
  type WaitReason,
} from './issue.ts'
import { apply, file } from './machine.ts'

/**
 * The event space the model test plays and the diagram walks: for an Issue as it stands, every event worth sending,
 * each with the payloads that matter (the current attempt, watch, wait or checkpoint, and a stale one) from its senders.
 */
export function candidates(issue: Issue, now: Date): AnyIssueEvent[] {
  // A payload always parses: before the first admission a lead's verb names attempt 1, which is not the Issue's.
  const attempt = Math.max(1, issue.attempt)
  const stale = attempt + 1
  const { watch } = issue
  const holds = issue.wait && 'holds' in issue.wait ? issue.wait.holds.id : 'none'
  const reviewed = issue.wait?.reason === 'review' ? (issue.wait.decisions ?? []) : []
  const since = issue.wait?.since ?? issue.version
  const checkpoint = (kind: string) => ({
    id: `${kind}_${issue.version}`,
    summary: `the ${kind} of version ${issue.version}`,
  })
  const later = new Date(now.getTime() + 60 * 60_000).toISOString()
  const e = <K extends EventKind>(kind: K, payload: IssueEvent<K>['payload'], actor: Actor) =>
    ({ kind, payload, actor }) as AnyIssueEvent
  return [
    e('filed', { repo: 'r', title: 't', kind: 'bug', origin: 'you' }, 'factory'),
    e('settled', {}, 'factory'),
    e('admitted', {}, 'factory'),
    e('lead_started', { attempt, terminal: 'lead' }, 'factory'),
    e('lead_started', { attempt: stale, terminal: 'lead' }, 'factory'),
    e('lead_gone', { attempt, detail: 'its terminal ended' }, 'factory'),
    e('lead_gone', { attempt: stale, detail: 'its terminal ended' }, 'factory'),
    e('noted', { text: 'also look at the logs' }, 'owner'),
    e('noted', { text: 'an amend' }, 'factory'),
    e('asked', { attempt, decision: checkpoint('decision') }, 'lead'),
    e('asked', { attempt: stale, decision: checkpoint('decision') }, 'lead'),
    e('answered', { decision: holds, answer: 'yes' }, 'owner'),
    e('answered', { decision: holds, answer: 'yes' }, 'judge'),
    e('answered', { decision: 'decision_other', answer: 'no' }, 'owner'),
    ...reviewed.flatMap((open) => [
      e('answered', { decision: open.id, answer: 'yes' }, 'owner'),
      e('answered', { decision: open.id, answer: 'yes' }, 'judge'),
    ]),
    e('submitted', { attempt, artifact: checkpoint('artifact') }, 'lead'),
    e('verdict_given', { artifact: holds, verdict: 'with_notes' }, 'owner'),
    e('verdict_given', { artifact: 'artifact_other', verdict: 'changes' }, 'owner'),
    e('errand_raised', { attempt, errand: checkpoint('errand') }, 'lead'),
    e('errand_done', { errand: holds }, 'owner'),
    e('errand_done', { errand: 'errand_other' }, 'owner'),
    e('deferred', { attempt, until: later }, 'lead'),
    e('deferred', { attempt, after: ['issue_other' as IssueId] }, 'lead'),
    e('deferred', { attempt, after: ['issue_other' as IssueId], why: 'it waits for a claim' }, 'steward'),
    e('deferred', { attempt, until: later }, 'steward'),
    e('stalled', { attempt, cause: 'wall', detail: 'the window is spent' }, 'factory'),
    e('stalled', { attempt, cause: 'unreported', detail: 'stopped twice' }, 'factory'),
    e('stalled', { attempt, cause: 'blocked', detail: 'the API is down' }, 'lead'),
    e('stalled', { attempt, cause: 'wall', detail: 'reported by the wrong one' }, 'lead'),
    e('woken', { since, detail: 'its cause ended' }, 'factory'),
    e('woken', { since, detail: 'the steward re-checked' }, 'steward'),
    e('woken', { since: since + 1, detail: 'a late wake' }, 'factory'),
    e('woken', { since, detail: 'the owner said go' }, 'owner'),
    e('shipped', { attempt }, 'lead'),
    e('shipped', { attempt: stale }, 'lead'),
    e('watch_passed', { watch: Math.max(1, watch) }, 'factory'),
    e('watch_passed', { watch: watch + 1 }, 'factory'),
    e('regressed', { watch: Math.max(1, watch), detail: 'a probe failed' }, 'factory'),
    e('regressed', { watch: null, detail: 'the alert fired again' }, 'factory'),
    e('regressed', { watch: watch + 1, detail: 'a later watch' }, 'factory'),
    e('reopened', { reason: 'the same fault' }, 'owner'),
    e('cancelled', { reason: 'no longer wanted' }, 'owner'),
    e('cancelled', { reason: 'not the lead to say' }, 'lead'),
    e('closed', { attempt, outcome: 'done', reason: 'nothing to deploy' }, 'lead'),
    e('closed', { attempt, outcome: 'dropped', reason: 'not worth it' }, 'lead'),
    e('closed', { attempt: null, outcome: 'healed', reason: 'the alert cleared' }, 'factory'),
  ]
}

/** A fresh Issue, as `filed` makes it. */
export function filedIssue(id: IssueId): Issue {
  const decided = file(id, {
    kind: 'filed',
    payload: { repo: 'r', title: 't', kind: 'bug', origin: 'you' },
    actor: 'factory',
  })
  if (decided.result !== 'applied') throw new Error('a filed event from the factory is applied')
  return decided.issue
}

export interface Edge {
  from: State
  to: State
  kind: EventKind
  /** the wait it enters or leaves, when it does */
  reason: WaitReason | null
}

/** What the table can do from an Issue, ignoring the counts that grow without bound: the walk's key for an Issue it has seen. */
const shapeOf = (issue: Issue): string =>
  JSON.stringify([
    issue.state,
    issue.wait?.reason ?? null,
    issue.wait !== null && 'watching' in issue.wait,
    issue.wait?.reason === 'review' && (issue.wait.decisions?.length ?? 0) > 0,
    issue.wait?.reason === 'review' && issue.wait.verdictGiven === true,
    Math.min(issue.attempt, 1),
    Math.min(issue.watch, 1),
    Math.min(issue.restarts, MAX_RESTARTS + 1),
    Math.min(issue.regressions, MAX_REGRESSIONS + 1),
  ])

/** Every edge reachable from a filed Issue, walked over the candidates; sorted by state, then event, then reason. */
export function edges(): Edge[] {
  const now = new Date('2026-01-01T00:00:00Z')
  const found = new Map<string, Edge>()
  const seen = new Set<string>()
  const queue: Issue[] = [filedIssue('issue_walk' as IssueId)]
  while (queue.length) {
    const issue = queue.shift()
    if (!issue) break
    const shape = shapeOf(issue)
    if (seen.has(shape)) continue
    seen.add(shape)
    for (const event of candidates(issue, now)) {
      const decided = apply(issue, event, { now })
      if (decided.result !== 'applied') continue
      const { to, wait } = decided.transition
      const reason =
        to === 'waiting' ? (wait?.reason ?? null) : issue.state === 'waiting' ? (issue.wait?.reason ?? null) : null
      if (to !== issue.state) {
        const edge = { from: issue.state, to, kind: event.kind, reason }
        found.set(JSON.stringify(edge), edge)
      }
      queue.push(decided.issue)
    }
  }
  const order = <T>(list: readonly T[], value: T) => list.indexOf(value)
  return [...found.values()].sort(
    (a, b) =>
      order(STATES, a.from) - order(STATES, b.from) ||
      order(STATES, a.to) - order(STATES, b.to) ||
      order(EVENT_KINDS, a.kind) - order(EVENT_KINDS, b.kind) ||
      order<WaitReason | null>(WAIT_REASONS, a.reason) - order<WaitReason | null>(WAIT_REASONS, b.reason),
  )
}
