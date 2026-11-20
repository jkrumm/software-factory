import { expect, test } from 'bun:test'
import type { QueueAnswer } from '@software-factory/contract'
import { type HeldEdge, OWNER_WAIT_MS, sweepEdges } from '../../src/domains/planning/edge-need.ts'
import { EDGE_STOP_MIN, type EdgeNeed, notNeededShare, stopsEdges } from '../../src/kernel/edge-need.ts'
import { checkQueue, pairKey, type QueueIssue } from '../../src/domains/planning/queue-edges.ts'
import type { IssueId } from '../../src/kernel/ids.ts'

const id = (n: number) => `issue_${n}` as IssueId
const NOW = new Date('2026-11-17T12:00:00Z')
const held = (over: Partial<HeldEdge> = {}): HeldEdge => ({
  issue: id(2),
  after: id(1),
  inferredBy: 'queue: the same files',
  issueState: 'queued',
  blockerState: 'working',
  blockerWait: null,
  blockerSince: new Date('2026-11-17T09:00:00Z'),
  issuePaths: null,
  blockerPaths: null,
  ...over,
})

test('an edge whose Issues both shipped and share no file is taken back, the shared aggregator and lockfiles do not count', () => {
  const removals = sweepEdges(
    [
      held({
        issuePaths: ['a.ts', 'docs/plan.yaml', 'bun.lock'],
        blockerPaths: ['b.ts', 'docs/plan.yaml', 'bun.lock'],
      }),
    ],
    NOW,
  )
  expect(removals).toMatchObject([{ issue: id(2), after: id(1), kind: 'disjoint' }])
  expect(removals[0]?.reason).toContain('disjoint')
})

test('a shared file keeps the edge; an Issue that shipped nothing is no evidence', () => {
  expect(sweepEdges([held({ issuePaths: ['a.ts'], blockerPaths: ['a.ts', 'b.ts'] })], NOW)).toEqual([])
  expect(sweepEdges([held({ issuePaths: ['a.ts'], blockerPaths: null })], NOW)).toEqual([])
  expect(sweepEdges([held({ issuePaths: null, blockerPaths: ['b.ts'] })], NOW)).toEqual([])
})

test('a blocker that waited on the owner past the limit releases the edge; a shorter wait or a machine wait does not', () => {
  const since = (ms: number) => new Date(NOW.getTime() - ms)
  const waiting = (wait: string, ms: number) =>
    held({ blockerState: 'waiting', blockerWait: wait, blockerSince: since(ms) })
  expect(sweepEdges([waiting('decision', OWNER_WAIT_MS + 60_000)], NOW)).toMatchObject([{ kind: 'owner_wait' }])
  expect(sweepEdges([waiting('review', OWNER_WAIT_MS + 60_000)], NOW)).toMatchObject([{ kind: 'owner_wait' }])
  expect(sweepEdges([waiting('errand', OWNER_WAIT_MS + 60_000)], NOW)).toMatchObject([{ kind: 'owner_wait' }])
  expect(sweepEdges([waiting('decision', OWNER_WAIT_MS - 60_000)], NOW)).toEqual([])
  expect(sweepEdges([waiting('timer', OWNER_WAIT_MS * 4)], NOW)).toEqual([])
  expect(sweepEdges([waiting('wall', OWNER_WAIT_MS * 4)], NOW)).toEqual([])
  expect(sweepEdges([waiting('decision', 3_600_000)], NOW, { ownerWaitMs: 1_800_000 })).toMatchObject([
    { kind: 'owner_wait' },
  ])
})

test('only an edge somebody inferred and only a queued Issue is swept', () => {
  const old = {
    blockerState: 'waiting',
    blockerWait: 'decision',
    blockerSince: new Date(NOW.getTime() - 99 * 3_600_000),
  }
  expect(sweepEdges([held({ ...old, inferredBy: '' })], NOW)).toEqual([])
  expect(sweepEdges([held({ ...old, issueState: 'working' })], NOW)).toEqual([])
})

const need = (over: Partial<EdgeNeed> = {}): EdgeNeed => ({
  source: 'queue',
  added: 20,
  needed: 2,
  notNeeded: 10,
  unknown: 8,
  removed: 0,
  ...over,
})

test('the share counts only measured edges; no measured edge has no share', () => {
  expect(notNeededShare(need())).toBeCloseTo(10 / 12)
  expect(notNeededShare(need({ needed: 0, notNeeded: 0 }))).toBeNull()
})

test('a source is stopped only when enough edges were measured and most were not needed', () => {
  expect(stopsEdges(need())).toBe(true)
  expect(stopsEdges(need({ notNeeded: EDGE_STOP_MIN - 3, needed: 2 }))).toBe(false)
  expect(stopsEdges(need({ notNeeded: 6, needed: 6 }))).toBe(false)
  expect(stopsEdges(need({ notNeeded: 7, needed: 5 }))).toBe(false)
  expect(stopsEdges(need({ notNeeded: 8, needed: 4 }))).toBe(true)
  expect(stopsEdges(undefined)).toBe(false)
})

const row = (n: number, over: Partial<QueueIssue> = {}): QueueIssue => ({
  id: id(n),
  repo: 'app',
  title: `Issue ${n}`,
  kind: 'feature',
  state: 'queued',
  prio: 0,
  size: null,
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

test('the queue loop adds no edge while its own kind is stopped, and never a pair it took back', () => {
  const rows = [row(1), row(2), row(3)]
  const stopped = checkQueue(rows, answer([2, 1]), { stopped: 'queue edges are mostly not needed' })
  expect(stopped.accepted).toEqual([])
  expect(stopped.refused).toMatchObject([{ why: 'queue edges are mostly not needed' }])

  const removed = checkQueue(rows, answer([2, 1], [3, 1]), { removed: new Set([pairKey(id(2), id(1))]) })
  expect(removed.accepted.map((e) => e.issue)).toEqual([id(3)])
  expect(removed.refused).toMatchObject([{ issue: id(2), why: 'the loop took this edge back already' }])
})
