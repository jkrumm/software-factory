import { describe, expect, test } from 'bun:test'
import type { Actor } from '../../src/kernel/events.ts'
import type { IssueId } from '../../src/kernel/ids.ts'
import type { AnyIssueEvent, EventKind, IssueEvent } from '../../src/domains/work/events.ts'
import { filedIssue } from '../../src/domains/work/explore.ts'
import type { Issue } from '../../src/domains/work/issue.ts'
import { apply } from '../../src/domains/work/machine.ts'
import { noteText } from '../../src/domains/leads/note.ts'

const ID = 'issue_9' as IssueId
const NOW = new Date('2026-11-13T12:00:00Z')

const ev = <K extends EventKind>(kind: K, payload: IssueEvent<K>['payload'], actor: Actor) =>
  ({ kind, payload, actor }) as AnyIssueEvent

function drive(events: AnyIssueEvent[], start: Issue = filedIssue(ID)) {
  let issue = start
  for (const event of events) {
    const decided = apply(issue, event, { now: NOW })
    if (decided.result !== 'applied')
      throw new Error(`${event.kind} in ${issue.state}: ${decided.result} (${decided.detail})`)
    issue = decided.issue
  }
  return issue
}

const working = [
  ev('settled', {}, 'factory'),
  ev('admitted', {}, 'factory'),
  ev('lead_started', { attempt: 1, terminal: 'lead-9-1' }, 'factory'),
]
const errand = { id: 'errand_1', summary: 'Approve and merge PR #91' }
const raised = () => drive([...working, ev('errand_raised', { attempt: 1, errand }, 'lead')])

describe('the review wait', () => {
  test('an Errand the screen turns away because it asks for a review moves the Issue to wait on the pull request', () => {
    const issue = drive(
      [
        ev(
          'errand_done',
          { errand: 'errand_1', turnedAway: 'wait for the reviewer', awaits: { review: '#91' } },
          'factory',
        ),
      ],
      raised(),
    )
    expect(issue).toMatchObject({
      state: 'waiting',
      wait: { reason: 'external', holds: { id: '#91' }, since: 6, told: 5 },
    })
  })

  test('the poll wakes it and the lead hears the turn-away and what the reviewer did together', () => {
    const waiting = drive(
      [ev('errand_done', { errand: 'errand_1', turnedAway: 'wait', awaits: { review: '#91' } }, 'judge')],
      raised(),
    )
    const since = waiting.wait?.since ?? 0
    const woken = apply(waiting, ev('woken', { since, detail: '#91: the pull request was approved' }, 'factory'), {
      now: NOW,
    })
    expect(woken.result).toBe('applied')
    if (woken.result !== 'applied') return
    expect(woken.issue.state).toBe('working')
    expect(woken.effects.map((effect) => String(effect.key))).toEqual(['note_lead:issue_9:7'])
    // the note covers everything after what the lead had heard: the turn-away (version 6) and the wake (version 7)
    const note = noteText(ID, [
      {
        kind: 'errand_done',
        payload: { errand: 'errand_1', turnedAway: 'wait', awaits: { review: '#91' } },
        actor: 'judge',
        at: NOW,
        version: 5,
      },
      {
        kind: 'woken',
        payload: { since, detail: '#91: the pull request was approved' },
        actor: 'factory',
        at: NOW,
        version: 6,
      },
    ])
    expect(note).toContain('waits on the review of "#91"')
    expect(note).toContain('your wait is over: "#91: the pull request was approved"')
  })

  test('a wake of an older wait changes nothing, and a person cannot answer the wait with a done', () => {
    const waiting = drive(
      [ev('errand_done', { errand: 'errand_1', turnedAway: 'wait', awaits: { review: '#91' } }, 'factory')],
      raised(),
    )
    expect(apply(waiting, ev('woken', { since: 1, detail: 'late' }, 'factory'), { now: NOW }).result).toBe('ignored')
    expect(apply(waiting, ev('errand_done', { errand: 'errand_1' }, 'owner'), { now: NOW }).result).toBe('ignored')
  })

  test('a lead defers on a review itself; the steward may not', () => {
    const lead = drive([
      ...working,
      ev('deferred', { attempt: 1, review: 'https://github.example/o/r/pull/91' }, 'lead'),
    ])
    expect(lead).toMatchObject({
      state: 'waiting',
      wait: { reason: 'external', holds: { id: 'https://github.example/o/r/pull/91' } },
    })
    expect(apply(drive(working), ev('deferred', { attempt: 1, review: '#91' }, 'steward'), { now: NOW }).result).toBe(
      'refused',
    )
  })

  test('a wait on a review frees the repo claim like the other waits on someone else', async () => {
    const { holdsClaim } = await import('../../src/domains/capacity/claims.ts')
    expect(holdsClaim('waiting', 'external')).toBe(false)
  })
})

describe('a turn back', () => {
  test('the owner and the orchestrator end an Errand wait, and the lead hears the note', () => {
    for (const actor of ['owner', 'orchestrator'] as const) {
      const decided = apply(
        raised(),
        ev('errand_turned_back', { errand: 'errand_1', note: 'merge it yourself' }, actor),
        {
          now: NOW,
        },
      )
      expect(decided.result).toBe('applied')
      if (decided.result !== 'applied') return
      expect(decided.issue.state).toBe('working')
      expect(decided.effects.map((effect) => effect.kind)).toEqual(['note_lead'])
    }
    const note = noteText(ID, [
      {
        kind: 'errand_turned_back',
        payload: { errand: 'errand_1', note: 'merge it yourself' },
        actor: 'orchestrator',
        at: NOW,
        version: 5,
      },
    ])
    expect(note).toContain('was turned back by the owner, not done: "merge it yourself"')
  })

  test('a lead cannot send it, and the orchestrator still cannot finish an Errand', () => {
    const decided = apply(raised(), ev('errand_turned_back', { errand: 'errand_1', note: 'x' }, 'lead'), { now: NOW })
    expect(decided.result).toBe('refused')
    expect(apply(raised(), ev('errand_done', { errand: 'errand_1' }, 'orchestrator'), { now: NOW }).result).toBe(
      'refused',
    )
  })
})
