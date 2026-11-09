import { Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Link } from '@tanstack/react-router'
import { useMemo } from 'react'
import type { ChainModel } from '@software-factory/contract'
import { type ChainView, edgeText, isBlocked, issueNumber, NODE_HEIGHT, NODE_WIDTH, stateWord } from '@/lib/chain'
import { layoutOf } from '@/lib/chain-layout'
import { cn } from '@/lib/utils'

type ChainNode = ChainModel['nodes'][number]
type CardNode = Node<{ node: ChainNode }, 'chain'>

function Card({ data }: NodeProps<CardNode>) {
  const { node } = data
  const number = issueNumber(node)
  return (
    <div
      data-testid="chain-node"
      data-kind={node.kind}
      className={cn(
        'flex flex-col gap-1 rounded-lg border bg-card p-3 text-card-foreground',
        node.kind === 'row' && 'border-dashed',
      )}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className="opacity-0" />
      {number ? (
        <Link
          to="/issues/$id"
          params={{ id: number }}
          className="pointer-events-auto line-clamp-2 text-sm font-medium outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {node.title}
        </Link>
      ) : (
        <p className="line-clamp-2 text-sm font-medium">{node.title}</p>
      )}
      <p className="mt-auto flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">{node.repo ?? 'No project'}</span>
        <span className="shrink-0">
          {node.kind === 'row' ? 'Not filed yet · ' : ''}
          {stateWord(node.state)}
        </span>
      </p>
      <Handle type="source" position={Position.Right} isConnectable={false} className="opacity-0" />
    </div>
  )
}

const NODE_TYPES = { chain: Card }

/** The dependency graph: blockers on the left, an arrow into the node that waits. A blocked edge is solid and labelled "blocks", a satisfied one dashed and labelled "done". */
export default function ChainGraph({ view, resetKey }: { view: ChainView; resetKey: string }) {
  const { nodes, edges } = useMemo(() => {
    const placed = layoutOf(view.nodes, view.edges)
    const byId = new Map(view.nodes.map((node) => [node.id, node]))
    const nodes: CardNode[] = view.nodes.map((node) => ({
      id: node.id,
      type: 'chain',
      position: placed.get(node.id) ?? { x: 0, y: 0 },
      data: { node },
      ariaRole: 'group',
      ariaLabel: `${node.title}, ${node.repo ?? 'no project'}, ${stateWord(node.state)}`,
    }))
    const edges: Edge[] = view.edges.map((edge) => {
      const blocked = isBlocked(edge)
      const text = edgeText(edge, byId)
      return {
        id: `${edge.to}>${edge.from}`,
        source: edge.to,
        target: edge.from,
        type: 'smoothstep',
        label: blocked ? 'blocks' : 'done',
        labelShowBg: true,
        labelBgPadding: [6, 3],
        labelBgBorderRadius: 6,
        ariaLabel: text,
        className: blocked ? 'chain-edge-blocked' : 'chain-edge-done',
        markerEnd: { type: MarkerType.ArrowClosed, color: blocked ? 'var(--vx-warn-solid)' : 'var(--vx-faint)' },
      }
    })
    return { nodes, edges }
  }, [view])

  return (
    <div
      role="region"
      aria-label="Dependency chain"
      className="h-[min(70dvh,40rem)] min-w-0 overflow-hidden rounded-xl border bg-card"
    >
      <ReactFlow
        key={resetKey}
        className="chain-graph"
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.2}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
