import { describe, expect, test } from 'bun:test'
import { type LegacyDecision, type LegacyEvent, type LegacyIssue, planIssue } from '../../scripts/import/plan.ts'

const T0 = Date.parse('2026-11-01T10:00:00Z')
const at = (minutes: number): Date => new Date(T0 + minutes * 60_000)

const issue = (over: Partial<LegacyIssue> = {}): LegacyIssue => ({
  id: 7,
  state: 'closed',
  reason: null,
  source: 'request',
  sourceKey: 'request:7',
  repo: '/Users/example/SourceRoot/example',
  title: 'the probe fails',
  facts: { why: 'it pages at night' },
  kind: 'bug',
  outcome: 'done',
  attempt: 1,
  createdAt: at(0),
  closedAt: at(60),
  ...over,
})

let n = 0
const ev = (
  kind: string,
  minutes: number,
  over: Partial<LegacyEvent> & { payload?: Record<string, unknown> | null } = {},
): LegacyEvent => ({
  id: ++n,
  kind,
  from: null,
  to: null,
  at: at(minutes),
  payload: null,
  ...over,
})

const decision = (over: Partial<LegacyDecision> = {}): LegacyDecision => ({
  id: 3,
  question: 'Delete the proxy?',
  options: ['delete', 'keep'],
  defaultOption: 'keep',
  expiresAt: at(120),
  answer: null,
  answeredBy: null,
  answeredAt: null,
  createdAt: at(10),
  ...over,
})

describe('planIssue', () => {
  test('a shipped and verified Issue closes done, with its ship, evidence, watch and check', () => {
    const events = [
      ev('created', 0, { to: 'queued', payload: { source: 'request' } }),
      ev('admitted', 5, { from: 'queued', to: 'working' }),
      ev('ship', 30, {
        from: 'working',
        to: 'watching',
        payload: {
          attempt: 1,
          commits: ['a'.repeat(40)],
          derived: {
            commits: ['a'.repeat(40)],
            paths: ['src/a.ts', 'docs/a.md'],
            landedAt: 'b'.repeat(40),
            mergedAt: null,
            holdMs: 0,
            review: null,
          },
        },
      }),
      ev('verified', 50, {
        from: 'watching',
        to: 'closed',
        payload: { checks: [{ ok: true, name: 'make verify', detail: 'ok' }] },
      }),
    ]
    const plan = planIssue(issue(), events, [])
    expect(plan.issue).toMatchObject({ id: 'issue_7', state: 'closed', outcome: 'done', attempt: 1, watch: 1 })
    expect(plan.entries.every((e) => e.decided.result === 'applied')).toBe(true)
    expect(plan.ships).toEqual([
      expect.objectContaining({ result: 'accepted', attempt: 1, reported: ['a'.repeat(40)] }),
    ])
    expect(plan.evidence.map((e) => e.kind).sort()).toEqual(['commits', 'review'])
    expect(plan.evidence.find((e) => e.kind === 'commits')?.payload).toMatchObject({
      deploys: true,
      landedAt: 'b'.repeat(40),
    })
    expect(plan.evidence.find((e) => e.kind === 'review')?.payload).toMatchObject({ status: 'unknown' })
    expect(plan.watches).toEqual([expect.objectContaining({ answer: 'passed', watch: 1 })])
    expect(plan.checks).toEqual([expect.objectContaining({ outcome: 'green', n: 1 })])
  })

  test('the same rows give the same plan, key for key', () => {
    const events = [ev('created', 0), ev('admitted', 5), ev('close', 30, { payload: { summary: 'done' } })]
    const a = planIssue(issue(), events, [])
    const b = planIssue(issue(), events, [])
    expect(a.entries.map((e) => e.key)).toEqual(b.entries.map((e) => e.key))
    expect(new Set(a.entries.map((e) => e.key)).size).toBe(a.entries.length)
  })

  test('a decision wait: the Decision row is written, the answer ends the wait, the claim wake is dropped', () => {
    const events = [
      ev('created', 0),
      ev('admitted', 5),
      ev('ask', 10, {
        from: 'working',
        to: 'waiting',
        payload: { attempt: 1, question: 'Delete the proxy?', options: ['delete', 'keep'], default: 'keep' },
      }),
      ev('answer', 20, { from: 'waiting', to: 'waiting', payload: { who: 'owner', answer: 'delete', decision: 3 } }),
      ev('wake', 21, { from: 'waiting', to: 'working', payload: { for: 'claim' } }),
      ev('close', 40, { from: 'working', to: 'closed', payload: { summary: 'deleted' } }),
    ]
    const plan = planIssue(issue(), events, [decision({ answer: 'delete', answeredBy: 'owner', answeredAt: at(20) })])
    expect(plan.issue.state).toBe('closed')
    expect(plan.decisions).toHaveLength(1)
    expect(plan.decisions[0]).toMatchObject({
      id: 'decision_legacy-3',
      answer: 'delete',
      settledBy: 'owner',
      noAnswer: { default: 'keep' },
    })
    const wake = plan.dispositions.find((d) => d.kind === 'wake')
    expect(wake).toMatchObject({ disposition: 'dropped' })
    expect(plan.entries.every((e) => e.decided.result === 'applied')).toBe(true)
  })

  test('an Issue that waits on an open Decision is still waiting on it, with the Decision open', () => {
    const events = [
      ev('created', 0),
      ev('admitted', 5),
      ev('ask', 10, {
        from: 'working',
        to: 'waiting',
        payload: { attempt: 1, question: 'Delete the proxy?', options: ['delete', 'keep'] },
      }),
    ]
    const plan = planIssue(issue({ state: 'waiting', reason: 'decision', outcome: null, closedAt: null }), events, [
      decision(),
    ])
    expect(plan.issue).toMatchObject({
      state: 'waiting',
      wait: { reason: 'decision', holds: { id: 'decision_legacy-3' } },
    })
    expect(plan.decisions[0]).toMatchObject({ answer: null, answeredAt: null, withdrawnAt: null })
  })

  test('a note that woke a decision wait in the old core ends it as an answer, and the Decision is withdrawn', () => {
    const events = [
      ev('created', 0),
      ev('admitted', 5),
      ev('ask', 10, { from: 'working', to: 'waiting', payload: { attempt: 1, question: 'q?', options: ['a', 'b'] } }),
      ev('note', 15, { from: 'waiting', to: 'working', payload: { who: 'owner', text: 'carry on' } }),
    ]
    const plan = planIssue(issue({ state: 'working', reason: null, outcome: null, closedAt: null }), events, [
      decision(),
    ])
    expect(plan.issue.state).toBe('working')
    expect(plan.decisions[0]?.withdrawnAt).toEqual(at(15))
    expect(plan.notes.join(' ')).toContain('decision wait was ended by note')
  })

  test("a timed wait wakes by the clock and a stop is the owner's cancel", () => {
    const events = [
      ev('created', 0),
      ev('admitted', 5),
      ev('wait', 10, { from: 'working', to: 'waiting', payload: { until: at(30).toISOString(), attempt: 1 } }),
      ev('wake', 31, { from: 'waiting', to: 'working', payload: { for: 'wait' } }),
      ev('stop', 40, { from: 'working', to: 'closed', payload: { reason: 'not needed' } }),
    ]
    const plan = planIssue(issue({ outcome: 'dropped' }), events, [])
    expect(plan.issue).toMatchObject({ state: 'closed', outcome: 'cancelled' })
    expect(plan.entries.filter((e) => e.event.kind === 'woken')).toHaveLength(1)
  })

  test('a regression sends the lead back; the third one is a stall', () => {
    const shipped = (m: number) =>
      ev('ship', m, { from: 'working', to: 'watching', payload: { attempt: 1, derived: { commits: [] } } })
    const regress = (m: number, to = 'working') =>
      ev('regression', m, {
        from: 'watching',
        to,
        payload: { title: 'deployed version', checks: [{ ok: false, name: 'x', detail: 'red' }] },
      })
    const events = [
      ev('created', 0),
      ev('admitted', 1),
      shipped(2),
      regress(3),
      shipped(4),
      regress(5),
      shipped(6),
      regress(7, 'waiting'),
    ]
    const plan = planIssue(issue({ state: 'waiting', reason: 'parked', outcome: null, closedAt: null }), events, [])
    expect(plan.issue).toMatchObject({ state: 'waiting', wait: { reason: 'regressed' }, regressions: 3 })
    expect(plan.watches.map((w) => w.answer)).toEqual(['regressed', 'regressed', 'regressed'])
  })

  test('an old close the new machine would not take is closed by force, and says so', () => {
    const events = [
      ev('created', 0),
      ev('admitted', 5),
      ev('ask', 10, { from: 'working', to: 'waiting', payload: { attempt: 1, question: 'q?', options: ['a', 'b'] } }),
      ev('drop', 20, { from: 'waiting', to: 'closed', payload: { reason: 'gave up' } }),
    ]
    const plan = planIssue(issue({ outcome: 'dropped' }), events, [decision()])
    expect(plan.issue).toMatchObject({ state: 'closed', outcome: 'cancelled' })
    expect(plan.entries.at(-1)?.key).toContain('forced-close')
    expect(plan.notes.join(' ')).toContain('closed by force')
    expect(plan.dispositions.find((d) => d.kind === 'drop')?.reason).toContain('machine: closed refused')
  })

  test('every event is accounted for: mapped, folded or dropped with a reason, and an unknown kind says so', () => {
    const events = [
      ev('created', 0),
      ev('classified', 1, { payload: { kind: 'bug' } }),
      ev('hold_over', 2),
      ev('prio', 3, { payload: { value: 5, who: 'owner' } }),
      ev('mystery', 4),
    ]
    const plan = planIssue(issue({ state: 'queued', outcome: null, closedAt: null }), events, [])
    expect(plan.dispositions.map((d) => [d.kind, d.disposition])).toEqual([
      ['created', 'mapped'],
      ['classified', 'dropped'],
      ['hold_over', 'dropped'],
      ['prio', 'folded'],
      ['mystery', 'dropped'],
    ])
    expect(plan.dispositions.every((d) => d.disposition === 'mapped' || d.reason)).toBe(true)
    expect(plan.prios).toEqual([expect.objectContaining({ value: 5, actor: 'owner' })])
    expect(plan.notes.join(' ')).toContain('unknown old event kind mystery')
  })

  test('the origin and the repo follow the new words', () => {
    const plan = planIssue(
      issue({ source: 'alert', sourceKey: 'hyperdx:x:1', state: 'queued', outcome: null, closedAt: null }),
      [ev('created', 0)],
      [],
    )
    expect(plan.entries[0]?.event.payload).toMatchObject({ repo: 'example', origin: 'application', kind: 'bug' })
  })
})
