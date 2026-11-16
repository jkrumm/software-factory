import { expect, test } from 'bun:test'
import type { ChainEdge } from '@software-factory/contract'
import { NODE_HEIGHT, NODE_WIDTH } from '../src/lib/chain.ts'
import { edgePath } from '../src/lib/chain-edge.ts'
import { edgeKey, layoutOf, portsOf } from '../src/lib/chain-layout.ts'

// an edge runs from the node that waits (`from`) to its blocker (`to`)
const edge = (from: string, to: string, closed = false): ChainEdge => ({ from, to, closed })
const nodesOf = (edges: ChainEdge[]) => [...new Set(edges.flatMap((e) => [e.from, e.to]))].map((id) => ({ id }))

/** The path xyflow would draw for an edge: from the middle of the blocker's right side to the waiting card's port. */
function drawn(edges: ChainEdge[]) {
  const placed = layoutOf(nodesOf(edges), edges)
  const { of } = portsOf(placed, edges)
  return edges.map((e) => {
    const source = placed.get(e.to)
    const target = placed.get(e.from)
    const port = of.get(edgeKey(e))
    if (!source || !target || !port) throw new Error(`no placement for ${edgeKey(e)}`)
    const path = edgePath({
      sourceX: source.x + NODE_WIDTH,
      sourceY: source.y + NODE_HEIGHT / 2,
      targetX: target.x,
      targetY: target.y + NODE_HEIGHT / 2 + port.offset,
      blocked: !e.closed,
    })
    return { key: edgeKey(e), path }
  })
}

/** One horizontal segment: a move and a single line to the same height. */
const STRAIGHT = /^M ([\d.-]+),([\d.-]+) L ([\d.-]+),([\d.-]+)$/
function isStraight(path: string): boolean {
  const m = STRAIGHT.exec(path)
  return m !== null && m[2] === m[4]
}

test('a linear chain of three cards: every edge is one horizontal segment', () => {
  const edges = [edge('c', 'b'), edge('b', 'a')]
  const paths = drawn(edges)
  expect(paths).toHaveLength(2)
  for (const { key, path } of paths) expect(isStraight(path), `${key}: ${path}`).toBe(true)
})

test('a blocked and a done edge in one straight chain stay straight', () => {
  const edges = [edge('c', 'b'), edge('b', 'a', true)]
  for (const { key, path } of drawn(edges)) expect(isStraight(path), `${key}: ${path}`).toBe(true)
})

test('a card with a blocker above it is level with one blocker, the other enters beside it', () => {
  const edges = [edge('m', 'g'), edge('m', 'd', true), edge('l', 'm')]
  const placed = layoutOf(nodesOf(edges), edges)
  const level = ['g', 'd'].filter((id) => placed.get(id)?.y === placed.get('m')?.y)
  expect(level).toHaveLength(1)
  expect(placed.get('l')?.y).toBe(placed.get('m')?.y)
  const straight = drawn(edges).filter(({ path }) => isStraight(path))
  expect(straight).toHaveLength(2)
})

test('ports: the level edge enters at the middle, the others on either side in order, one per height', () => {
  const edges = [edge('t', 'a'), edge('t', 'b'), edge('t', 'c')]
  const placed = new Map([
    ['a', { x: 0, y: -400 }],
    ['b', { x: 0, y: 0 }],
    ['c', { x: 0, y: 400 }],
    ['t', { x: 600, y: 0 }],
  ])
  const { ports, of } = portsOf(placed, edges)
  expect(ports.get('t')).toEqual([-24, 0, 24])
  expect(of.get(edgeKey(edge('t', 'b')))).toEqual({ index: 1, offset: 0, labelled: true })
  expect(of.get(edgeKey(edge('t', 'a')))?.offset).toBeLessThan(0)
  expect(of.get(edgeKey(edge('t', 'c')))?.offset).toBeGreaterThan(0)
})

test('ports: with no level blocker they are centred; one blocker is one port; many are kept on the card', () => {
  const two = portsOf(
    new Map([
      ['a', { x: 0, y: -300 }],
      ['b', { x: 0, y: 300 }],
      ['t', { x: 600, y: 0 }],
    ]),
    [edge('t', 'a'), edge('t', 'b')],
  )
  expect(two.ports.get('t')).toEqual([-12, 12])
  const one = portsOf(
    new Map([
      ['a', { x: 0, y: 100 }],
      ['t', { x: 600, y: 0 }],
    ]),
    [edge('t', 'a')],
  )
  expect(one.ports.get('t')).toEqual([0])
  const many = Array.from({ length: 12 }, (_, i) => `n${i}`)
  const wide = portsOf(
    new Map([...many.map((id, i) => [id, { x: 0, y: i * 200 }] as const), ['t', { x: 600, y: 0 }]]),
    many.map((id) => edge('t', id)),
  )
  const offsets = wide.ports.get('t') ?? []
  expect(offsets).toHaveLength(12)
  expect(Math.max(...offsets.map(Math.abs))).toBeLessThanOrEqual(56)
  // twelve ports are too close for labels: the lines stay, the words go
  expect(wide.of.get(edgeKey(edge('t', 'n0')))?.labelled).toBe(false)
  expect(two.of.get(edgeKey(edge('t', 'a')))?.labelled).toBe(true)
})

test('the straightening pass never lets two cards of a column overlap', () => {
  const edges = [edge('m', 'g'), edge('m', 'd', true), edge('l', 'm'), edge('x', 'g'), edge('y', 'd'), edge('y', 'x')]
  const placed = layoutOf(nodesOf(edges), edges)
  const column = new Map<number, number[]>()
  for (const at of placed.values()) column.set(at.x, [...(column.get(at.x) ?? []), at.y])
  for (const ys of column.values()) {
    const sorted = ys.toSorted((p, q) => p - q)
    for (const [i, y] of sorted.entries()) {
      const next = sorted[i + 1]
      if (next !== undefined) expect(next - y).toBeGreaterThanOrEqual(NODE_HEIGHT + 28)
    }
  }
})
