import { expect, test } from 'bun:test'
import { noteText } from '../../src/domains/leads/note.ts'
import { apply } from '../../src/domains/work/machine.ts'
import type { AnyIssueEvent } from '../../src/domains/work/events.ts'
import { filedIssue } from '../../src/domains/work/explore.ts'
import type { Issue } from '../../src/domains/work/issue.ts'
import type { Actor } from '../../src/kernel/events.ts'
import type { IssueId } from '../../src/kernel/ids.ts'

const id = 'issue_pause' as IssueId
const T0 = new Date('2026-11-20T00:00:00Z')
const MIN = 60_000

/** Applies an event, and returns the Issue it made (or throws with why it did not apply). */
function step(issue: Issue, event: AnyIssueEvent, now: Date): Issue {
  const decided = apply(issue, event, { now })
  if (decided.result !== 'applied') throw new Error(`${event.kind} was ${decided.result}: ${decided.detail}`)
  return decided.issue
}
const e = <K extends AnyIssueEvent['kind']>(
  kind: K,
  payload: Extract<AnyIssueEvent, { kind: K }>['payload'],
  actor: Actor,
) => ({ kind, payload, actor }) as AnyIssueEvent

/** A working Issue on attempt 1. */
function running(): Issue {
  let issue = filedIssue(id)
  issue = step(issue, e('settled', {}, 'factory'), T0)
  issue = step(issue, e('admitted', {}, 'factory'), T0)
  return step(issue, e('lead_started', { attempt: 1, terminal: 't' }, 'factory'), T0)
}

/** Every event the loops and the lead can send a waiting Issue, as each would send it. */
const callers = (issue: Issue, now: Date): AnyIssueEvent[] => {
  const since = issue.wait?.since ?? 1
  return [
    e('woken', { since, detail: 'the steward re-checked' }, 'steward'),
    e('woken', { since, detail: 'the window opened' }, 'factory'),
    e('stalled', { attempt: 1, cause: 'wall', detail: 'the window is spent' }, 'factory'),
    e('stalled', { attempt: 1, cause: 'unreported', detail: 'the lead stopped' }, 'factory'),
    e('stalled', { attempt: 1, cause: 'blocked', detail: 'the owner paused it' }, 'lead'),
    e('lead_gone', { attempt: 1, detail: 'its terminal ended' }, 'factory'),
    e('asked', { attempt: 1, decision: { id: 'decision_1', summary: 'keep paused?' } }, 'steward'),
    e('asked', { attempt: 1, decision: { id: 'decision_2', summary: 'keep paused?' } }, 'lead'),
    e('deferred', { attempt: 1, until: new Date(now.getTime() + 60 * MIN).toISOString() }, 'steward'),
    e('deferred', { attempt: 1, after: ['issue_other' as IssueId] }, 'steward'),
    e('deferred', { attempt: 1, until: new Date(now.getTime() + 60 * MIN).toISOString() }, 'lead'),
    e('shipped', { attempt: 1 }, 'lead'),
    e('closed', { attempt: 1, outcome: 'dropped', reason: 'paused' }, 'lead'),
    e('moved_up', { attempt: 1, why: 'struggled' }, 'factory'),
    e('submitted', { attempt: 1, artifact: { id: 'artifact_1', summary: 's' } }, 'lead'),
    e('errand_raised', { attempt: 1, errand: { id: 'errand_1', summary: 's' } }, 'lead'),
  ]
}

test('a paused Issue takes no loop or lead event for 24 hours of passes, and the owner word ends it', () => {
  let issue = step(running(), e('paused', { reason: 'wait for the release' }, 'owner'), T0)
  expect(issue.wait).toMatchObject({ reason: 'paused', detail: 'wait for the release' })
  const version = issue.version
  for (let minute = 5; minute <= 24 * 60; minute += 5) {
    const now = new Date(T0.getTime() + minute * MIN)
    for (const event of callers(issue, now)) {
      expect(apply(issue, event, { now }).result).not.toBe('applied')
    }
  }
  expect(issue.version).toBe(version)
  issue = step(issue, e('noted', { text: 'also this' }, 'owner'), new Date(T0.getTime() + 25 * 60 * MIN))
  issue = step(
    issue,
    e('woken', { since: issue.wait?.since ?? 0, detail: 'the owner said go' }, 'owner'),
    new Date(T0.getTime() + 26 * 60 * MIN),
  )
  expect(issue).toMatchObject({ state: 'working', wait: null })
})

test('a pause with a time resumes at the time by the factory and not before', () => {
  const until = new Date(T0.getTime() + 24 * 60 * MIN).toISOString()
  const issue = step(running(), e('paused', { reason: 'a day hold', until }, 'owner'), T0)
  const wake = (now: Date) =>
    apply(issue, e('woken', { since: issue.wait?.since ?? 0, detail: 'its time has come' }, 'factory'), { now })
  expect(wake(new Date(T0.getTime() + 24 * 60 * MIN - MIN)).result).toBe('refused')
  expect(wake(new Date(T0.getTime() + 24 * 60 * MIN)).result).toBe('applied')
})

test('the lead hears the pause once: the resume does not repeat it', () => {
  const paused = apply(running(), e('paused', { reason: 'hold' }, 'owner'), { now: T0 })
  if (paused.result !== 'applied') throw new Error('not applied')
  const told = paused.effects.find((effect) => effect.kind === 'note_lead')
  expect(told?.kind === 'note_lead' && told.payload).toMatchObject({
    from: paused.issue.version,
    version: paused.issue.version,
  })
  expect(paused.issue.wait?.told).toBe(paused.issue.version)
  const resumed = apply(paused.issue, e('woken', { since: paused.issue.wait?.since ?? 0, detail: 'go' }, 'owner'), {
    now: T0,
  })
  if (resumed.result !== 'applied') throw new Error('not applied')
  const note = resumed.effects.find((effect) => effect.kind === 'note_lead')
  expect(note?.kind === 'note_lead' && note.payload.from).toBe(paused.issue.version + 1)
})

test('a pause replaces a stall and a timer, updates a pause, and keeps a dependency and a person wait', () => {
  const stalled = step(running(), e('stalled', { attempt: 1, cause: 'blocked', detail: 'x' }, 'lead'), T0)
  const pause = (issue: Issue) => apply(issue, e('paused', { reason: 'hold' }, 'owner'), { now: T0 })
  expect(pause(stalled).result).toBe('applied')
  const timed = step(
    running(),
    e('deferred', { attempt: 1, until: new Date(T0.getTime() + 60 * MIN).toISOString() }, 'lead'),
    T0,
  )
  expect(pause(timed).result).toBe('applied')
  const again = step(stalled, e('paused', { reason: 'hold' }, 'owner'), T0)
  const updated = apply(again, e('paused', { reason: 'a later hold' }, 'orchestrator'), { now: T0 })
  expect(updated.result === 'applied' && updated.transition.wait).toMatchObject({
    reason: 'paused',
    detail: 'a later hold',
    since: again.wait?.since,
  })
  const dependent = step(running(), e('deferred', { attempt: 1, after: ['issue_other' as IssueId] }, 'lead'), T0)
  expect(pause(dependent).result).toBe('refused')
  let lost = running()
  for (let attempt = 1; attempt <= 3; attempt++) {
    lost = step(lost, e('lead_gone', { attempt, detail: 'gone' }, 'factory'), T0)
    if (lost.state === 'queued') {
      lost = step(lost, e('admitted', {}, 'factory'), T0)
      lost = step(lost, e('lead_started', { attempt: attempt + 1, terminal: 't' }, 'factory'), T0)
    }
  }
  expect(lost.wait?.reason).toBe('lead_gone')
  expect(pause(lost).result).toBe('refused')
  const asking = step(running(), e('asked', { attempt: 1, decision: { id: 'decision_1', summary: 's' } }, 'lead'), T0)
  expect(pause(asking).result).toBe('refused')
})

test('an unstarted, a shipped and a closed Issue refuse a pause, and a past time is refused', () => {
  const pause = (issue: Issue, until?: string) =>
    apply(issue, e('paused', { reason: 'hold', ...(until ? { until } : {}) }, 'owner'), { now: T0 })
  expect(pause(filedIssue(id)).result).toBe('refused')
  expect(pause(step(filedIssue(id), e('settled', {}, 'factory'), T0)).result).toBe('refused')
  const shipped = step(running(), e('shipped', { attempt: 1 }, 'lead'), T0)
  expect(pause(shipped).result).toBe('refused')
  const closed = step(running(), e('cancelled', { reason: 'no' }, 'owner'), T0)
  expect(pause(closed).result).toBe('refused')
  expect(pause(running(), new Date(T0.getTime() - MIN).toISOString()).result).toBe('refused')
  expect(apply(running(), e('paused', { reason: 'hold' }, 'lead'), { now: T0 }).result).toBe('refused')
})

test('the lead is told of a pause when it runs, and not again in the note that ends it', () => {
  const record = (kind: string, payload: unknown, version: number) => ({
    kind,
    payload,
    actor: 'owner',
    at: T0,
    version,
  })
  const paused = record('paused', { reason: 'hold for the release' }, 5)
  const woken = record('woken', { since: 5, detail: 'the owner said go' }, 6)
  expect(noteText(id, [paused])).toContain('the owner paused this Issue')
  const resume = noteText(id, [paused, woken])
  expect(resume).not.toContain('paused')
  expect(resume).toContain('your wait is over')
  // a wake of an earlier wait does not end a pause recorded after it
  const late = record('paused', { reason: 'a later hold' }, 8)
  expect(noteText(id, [woken, late])).toContain('a later hold')
})
