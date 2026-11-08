import { Graph, layout } from '@dagrejs/dagre'
import type { ChainEdge, ChainModel, ChainNode } from '@software-factory/contract'

export const NODE_WIDTH = 240
export const NODE_HEIGHT = 96

export interface ChainFilters {
  project?: string
}

/** What the screen draws: the nodes that have an edge (under the filter), the edges between them, and how many nodes have none. */
export interface ChainView {
  nodes: ChainNode[]
  edges: ChainEdge[]
  /** nodes without any edge (of the project, when filtered): not drawn */
  isolated: number
}

/** An edge runs from the node that waits to its blocker; it blocks until the blocker has closed. */
export const isBlocked = (edge: ChainEdge): boolean => !edge.closed

/** The projects any node belongs to, sorted. */
export const projectsOf = (data: ChainModel): string[] =>
  [...new Set(data.nodes.flatMap((node) => (node.repo ? [node.repo] : [])))].sort()

/**
 * The chain under the filter. A project keeps its own nodes and every node an edge joins them to, so an edge across
 * projects stays readable. A node without an edge is counted, not drawn.
 */
export function chainOf(data: ChainModel, filters: ChainFilters = {}): ChainView {
  const linked = new Set(data.edges.flatMap((edge) => [edge.from, edge.to]))
  const ids = new Set(data.nodes.map((node) => node.id))
  const edges = data.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to))
  const own = (node: ChainNode): boolean => !filters.project || node.repo === filters.project
  const wanted = new Set(data.nodes.filter(own).map((node) => node.id))
  const kept = filters.project ? edges.filter((edge) => wanted.has(edge.from) || wanted.has(edge.to)) : edges
  const shown = new Set(kept.flatMap((edge) => [edge.from, edge.to]))
  return {
    nodes: data.nodes.filter((node) => shown.has(node.id)),
    edges: kept,
    isolated: data.nodes.filter((node) => own(node) && !linked.has(node.id)).length,
  }
}

export interface Placed {
  x: number
  y: number
}

/** Positions (top-left) from dagre, left to right: a blocker sits left of the node that waits for it. */
export function layoutOf(nodes: ChainNode[], edges: ChainEdge[]): Map<string, Placed> {
  const graph = new Graph()
  graph.setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 96, marginx: 8, marginy: 8 })
  graph.setDefaultEdgeLabel(() => ({}))
  for (const node of nodes) graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  for (const edge of edges) graph.setEdge(edge.to, edge.from)
  layout(graph)
  return new Map(
    nodes.map((node) => {
      const at = graph.node(node.id)
      return [node.id, { x: at.x - NODE_WIDTH / 2, y: at.y - NODE_HEIGHT / 2 }]
    }),
  )
}

const STATE_WORD: Record<string, string> = {
  settling: 'Settling',
  queued: 'Queued',
  working: 'Working',
  waiting: 'Waiting',
  watching: 'Watching',
  closed: 'Closed',
  filable: 'Ready to file',
}

/** A node's state as the word the owner reads. */
export const stateWord = (state: string): string =>
  STATE_WORD[state] ?? `${state.charAt(0).toUpperCase()}${state.slice(1)}`

/** The Issue's number for its page (`issue_12` is `12`); a plan row has no page. */
export const issueNumber = (node: ChainNode): string | null =>
  node.kind === 'issue' && /^issue_\d+$/.test(node.id) ? node.id.slice('issue_'.length) : null

/** The text of an edge for a screen reader and its label: who blocks whom, or that the blocker is done. */
export const edgeText = (edge: ChainEdge, byId: Map<string, ChainNode>): string => {
  const blocker = byId.get(edge.to)?.title ?? 'Unknown'
  const waiting = byId.get(edge.from)?.title ?? 'Unknown'
  return isBlocked(edge) ? `${blocker} blocks ${waiting}` : `${blocker} is done, ${waiting} no longer waits for it`
}

export const isolatedNote = (count: number): string =>
  `${count} ${count === 1 ? 'item has' : 'items have'} no dependencies`
