import { expect, test } from 'bun:test'
import type { QueueAnswer } from '@software-factory/contract'
import {
  candidatesOf,
  checkQueue,
  cycleIn,
  MAX_EDGES_PER_ISSUE,
  MAX_EDGES_PER_PASS,
  type QueueIssue,
  requestOf,
  shapeOf,
} from '../../src/domains/loops/queue.ts'
import type { IssueId } from '../../src/kernel/ids.ts'

const id = (n: number) => `issue_${n}` as IssueId
const row = (n: number, over: Partial<QueueIssue> = {}): QueueIssue => ({
  id: id(n),
  repo: 'app',
  title: `Issue ${n}`,
  kind: 'feature',
  state: 'queued',
  prio: 0,
  filedAt: new Date('2026-11-08T10:00:00Z'),
  summary: '',
  blockers: [],
  ...over,
})
const answer = (...edges: [number, number][]): QueueAnswer => ({
  edges: edges.map(([a, b]) => ({ issue: id(a), after: id(b), reason: 'same files' })),
  order: [],
  reason: 'r',
})

test('candidates are the queued Issues that wait for nothing', () => {
  const rows = [row(1), row(2, { blockers: [id(1)] }), row(3, { state: 'working' }), row(4)]
  expect(candidatesOf(rows).map((r) => r.id)).toEqual([id(1), id(4)])
})

test('a cycle through the open edges is named as a path, none is null', () => {
  expect(
    cycleIn([row(1, { blockers: [id(2)] }), row(2, { blockers: [id(3)] }), row(3, { blockers: [id(1)] })]),
  ).toEqual([id(1), id(2), id(3), id(1)])
  expect(cycleIn([row(1, { blockers: [id(2)] }), row(2), row(3, { blockers: [id(2), id(9)] })])).toBeNull()
})

test('the shape ignores age, title and summary and follows prio, blockers and the context', () => {
  const base = [row(1), row(2), row(3, { state: 'working' })]
  const same = [row(1, { title: 'x', summary: 'y', filedAt: new Date(0) }), row(2), row(3, { state: 'working' })]
  expect(shapeOf(same)).toBe(shapeOf(base))
  expect(shapeOf(base)).toMatch(/^[0-9a-f]{16}$/)
  expect(shapeOf([row(1, { prio: 5 }), row(2), row(3, { state: 'working' })])).not.toBe(shapeOf(base))
  expect(shapeOf([row(1), row(2, { blockers: [id(1)] }), row(3, { state: 'working' })])).not.toBe(shapeOf(base))
  expect(shapeOf([row(1), row(2), row(3, { state: 'waiting' })])).not.toBe(shapeOf(base))
})

test('the request shows queued first, scrubs and cuts text, and counts the age in minutes', () => {
  const rows = [
    row(1, { state: 'working' }),
    row(2, { title: 'T'.repeat(700), summary: `token=abcdef123456 ${'s'.repeat(900)}` }),
  ]
  const request = requestOf(rows, new Date('2026-11-08T11:30:00Z'), (t) => t.replace(/token=\S+/g, 'token=[redacted]'))
  expect(request?.issues.map((i) => i.id)).toEqual([id(2), id(1)])
  const first = request?.issues[0]
  expect(first?.title).toHaveLength(500)
  expect(first?.summary).toHaveLength(600)
  expect(first?.summary).toContain('[redacted]')
  expect(first?.ageMinutes).toBe(90)
  expect(first?.size).toBeNull()
})

test('an edge between shown Issues is accepted', () => {
  const checked = checkQueue([row(1), row(2)], answer([2, 1]))
  expect(checked.accepted).toEqual([{ issue: id(2), after: id(1), reason: 'same files' }])
  expect(checked.refused).toEqual([])
})

test('edges that name an unshown Issue, themselves, a repeat or an existing edge are refused', () => {
  const rows = [row(1), row(2, { blockers: [id(1)] }), row(3), row(4, { state: 'working' })]
  const checked = checkQueue(rows, answer([9, 1], [3, 9], [3, 3], [2, 1], [3, 1], [3, 1], [4, 1]))
  expect(checked.accepted.map((e) => [e.issue, e.after])).toEqual([[id(3), id(1)]])
  expect(checked.refused.map((e) => e.why)).toEqual([
    'not a queued Issue that was shown',
    'the Issue to wait for was not shown',
    'an Issue cannot wait for itself',
    'the edge exists already',
    'named twice',
    'not a queued Issue that was shown',
  ])
})

test('the lower-ranked Issue never goes first against the owner: waiting for a lower prio is refused', () => {
  const rows = [row(1, { prio: 10 }), row(2, { prio: 1 }), row(3, { prio: 10 })]
  const checked = checkQueue(rows, answer([1, 2], [2, 1], [1, 3]))
  expect(checked.accepted.map((e) => [e.issue, e.after])).toEqual([
    [id(2), id(1)],
    [id(1), id(3)],
  ])
  expect(checked.refused).toEqual([{ issue: id(1), after: id(2), why: 'against the owner’s priority' }])
})

test('at most three edges per Issue and ten in a pass', () => {
  const many = Array.from({ length: 14 }, (_, i) => row(i + 1))
  const perIssue = checkQueue(many, answer([1, 2], [1, 3], [1, 4], [1, 5]))
  expect(perIssue.accepted).toHaveLength(MAX_EDGES_PER_ISSUE)
  expect(perIssue.refused[0]?.why).toBe('too many edges for one Issue')
  const all = checkQueue(many, answer(...Array.from({ length: 10 }, (_, i): [number, number] => [i + 2, 1]), [12, 13]))
  expect(all.accepted).toHaveLength(MAX_EDGES_PER_PASS)
  expect(all.refused).toHaveLength(1)
})
