import { Graph, layout } from '@dagrejs/dagre'
import type { ChainEdge, ChainNode } from '@software-factory/contract'
import { NODE_HEIGHT, NODE_WIDTH } from './chain.ts'

export interface Placed {
  x: number
  y: number
}

/** Positions (top-left) from dagre, left to right: a blocker sits left of the node that waits for it. */
export function layoutOf(nodes: ChainNode[], edges: ChainEdge[]): Map<string, Placed> {
  const graph = new Graph()
  graph.setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 160, marginx: 8, marginy: 8 })
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
