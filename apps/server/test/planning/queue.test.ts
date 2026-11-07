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
})
