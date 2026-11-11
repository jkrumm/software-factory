import { expect, test } from 'bun:test'
import type { ChainEdge, ChainNode } from '@software-factory/contract'
import { seededChain } from '../../../tests/e2e/seed-scale-chain.ts'
import { chainOf } from '../src/lib/chain.ts'
import { layoutOf } from '../src/lib/chain-layout.ts'
import { COLLAPSE_ABOVE, collapseOf, DONE_BUDGET, READY_BUDGET, STEP_CAP, toggled } from '../src/lib/chain-collapse.ts'

const node = (id: string, repo: string, kind: 'issue' | 'row', state: string): ChainNode => ({
  id,
  repo,
  kind,
  state,
  title: id,
  issueKind: 'feature',
  since: kind === 'issue' ? '2026-11-08T00:00:00.000Z' : null,
  waitReason: null,
  notBefore: null,
})

const whole = () => chainOf(seededChain())

test('a chain of 60 nodes or fewer is drawn whole', () => {
  const small = chainOf(seededChain(10, 2))
  expect(small.nodes.length).toBeLessThanOrEqual(COLLAPSE_ABOVE)
  const view = collapseOf(small)
  expect(view.groups).toEqual([])
  expect(view.nodes).toEqual(small.nodes)
  expect(view.edges).toEqual(small.edges)
})

test('400 nodes in one project open as about 40 nodes plus a few groups', () => {
  const full = whole()
  expect(full.nodes.length).toBe(400)
  const view = collapseOf(full)
  expect(view.nodes.length).toBeLessThanOrEqual(40)
  expect(view.groups.length).toBeGreaterThanOrEqual(2)
  expect(view.groups.length).toBeLessThanOrEqual(STEP_CAP + 2)
  expect(view.nodes.length + view.folded + view.dropped).toBe(400)
  // the open Issues and the rows that may file now are all there
  const ids = view.nodes.map((n) => n.id)
  for (let i = 0; i < 5; i++) expect(ids).toContain(`issue_${100 + i}`)
  for (let i = 0; i < 3; i++) expect(ids).toContain(`row:basalt-ui:ready-${i}`)
  // the closed Issues beside them stay within the budget
  expect(view.nodes.filter((n) => n.state === 'closed').length).toBeLessThanOrEqual(DONE_BUDGET)
})

test('a group counts its rows and names the earliest date', () => {
  const view = collapseOf(whole())
  const first = view.groups.find((g) => g.bucket === 'step-1')
  expect(first?.members.length).toBe(44)
  expect(first?.earliest).toBe('2026-12-11T09:00:00Z')
  const steps = view.groups.filter((g) => g.step !== null).map((g) => g.step)
  expect(steps).toEqual([...steps].sort())
  expect(view.groups.every((g) => g.id.startsWith('group:basalt-ui:'))).toBe(true)
})

test('rows further out than the cap share the last group', () => {
  const view = collapseOf(chainOf(seededChain(352, 8)))
  const last = view.groups.find((g) => g.bucket === `step-${STEP_CAP}`)
  expect(last?.members.length).toBe((8 - STEP_CAP + 1) * 44)
  expect(view.groups.some((g) => (g.step ?? 0) > STEP_CAP)).toBe(false)
})

test('every edge of the collapsed view joins things that are drawn, none twice', () => {
  const view = collapseOf(whole())
  const ids = new Set([...view.nodes.map((n) => n.id), ...view.groups.map((g) => g.id)])
  const seen = new Set<string>()
  for (const edge of view.edges) {
    expect(ids.has(edge.from)).toBe(true)
    expect(ids.has(edge.to)).toBe(true)
    expect(edge.from).not.toBe(edge.to)
    const key = `${edge.to}>${edge.from}`
    expect(seen.has(key)).toBe(false)
    seen.add(key)
  }
  // the first step waits for an open Issue: an edge runs from the group to that Issue
  const first = view.groups.find((g) => g.bucket === 'step-1')
  expect(view.edges).toContainEqual({ from: first?.id ?? '', to: 'issue_104', closed: false })
})

test('expanding a group draws its members and nothing else changes', () => {
  const collapsed = collapseOf(whole())
  const target = collapsed.groups.find((g) => g.bucket === 'step-2')
  if (!target) throw new Error('no step-2 group')
  const open = collapseOf(whole(), toggled(new Set(), target.id))
  expect(open.groups.some((g) => g.id === target.id)).toBe(false)
  expect(open.groups.length).toBe(collapsed.groups.length - 1)
  expect(open.nodes.length).toBe(collapsed.nodes.length + target.members.length)
  expect(open.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(target.members.map((m) => m.id)))
  expect(open.nodes.length + open.folded + open.dropped).toBe(400)
  expect(toggled(new Set([target.id]), target.id).size).toBe(0)
})

test('the closed Issues beside the done group open with it', () => {
  const collapsed = collapseOf(whole())
  const done = collapsed.groups.find((g) => g.bucket === 'done')
  expect(done).toBeDefined()
  const open = collapseOf(whole(), new Set([done?.id ?? '']))
  expect(open.groups.some((g) => g.bucket === 'done')).toBe(false)
  expect(open.nodes.length).toBeGreaterThan(collapsed.nodes.length)
})

test('rows that may file now past the budget are grouped', () => {
  const nodes: ChainNode[] = [node('issue_1', 'a', 'issue', 'working')]
  const edges: ChainEdge[] = []
  for (let i = 0; i < READY_BUDGET + 50; i++) {
    nodes.push(node(`row:a:r${i}`, 'a', 'row', 'filable'))
    edges.push({ from: `row:a:r${i}`, to: 'issue_1', closed: true })
  }
  const view = collapseOf(chainOf({ nodes, edges }))
  expect(view.nodes.filter((n) => n.kind === 'row').length).toBe(READY_BUDGET)
  expect(view.groups.map((g) => [g.bucket, g.members.length])).toEqual([['ready', 50]])
})

test('projects fold separately and a group of one is the node itself', () => {
  const chain = seededChain()
  const other = [node('row:orion:lonely', 'orion', 'row', 'waiting'), node('issue_900', 'orion', 'issue', 'working')]
  const view = collapseOf(
    chainOf({
      nodes: [...chain.nodes, ...other],
      edges: [...chain.edges, { from: 'row:orion:lonely', to: 'issue_900', closed: false }],
    }),
  )
  expect(view.nodes.map((n) => n.id)).toContain('row:orion:lonely')
  expect(view.groups.every((g) => g.repo === 'basalt-ui')).toBe(true)
})

test('the collapsed view lays out in well under 100 ms, the whole 400 in under a second', () => {
  const collapsed = collapseOf(whole())
  const t0 = performance.now()
  layoutOf([...collapsed.nodes, ...collapsed.groups], collapsed.edges)
  const ms = performance.now() - t0
  console.log(`layout of ${collapsed.nodes.length + collapsed.groups.length} nodes: ${ms.toFixed(0)} ms`)
  expect(ms).toBeLessThan(100)
})
