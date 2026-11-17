import { describe, expect, test } from 'bun:test'
import { cycleThrough, type Edge, newlySatisfied, openBlockers } from '../../src/domains/planning/chain.ts'
import { type OpenIssue, orderQueue, stoppedProjects } from '../../src/domains/planning/queue.ts'
import { type IssueId, issueId } from '../../src/kernel/ids.ts'

const id = (n: number): IssueId => issueId(n)
const issue = (n: number, extra: Partial<OpenIssue> = {}): OpenIssue => ({
  id: id(n),
  project: 'app',
  kind: 'feature',
  state: 'queued',
  waitReason: null,
  finalizing: false,
  specPending: false,
  ...extra,
})
const edge = (from: number, to: number, satisfied = false): Edge => ({ issue: id(from), after: id(to), satisfied })
const order = (open: OpenIssue[], edges: Edge[] = [], prio: [number, number][] = []) =>
  orderQueue({ open, edges, prio: new Map(prio.map(([n, v]) => [id(n), v])) }).map((row) => [
    issueNumber(row.issue.id),
    row.reason?.kind ?? null,
  ])
const issueNumber = (value: IssueId) => Number(value.slice('issue_'.length))

describe('the chain', () => {
  test('an edge is open until its blocker closed; a satisfied edge holds nobody back', () => {
    const edges = [edge(3, 1), edge(3, 2, true)]
    expect(openBlockers(edges, id(3))).toEqual([id(1)])
    expect(newlySatisfied(edges, new Set([id(1), id(2)])).map((e) => e.after)).toEqual([id(1)])
  })

  test('an edge that closes a cycle is found with its path, through open edges only', () => {
    const edges = [edge(2, 1), edge(3, 2)]
    expect(cycleThrough(edges, id(1), id(3))).toEqual([id(3), id(2), id(1)])
    expect(cycleThrough(edges, id(4), id(3))).toBeUndefined()
    expect(cycleThrough(edges, id(1), id(1))).toBeDefined()
    expect(cycleThrough([edge(2, 1, true), edge(3, 2)], id(1), id(3))).toBeUndefined()
  })
})

describe('the queue order within a priority and a project, for throughput', () => {
  const NOW = new Date('2026-11-17T12:00:00Z')
  const aged = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000)
  const sorted = (open: OpenIssue[], extra: Partial<Parameters<typeof orderQueue>[0]> = {}) =>
    orderQueue({ open, edges: [], prio: new Map(), now: NOW, ...extra }).map((row) => issueNumber(row.issue.id))

  test('what finishes sooner starts first: small, then medium or unsized, then large', () => {
    expect(
      sorted([
        issue(1, { size: 'large', since: NOW }),
        issue(2, { size: 'small', since: NOW }),
        issue(3, { size: null, since: NOW }),
        issue(4, { size: 'medium', since: NOW }),
      ]),
    ).toEqual([2, 3, 4, 1])
  })

  test('ageing: every 6 hours waited moves an Issue up one size, so a large one is not starved', () => {
    const large = (hours: number) => issue(1, { size: 'large', since: aged(hours) })
    const small = issue(2, { size: 'small', since: NOW })
    expect(sorted([large(5), small])).toEqual([2, 1])
    expect(sorted([large(12), small])).toEqual([1, 2])
    expect(sorted([issue(3, { size: 'medium', since: aged(6) }), small])).toEqual([2, 3])
    expect(sorted([issue(3, { size: 'medium', since: aged(6) }), issue(2, { size: 'small', since: aged(1) })])).toEqual(
      [2, 3],
    )
  })

  test("the owner's prio stays absolute: a larger Issue of a higher prio still goes first", () => {
    expect(sorted([issue(1, { size: 'large' }), issue(2, { size: 'small' })], { prio: new Map([[id(1), 3]]) })).toEqual(
      [1, 2],
    )
  })

  test("the model's order breaks a tie of equal size and never moves a larger Issue ahead of a smaller one", () => {
    const open = [
      issue(1, { size: 'medium' }),
      issue(2, { size: 'medium' }),
      issue(3, { size: 'large' }),
      issue(4, { size: 'small' }),
    ]
    const modelOrder = new Map([
      [id(3), 0],
      [id(2), 1],
      [id(1), 2],
    ])
    expect(sorted(open, { modelOrder })).toEqual([4, 2, 1, 3])
    expect(sorted(open)).toEqual([4, 1, 2, 3])
  })

  test('only the places inside one project and prio are exchanged: other projects keep their places, a blocked Issue stays behind', () => {
    const open = [
      issue(1, { project: 'a', size: 'large' }),
      issue(2, { project: 'b', size: 'large' }),
      issue(3, { project: 'a', size: 'small' }),
      issue(4, { project: 'b', size: 'small' }),
      issue(5, { project: 'a', size: 'small' }),
    ]
    // by number the places are a b a b a; each project's own Issues sort among themselves inside those places
    expect(sorted(open)).toEqual([3, 4, 5, 2, 1])
    expect(
      orderQueue({ open, edges: [edge(5, 99)], prio: new Map(), now: NOW }).map((r) => issueNumber(r.issue.id)),
    ).toEqual([3, 4, 1, 2, 5])
  })
})

describe('the queue order', () => {
  test('age within equal priority: the lower Issue number first', () => {
    expect(order([issue(5), issue(2), issue(9)])).toEqual([
      [2, null],
      [5, null],
      [9, null],
    ])
  })

  test("the owner's prio orders before age, higher first, negative last", () => {
    expect(
      order(
        [issue(1), issue(2), issue(3)],
        [],
        [
          [3, 10],
          [1, -5],
        ],
      ),
    ).toEqual([
      [3, null],
      [2, null],
      [1, null],
    ])
  })

  test('an incident goes before prio and age', () => {
    expect(order([issue(1, { project: 'a' }), issue(2, { kind: 'incident', project: 'b' })], [], [[1, 1000]])).toEqual([
      [2, null],
      [1, null],
    ])
  })

  test('an Issue with an open blocker is no candidate: it follows the others and names what it waits for', () => {
    const rows = orderQueue({ open: [issue(1), issue(2)], edges: [edge(1, 9)], prio: new Map() })
    expect(rows.map((r) => r.issue.id)).toEqual([id(2), id(1)])
    expect(rows[1]?.reason).toMatchObject({ kind: 'chain', message: 'waits for Issue 9 to close', waitsFor: [id(9)] })
  })

  test('an inferred edge says by whom and why in the wait reason; a stated one stays plain', () => {
    const inferred: Edge = { ...edge(1, 9), inferredBy: 'triage: builds on its registry' }
    const rows = orderQueue({ open: [issue(1)], edges: [inferred, edge(1, 8)], prio: new Map() })
    expect(rows[0]?.reason).toMatchObject({
      kind: 'chain',
      message: 'waits for Issue 9 (inferred by triage: builds on its registry), Issue 8 to close',
    })
  })

  test('stop the line: while an incident is queued or working in a project, only fixes are candidates there', () => {
    const open = [
      issue(1),
      issue(2, { kind: 'incident' }),
      issue(3, { project: 'other' }),
      issue(4, { kind: 'incident', state: 'working' }),
    ]
    const rows = orderQueue({ open, edges: [], prio: new Map() })
    expect(rows.map((r) => [issueNumber(r.issue.id), r.reason?.kind ?? null])).toEqual([
      [2, null],
      [3, null],
      [1, 'line'],
    ])
    expect(rows.find((r) => r.issue.id === id(1))?.reason?.message).toContain('production of app is red')
  })

  test('a waiting incident stops nothing, and neither does one a blocker holds', () => {
    const waiting = [issue(1), issue(2, { kind: 'incident', state: 'waiting', waitReason: 'decision' })]
    expect(stoppedProjects(waiting, []).size).toBe(0)
    const blocked = [issue(1), issue(2, { kind: 'incident' })]
    expect(stoppedProjects(blocked, [edge(2, 7)]).size).toBe(0)
  })

  test('a project nobody knows and an attempt still finalizing stay queued with those reasons', () => {
    const rows = orderQueue({
      open: [issue(1, { project: null }), issue(2, { finalizing: true })],
      edges: [],
      prio: new Map(),
    })
    expect(rows.map((r) => r.reason?.kind)).toEqual(['unknown_project', 'finalizing'])
  })

  test('an Issue whose filed Spec has no verdict stays queued behind the others, and its blocker is named first', () => {
    expect(order([issue(1, { specPending: true }), issue(2)])).toEqual([
      [2, null],
      [1, 'spec'],
    ])
    // Higher prio does not lift a held Issue over a free one: a reason ranks below every candidate.
    expect(order([issue(1, { specPending: true }), issue(2)], [], [[1, 5]])).toEqual([
      [2, null],
      [1, 'spec'],
    ])
    expect(order([issue(3, { specPending: true }), issue(4)], [edge(3, 9)])).toEqual([
      [4, null],
      [3, 'chain'],
    ])
  })

  test('a held Issue is released into the chain as it was: the same edges still hold it back afterwards', () => {
    const edges = [edge(1, 9)]
    expect(order([issue(1)], edges)).toEqual([[1, 'chain']])
    expect(order([issue(1, { specPending: true })], edges)).toEqual([[1, 'chain']])
    expect(order([issue(1)], [])).toEqual([[1, null]])
  })

  test('an incident held by its filed Spec stops no line: nothing could run it yet', () => {
    expect(order([issue(1, { kind: 'incident', specPending: true }), issue(2)])).toEqual([
      [2, null],
      [1, 'spec'],
    ])
  })
})
