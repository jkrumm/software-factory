import { Graph, layout } from '@dagrejs/dagre'
import type { ChainEdge } from '@software-factory/contract'
import { NODE_HEIGHT, NODE_WIDTH } from './chain.ts'

export interface Placed {
  x: number
  y: number
}

const NODE_GAP = 28
const PASSES = 6

/**
 * Positions (top-left) from dagre, left to right: a blocker sits left of the node that waits for it. Dagre centres a node
 * between its neighbours, which leaves a small jog on an edge that could have been straight, so a straightening pass
 * follows: a card moves, with the cards on one line with it, to the height of a neighbour when that makes more edges level
 * and no card of its column is in the way.
 */
export function layoutOf(nodes: { id: string }[], edges: ChainEdge[]): Map<string, Placed> {
  const graph = new Graph()
  graph.setGraph({ rankdir: 'LR', nodesep: NODE_GAP, ranksep: 160, marginx: 8, marginy: 8 })
  graph.setDefaultEdgeLabel(() => ({}))
  for (const node of nodes) graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  for (const edge of edges) graph.setEdge(edge.to, edge.from)
  layout(graph)
  const placed = new Map<string, Placed>(
    nodes.map((node) => {
      const at = graph.node(node.id)
      return [node.id, { x: Math.round(at.x - NODE_WIDTH / 2), y: Math.round(at.y - NODE_HEIGHT / 2) }]
    }),
  )
  straighten(placed, edges)
  return placed
}

function straighten(placed: Map<string, Placed>, edges: ChainEdge[]): void {
  const drawn = edges.filter((edge) => placed.has(edge.from) && placed.has(edge.to))
  const levelEdge = (edge: ChainEdge): boolean => placed.get(edge.from)?.y === placed.get(edge.to)?.y
  /** The cards joined to `id` by a chain of level edges: they move together, or a move would break the line it came from. */
  const lineOf = (id: string): Set<string> => {
    const line = new Set([id])
    for (let grew = true; grew;) {
      grew = false
      for (const edge of drawn) {
        if (!levelEdge(edge) || line.has(edge.from) === line.has(edge.to)) continue
        line.add(edge.from).add(edge.to)
        grew = true
      }
    }
    return line
  }
  const levelAfter = (line: Set<string>, delta: number): number =>
    drawn.filter((edge) => {
      const from = placed.get(edge.from)?.y ?? 0
      const to = placed.get(edge.to)?.y ?? 0
      return (line.has(edge.from) ? from + delta : from) === (line.has(edge.to) ? to + delta : to)
    }).length
  const free = (line: Set<string>, delta: number): boolean =>
    [...line].every((id) => {
      const at = placed.get(id)
      if (!at) return false
      const low = Math.min(at.y, at.y + delta) - NODE_HEIGHT - NODE_GAP
      const high = Math.max(at.y, at.y + delta) + NODE_HEIGHT + NODE_GAP
      return ![...placed].some(
        ([other, there]) => !line.has(other) && there.x === at.x && there.y > low && there.y < high,
      )
    })
  for (let pass = 0; pass < PASSES; pass++) {
    let moved = false
    for (const edge of drawn) {
      if (levelEdge(edge)) continue
      for (const [mover, anchor] of [
        [edge.from, edge.to],
        [edge.to, edge.from],
      ] as const) {
        const delta = (placed.get(anchor)?.y ?? 0) - (placed.get(mover)?.y ?? 0)
        if (delta === 0) continue
        const line = lineOf(mover)
        if (line.has(anchor) || levelAfter(line, delta) <= levelAfter(line, 0) || !free(line, delta)) continue
        for (const id of line) {
          const at = placed.get(id)
          if (at) at.y += delta
        }
        moved = true
        break
      }
    }
    if (!moved) break
  }
}

/** Where one edge enters its card: the port's number on the card and its height from the card's middle (px, down is positive). */
export interface Port {
  index: number
  offset: number
  /** whether the ports of its card are far enough apart for the edge's label (a card with many blockers draws lines only) */
  labelled: boolean
}

/** The farthest a port sits from the middle of a card, so it stays on the card's left edge clear of its corners. */
const PORT_REACH = 56
/** The room between two ports where it can (a label is about 20 px high). */
const PORT_STEP = 24
/** Closer than this (px) the labels of two edges would sit on each other. */
const LABEL_STEP = 18

/**
 * The ports of every card, and the port each edge enters. An edge whose blocker sits level with the waiting card enters at
 * the middle, where the blocker's own port is, so its line is straight. The other blockers enter above and below it in the
 * order they sit, one port per height of a blocker: two blockers at one height share a port. Where no blocker is level the
 * ports are centred on the middle. A card with one blocker has the one port.
 */
export function portsOf(
  placed: Map<string, Placed>,
  edges: ChainEdge[],
): { ports: Map<string, number[]>; of: Map<string, Port> } {
  const byWaiting = new Map<string, ChainEdge[]>()
  for (const edge of edges) byWaiting.set(edge.from, [...(byWaiting.get(edge.from) ?? []), edge])
  const ports = new Map<string, number[]>()
  const of = new Map<string, Port>()
  for (const [id, incoming] of byWaiting) {
    const y = placed.get(id)?.y ?? 0
    const gap = (edge: ChainEdge): number => (placed.get(edge.to)?.y ?? y) - y
    const heights = [...new Set(incoming.map(gap))].toSorted((a, b) => a - b)
    const level = heights.indexOf(0)
    const middle = level === -1 ? (heights.length - 1) / 2 : level
    const farthest = Math.max(middle, heights.length - 1 - middle)
    const step = farthest === 0 ? 0 : Math.min(PORT_STEP, PORT_REACH / farthest)
    const labelled = farthest === 0 || step >= LABEL_STEP
    const offsets = heights.map((_, index) => Math.round((index - middle) * step))
    ports.set(id, offsets)
    for (const edge of incoming) {
      const index = heights.indexOf(gap(edge))
      of.set(edgeKey(edge), { index, offset: offsets[index] ?? 0, labelled })
    }
  }
  return { ports, of }
}

export const edgeKey = (edge: ChainEdge): string => `${edge.to}>${edge.from}`

/** A card's port, as the id of its handle. */
export const portId = (index: number): string => `in-${index}`
