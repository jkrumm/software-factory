import { describe, expect, test } from 'bun:test'
import type { Actor } from '../../src/kernel/events.ts'
import type { IssueId } from '../../src/kernel/ids.ts'
import { type AnyIssueEvent, type EventKind, type IssueEvent, parseIssueEvent } from '../../src/domains/work/events.ts'
import { filedIssue } from '../../src/domains/work/explore.ts'
import type { Issue } from '../../src/domains/work/issue.ts'
import { type AppliedRecord, apply, type Decided, file, replay } from '../../src/domains/work/machine.ts'

const ID = 'issue_7' as IssueId
const NOW = new Date('2026-03-01T12:00:00Z')

const ev = <K extends EventKind>(kind: K, payload: IssueEvent<K>['payload'], actor: Actor) =>
  ({ kind, payload, actor }) as AnyIssueEvent

/** Applies each event in turn; every one must apply. The Issue and every step's effects. */
function drive(events: AnyIssueEvent[], start: Issue = filedIssue(ID), now = NOW) {
  let issue = start
  const effects: string[] = []
  for (const event of events) {
    const decided = apply(issue, event, { now })
    if (decided.result !== 'applied')
      throw new Error(`${event.kind} in ${issue.state}: ${decided.result} (${decided.detail})`)
    effects.push(...decided.effects.map((e) => e.key))
    issue = decided.issue
  }
  return { issue, effects }
}

const settledAndWorking = [ev('settled', {}, 'factory'), ev('admitted', {}, 'factory')]
const detail = (decided: Decided) =>
  decided.result === 'applied' ? decided.result : `${decided.result}: ${decided.detail}`

describe('the paths', () => {
  test('filed to closed through a ship and a passed watch', () => {
    const { issue, effects } = drive([
      ...settledAndWorking,
      ev('lead_started', { attempt: 1, terminal: 'lead-7-1' }, 'factory'),
      ev('shipped', { attempt: 1 }, 'lead'),
      ev('watch_passed', { watch: 1 }, 'factory'),
    ])
    expect(issue).toMatchObject({ state: 'closed', outcome: 'done', version: 6, attempt: 1, watch: 1 })
    expect(effects).toEqual(['start_lead:issue_7:1', 'start_watch:issue_7:1', 'finalize:issue_7:1'])
  })

  test('a lead gone twice starts the next attempt; the third time is a stall the steward restarts', () => {
    const gone = (attempt: number) => ev('lead_gone', { attempt, detail: 'its terminal ended' }, 'factory')
    const admit = ev('admitted', {}, 'factory')
    const { issue, effects } = drive([...settledAndWorking, gone(1), admit, gone(2), admit, gone(3)])
    expect(issue).toMatchObject({ state: 'waiting', attempt: 3, restarts: 2, wait: { reason: 'lead_gone' } })
    expect(effects).toEqual([
      'start_lead:issue_7:1',
      'finalize:issue_7:1',
      'start_lead:issue_7:2',
      'finalize:issue_7:2',
      'start_lead:issue_7:3',
    ])
    const since = issue.wait?.since ?? 0
    const restarted = drive([ev('woken', { since, detail: 'the steward restarts it' }, 'steward')], issue)
    expect(restarted.issue.state).toBe('queued')
    expect(restarted.effects).toEqual(['finalize:issue_7:3'])
  })

  test('the third regression is a stall, not another round with the lead', () => {
    const regress = (watch: number) => ev('regressed', { watch, detail: 'a probe failed' }, 'factory')
    const ship = ev('shipped', { attempt: 1 }, 'lead')
    const { issue } = drive([...settledAndWorking, ship, regress(1), ship, regress(2), ship, regress(3)])
    expect(issue).toMatchObject({ state: 'waiting', regressions: 3, wait: { reason: 'regressed', since: 9, told: 8 } })
    // When the steward sends it back, the lead hears the regression that stalled it.
    const decided = apply(issue, ev('woken', { since: 9, detail: 'try again' }, 'steward'), { now: NOW })
    expect(decided.result === 'applied' && decided.effects[0]?.payload).toEqual({ attempt: 1, from: 9, version: 10 })
  })

  test('a Decision holds its checkpoint and ends only with its own answer', () => {
    const decision = { id: 'decision_1', summary: 'Postgres or SQLite?' }
    const { issue } = drive([...settledAndWorking, ev('asked', { attempt: 1, decision }, 'lead')])
    expect(issue.wait).toEqual({ reason: 'decision', holds: decision, since: 4, told: 4 })
    expect(detail(apply(issue, ev('answered', { decision: 'decision_2', answer: 'x' }, 'owner'), { now: NOW }))).toBe(
      'ignored: it waits for decision decision_1, not decision_2',
    )
    expect(detail(apply(issue, ev('woken', { since: 4, detail: 'go' }, 'steward'), { now: NOW }))).toBe(
      'refused: a decision wait ends with its answer, not a wake',
    )
    const answered = drive([ev('answered', { decision: 'decision_1', answer: 'Postgres' }, 'judge')], issue)
    expect(answered.issue.state).toBe('working')
    expect(answered.effects).toEqual(['note_lead:issue_7:5'])
  })

  test('a note to a waiting lead reaches it with what ends the wait', () => {
    const decision = { id: 'decision_1', summary: 'Postgres or SQLite?' }
    const { issue } = drive([
      ...settledAndWorking,
      ev('asked', { attempt: 1, decision }, 'lead'),
      ev('noted', { text: 'also check the logs' }, 'owner'),
    ])
    expect(issue).toMatchObject({ state: 'waiting', version: 5, wait: { since: 4 } })
    const decided = apply(issue, ev('answered', { decision: 'decision_1', answer: 'Postgres' }, 'owner'), { now: NOW })
    if (decided.result !== 'applied') throw new Error(detail(decided))
    // Versions 5 (the note) and 6 (the answer): everything after the ask.
    expect(decided.effects.map((e) => ({ ...e, key: String(e.key) }))).toEqual([
      { kind: 'note_lead', key: 'note_lead:issue_7:6', payload: { attempt: 1, from: 5, version: 6 } },
    ])
  })

  test('a note during a timed wait still reaches the lead when a lead verb begins another wait', () => {
    const { issue } = drive([
      ...settledAndWorking,
      ev('deferred', { attempt: 1, until: '2026-03-01T13:00:00Z' }, 'lead'),
      ev('noted', { text: 'also check the logs' }, 'owner'),
      ev('stalled', { attempt: 1, cause: 'blocked', detail: 'the API is down' }, 'lead'),
    ])
    expect(issue.wait).toMatchObject({ reason: 'blocked', since: 6, told: 4 })
    const woken = drive([ev('woken', { since: 6, detail: 'the API is back' }, 'steward')], issue)
    expect(woken.effects).toEqual(['note_lead:issue_7:7'])
    const decided = apply(issue, ev('woken', { since: 6, detail: 'the API is back' }, 'steward'), { now: NOW })
    expect(decided.result === 'applied' && decided.effects[0]?.payload).toEqual({ attempt: 1, from: 5, version: 7 })
  })

  test('a timed wait takes the lead verbs; another wait refuses them', () => {
    const timed = drive([...settledAndWorking, ev('deferred', { attempt: 1, until: '2026-03-01T13:00:00Z' }, 'lead')])
    expect(drive([ev('shipped', { attempt: 1 }, 'lead')], timed.issue).issue.state).toBe('watching')
    const blocked = drive([
      ...settledAndWorking,
      ev('stalled', { attempt: 1, cause: 'blocked', detail: 'no API' }, 'lead'),
    ])
    expect(detail(apply(blocked.issue, ev('shipped', { attempt: 1 }, 'lead'), { now: NOW }))).toBe(
      'refused: it waits for blocked: shipped is taken only from a timed wait',
    )
  })

  test('a late wake for an earlier wait changes nothing', () => {
    const { issue } = drive([
      ...settledAndWorking,
      ev('stalled', { attempt: 1, cause: 'wall', detail: 'window spent' }, 'factory'),
      ev('woken', { since: 4, detail: 'window open' }, 'factory'),
      ev('stalled', { attempt: 1, cause: 'wall', detail: 'window spent' }, 'factory'),
    ])
    expect(detail(apply(issue, ev('woken', { since: 4, detail: 'late' }, 'factory'), { now: NOW }))).toBe(
      'ignored: wakes the wait that began at version 4; this one began at 6',
    )
  })

  test('closed leaves only by reopened, within 30 days', () => {
    const { issue } = drive([...settledAndWorking, ev('cancelled', { reason: 'not now' }, 'owner')])
    expect(issue).toMatchObject({ state: 'closed', outcome: 'cancelled' })
    expect(detail(apply(issue, ev('noted', { text: 'hello' }, 'owner'), { now: NOW }))).toBe(
      'refused: it is closed: reopen it first',
    )
    const late = new Date(NOW.getTime() + 31 * 24 * 60 * 60_000)
    expect(detail(apply(issue, ev('reopened', { reason: 'again' }, 'owner'), { now: late }))).toBe(
      'refused: closed more than 30 days ago: file a new Issue',
    )
    expect(drive([ev('reopened', { reason: 'again' }, 'owner')], issue).issue).toMatchObject({
      state: 'queued',
      outcome: null,
      closedAt: null,
    })
  })

  test('the sender rule and the attempt rule', () => {
    const working = drive(settledAndWorking).issue
    expect(detail(apply(working, ev('cancelled', { reason: 'mine' }, 'lead'), { now: NOW }))).toBe(
      "refused: cancelled is not the lead's to send",
    )
    expect(detail(apply(working, ev('shipped', { attempt: 2 }, 'lead'), { now: NOW }))).toBe(
      'refused: shipped was filed for attempt 2; the Issue is on attempt 1',
    )
    expect(detail(apply(working, ev('lead_gone', { attempt: 2, detail: 'x' }, 'factory'), { now: NOW }))).toBe(
      'ignored: lead_gone is for attempt 2; the Issue is on attempt 1',
    )
    expect(
      file(ID, { kind: 'filed', payload: { repo: 'r', title: 't', kind: 'bug', origin: 'you' }, actor: 'lead' }).result,
    ).toBe('refused')
  })

  test('the orchestrator may cancel, note and reopen, and may not give a verdict or finish an Errand', () => {
    const working = drive(settledAndWorking).issue
    expect(apply(working, ev('noted', { text: 'steer' }, 'orchestrator'), { now: NOW }).result).toBe('applied')
    expect(apply(working, ev('cancelled', { reason: 'no' }, 'orchestrator'), { now: NOW }).result).toBe('applied')
    expect(
      detail(
        apply(working, ev('verdict_given', { artifact: 'artifact_1', verdict: 'looks_good' }, 'orchestrator'), {
          now: NOW,
        }),
      ),
    ).toBe("refused: verdict_given is not the orchestrator's to send")
    expect(detail(apply(working, ev('errand_done', { errand: 'errand_1' }, 'orchestrator'), { now: NOW }))).toBe(
      "refused: errand_done is not the orchestrator's to send",
    )
  })

  test('an incident that heals before a lead closes as healed; a lead cannot heal', () => {
    const healed = ev('closed', { attempt: null, outcome: 'healed', reason: 'cleared' }, 'factory')
    expect(drive([healed]).issue).toMatchObject({ state: 'closed', outcome: 'healed' })
    expect(detail(apply(drive(settledAndWorking).issue, healed, { now: NOW }))).toBe(
      'refused: a lead works it: healed is for an Issue no lead has started',
    )
  })
})

test('parseIssueEvent checks the kind and the payload', () => {
  expect(parseIssueEvent({ kind: 'nope', payload: {}, actor: 'owner' })).toBe('unknown event kind nope')
  expect(parseIssueEvent({ kind: 'shipped', payload: { attempt: 0 }, actor: 'lead' })).toContain('shipped: attempt')
  expect(parseIssueEvent({ kind: 'shipped', payload: { attempt: 1 }, actor: 'lead' })).toEqual({
    kind: 'shipped',
    payload: { attempt: 1 },
    actor: 'lead',
  })
})

describe('settled refines the kind', () => {
  const records = (settledPayload: unknown): AppliedRecord[] => {
    const filed = filedIssue(ID)
    const settled = apply(filed, ev('settled', {}, 'factory'), { now: NOW })
    if (settled.result !== 'applied') throw new Error('settled did not apply')
    return [
      {
        kind: 'filed',
        payload: { repo: filed.repo, title: filed.title, kind: 'feature', origin: filed.origin },
        actor: 'factory',
        at: NOW,
        version: 1,
        transition: { from: null, to: 'settling', wait: null, outcome: null },
      },
      {
        kind: 'settled',
        payload: settledPayload,
        actor: 'factory',
        at: NOW,
        version: 2,
        transition: settled.transition,
      },
    ] as AppliedRecord[]
  }

  test('apply sets the kind the event carries and keeps it when it carries none', () => {
    const start = { ...filedIssue(ID), kind: 'feature' as const }
    expect(drive([ev('settled', { kind: 'docs' }, 'factory')], start).issue.kind).toBe('docs')
    expect(drive([ev('settled', {}, 'factory')], start).issue.kind).toBe('feature')
  })

  test('a log with settled{kind} replays to the new kind; settled{} still replays', () => {
    expect(replay(ID, records({ kind: 'bug' })).kind).toBe('bug')
    expect(replay(ID, records({})).kind).toBe('feature')
  })
})
