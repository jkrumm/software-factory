import { expect, test } from 'bun:test'
import type { ChainEdge, ChainModel } from '@software-factory/contract'
import { chainOf, edgeText, isBlocked, isolatedNote, issueNumber, projectsOf, stateWord } from '../src/lib/chain.ts'
import { layoutOf } from '../src/lib/chain-layout.ts'

const node = (id: string, repo: string, title = id, kind: 'issue' | 'row' = 'issue', state = 'queued') => ({
  id,
  kind,
  repo,
  title,
  state,
})

// c waits for b waits for a; b also waits for the closed z; "solo" waits for nothing
const model: ChainModel = {
  at: '2026-11-08T00:00:00.000Z',
  nodes: [
    node('issue_1', 'argo', 'A'),
    node('issue_2', 'orion', 'B'),
    node('issue_3', 'argo', 'C'),
    node('issue_9', 'orion', 'Z', 'issue', 'closed'),
    node('issue_5', 'harbor', 'Solo'),
    node('row:harbor:next', 'harbor', 'Next', 'row', 'waiting'),
  ],
  edges: [
    { from: 'issue_2', to: 'issue_1', closed: false },
    { from: 'issue_3', to: 'issue_2', closed: false },
    { from: 'issue_2', to: 'issue_9', closed: true },
  ],
  blocking: {},
}

test('a linear chain lays out left to right, blockers first', () => {
  const view = chainOf(model)
  const at = layoutOf(view.nodes, view.edges)
  const x = (id: string) => at.get(id)?.x ?? Number.NaN
  expect(x('issue_1')).toBeLessThan(x('issue_2'))
  expect(x('issue_2')).toBeLessThan(x('issue_3'))
  expect(x('issue_9')).toBeLessThan(x('issue_2'))
})

test('an edge is blocked until its blocker has closed', () => {
  expect(model.edges.map(isBlocked)).toEqual([true, true, false])
})

test('nodes without an edge are counted, not drawn', () => {
  const view = chainOf(model)
  expect(view.nodes.map((n) => n.id).sort()).toEqual(['issue_1', 'issue_2', 'issue_3', 'issue_9'])
  expect(view.isolated).toBe(2)
  expect(isolatedNote(1)).toBe('1 item has no dependencies')
  expect(isolatedNote(2)).toBe('2 items have no dependencies')
})

test('a project keeps its nodes and the nodes an edge joins them to', () => {
  const view = chainOf(model, { project: 'orion' })
  expect(view.nodes.map((n) => n.id).sort()).toEqual(['issue_1', 'issue_2', 'issue_3', 'issue_9'])
  const harbor = chainOf(model, { project: 'harbor' })
  expect(harbor.nodes).toEqual([])
  expect(harbor.edges).toEqual([])
  expect(harbor.isolated).toBe(2)
  const argo = chainOf(model, { project: 'argo' })
  expect(argo.edges).toHaveLength(2)
  expect(argo.nodes.map((n) => n.id)).not.toContain('issue_9')
  expect(projectsOf(model)).toEqual(['argo', 'harbor', 'orion'])
})

test('words and links: no ids, a number for an Issue only', () => {
  expect(issueNumber(node('issue_12', 'argo'))).toBe('12')
  expect(issueNumber(node('row:argo:x', 'argo', 'X', 'row'))).toBeNull()
  expect(stateWord('filable')).toBe('Ready to file')
  expect(stateWord('settling')).toBe('Settling')
  const byId = new Map(model.nodes.map((n) => [n.id, n]))
  expect(edgeText(model.edges[0] as ChainEdge, byId)).toBe('A blocks B')
  expect(edgeText(model.edges[2] as ChainEdge, byId)).toBe('Z is done, B no longer waits for it')
})
