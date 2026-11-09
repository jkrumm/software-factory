import {
  BaseEdge,
  Controls,
  getSmoothStepPath,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeProps,
  type ReactFlowInstance,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ClockIcon, HourglassIcon } from '@phosphor-icons/react'
import { Link } from '@tanstack/react-router'
import { useEffect, useMemo } from 'react'
import type { ChainModel } from '@software-factory/contract'
import { IssueCard } from '@/components/kit'
import {
  type ChainView,
  edgeText,
  isBlocked,
  issueNumber,
  lozengeOf,
  NODE_HEIGHT,
  NODE_WIDTH,
  reasonOf,
  stateWord,
  waitsForWords,
} from '@/lib/chain'
import { layoutOf } from '@/lib/chain-layout'
import { useNow } from '@/lib/now'
import { cn } from '@/lib/utils'

type ChainNode = ChainModel['nodes'][number]
type CardNode = Node<{ node: ChainNode; waitsFor: string | null }, 'chain'>

/** An Issue is the kit's card and a link to its page; a plan row is the same card on a dashed outline, not a link. */
function Card({ data }: NodeProps<CardNode>) {
  const { node, waitsFor } = data
  const now = useNow(60_000)
  const number = issueNumber(node)
  const row = node.kind === 'row'
  const { state, label } = lozengeOf(node)
  const reason = reasonOf(node, waitsFor, now)
  return (
    <div
      data-testid="chain-node"
      data-kind={node.kind}
      className="pointer-events-auto"
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
    >
      <Handle
        id="blocked"
        type="target"
        position={Position.Left}
        isConnectable={false}
        className="opacity-0"
        style={{ top: '68%' }}
      />
      <Handle
        id="done"
        type="target"
        position={Position.Left}
        isConnectable={false}
        className="opacity-0"
        style={{ top: '32%' }}
      />
      <IssueCard
        raised
        className={cn('chain-card h-full overflow-hidden', row && 'border border-dashed border-muted-foreground/50')}
        title={node.title}
        project={node.repo ?? 'No project'}
        kind={node.issueKind}
        state={state}
        stateLabel={label}
        origin={row ? 'Not filed yet' : undefined}
        reason={reason?.text}
        reasonTitle={reason?.title}
        reasonIcon={reason?.icon === 'clock' ? ClockIcon : reason?.icon === 'hourglass' ? HourglassIcon : undefined}
        since={node.since}
        now={now}
        as={number ? (props) => <Link to="/issues/$id" params={{ id: number }} {...props} /> : undefined}
      />
      <Handle type="source" position={Position.Right} isConnectable={false} className="opacity-0" />
    </div>
  )
}

const NODE_TYPES = { chain: Card }

type DependencyEdge = Edge<{ blocked: boolean }, 'dependency'>

/** Where an edge turns, as a share of the gap between the two nodes: the long straight run after it is where the label sits. */
const TURN = { blocked: 0.3, done: 0.18 }
/** Room the arrowhead takes at the end of the run (px). */
const ARROW = 10

/**
 * A smoothstep edge that turns early and carries its label on the final straight run, so the line runs unbroken
 * into the label and out to the arrowhead.
 */
function Dependency({
  data,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  label,
  labelStyle,
  labelShowBg,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
}: EdgeProps<DependencyEdge>) {
  const turn = data?.blocked ? TURN.blocked : TURN.done
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    stepPosition: turn,
  })
  const turnX = sourceX + (targetX - sourceX) * turn
  return (
    <BaseEdge
      path={path}
      markerEnd={markerEnd}
      labelX={(turnX + targetX - ARROW) / 2}
      labelY={targetY}
      label={label}
      labelStyle={labelStyle}
      labelShowBg={labelShowBg}
      labelBgStyle={labelBgStyle}
      labelBgPadding={labelBgPadding}
      labelBgBorderRadius={labelBgBorderRadius}
    />
  )
}

const EDGE_TYPES = { dependency: Dependency }

/** Room around the graph (px), the most a small graph is enlarged, and the least a phone shrinks it before the graph is panned instead. */
const PAD = 24
const CONTROLS_PAD = 56
const MAX_FIT_ZOOM = 1.4
const PHONE_WIDTH = 640
const PHONE_FLOOR_ZOOM = 0.9
const FIT = { padding: 0.15, maxZoom: MAX_FIT_ZOOM }

interface Bounds {
  x: number
  y: number
  w: number
  h: number
}

/** Centres the graph at the largest zoom that shows it whole (never above 1.4: a graph of two cards fills the canvas instead of floating in it); on a phone it stays legible and starts at the top left. */
function fitTo(setViewport: ReactFlowInstance['setViewport'], size: { width: number; height: number }, b: Bounds) {
  if (size.width === 0 || size.height === 0) return
  // the zoom controls sit at the bottom left from `md` up: the graph is centred in what is left of the width after a gutter for them
  const left = size.width < PHONE_WIDTH ? PAD : CONTROLS_PAD
  const room = size.width - left - PAD
  const whole = Math.min(MAX_FIT_ZOOM, room / b.w, (size.height - 2 * PAD) / b.h)
  if (size.width < PHONE_WIDTH && whole < PHONE_FLOOR_ZOOM) {
    void setViewport({ x: PAD - b.x * PHONE_FLOOR_ZOOM, y: PAD - b.y * PHONE_FLOOR_ZOOM, zoom: PHONE_FLOOR_ZOOM })
    return
  }
  void setViewport({
    x: left + (room - b.w * whole) / 2 - b.x * whole,
    y: (size.height - b.h * whole) / 2 - b.y * whole,
    zoom: whole,
  })
}

/** Fits the graph again whenever the canvas changes size (the window, the sidebar, the phone turning); the fit control does the same. */
function Viewport({ bounds }: { bounds: Bounds }) {
  const { setViewport } = useReactFlow()
  const width = useStore((state) => state.width)
  const height = useStore((state) => state.height)
  useEffect(() => {
    fitTo(setViewport, { width, height }, bounds)
  }, [width, height, bounds, setViewport])
  return (
    <Controls
      position={width < PHONE_WIDTH ? 'top-right' : 'bottom-left'}
      showInteractive={false}
      onFitView={() => fitTo(setViewport, { width, height }, bounds)}
    />
  )
}

function Legend() {
  const line = 'h-4 w-8 shrink-0'
  return (
    <ul
      aria-label="Legend"
      className="chain-card absolute right-3 bottom-3 z-10 hidden flex-col md:flex gap-1.5 rounded-lg bg-card px-3 py-2 text-xs text-[color:var(--vx-ink2)]"
      style={{ boxShadow: 'var(--vx-shadow-card)' }}
    >
      <li className="flex items-center gap-2">
        <svg className={line} viewBox="0 0 32 16" aria-hidden="true">
          <line x1="2" y1="8" x2="30" y2="8" stroke="var(--vx-warn-solid)" strokeWidth="2.5" />
        </svg>
        blocks
      </li>
      <li className="flex items-center gap-2">
        <svg className={line} viewBox="0 0 32 16" aria-hidden="true">
          <line x1="2" y1="8" x2="30" y2="8" stroke="var(--vx-faint)" strokeWidth="1.5" strokeDasharray="6 5" />
        </svg>
        done
      </li>
      <li className="flex items-center gap-2">
        <svg className={line} viewBox="0 0 32 16" aria-hidden="true">
          <rect
            x="2"
            y="2"
            width="28"
            height="12"
            rx="3"
            fill="none"
            stroke="var(--vx-faint)"
            strokeWidth="1.5"
            strokeDasharray="4 3"
          />
        </svg>
        not filed yet
      </li>
    </ul>
  )
}

/** The dependency graph: blockers on the left, an arrow into the node that waits. A blocked edge is solid and labelled "blocks", a satisfied one dashed and labelled "done". */
export default function ChainGraph({ view, resetKey }: { view: ChainView; resetKey: string }) {
  const { nodes, edges, bounds } = useMemo(() => {
    const placed = layoutOf(view.nodes, view.edges)
    const byId = new Map(view.nodes.map((node) => [node.id, node]))
    const nodes: CardNode[] = view.nodes.map((node) => ({
      id: node.id,
      type: 'chain',
      position: placed.get(node.id) ?? { x: 0, y: 0 },
      data: { node, waitsFor: waitsForWords(node.id, view.edges, byId) },
      ariaRole: 'group',
      ariaLabel: `${node.title}, ${node.repo ?? 'no project'}, ${stateWord(node.state)}`,
    }))
    const edges: DependencyEdge[] = view.edges.map((edge) => {
      const blocked = isBlocked(edge)
      const text = edgeText(edge, byId)
      return {
        id: `${edge.to}>${edge.from}`,
        source: edge.to,
        target: edge.from,
        targetHandle: blocked ? 'blocked' : 'done',
        type: 'dependency',
        data: { blocked },
        label: blocked ? 'blocks' : 'done',
        labelShowBg: true,
        labelBgPadding: [6, 3],
        labelBgBorderRadius: 6,
        ariaLabel: text,
        className: blocked ? 'chain-edge-blocked' : 'chain-edge-done',
        markerEnd: { type: MarkerType.ArrowClosed, color: blocked ? 'var(--vx-warn-solid)' : 'var(--vx-faint)' },
      }
    })
    const xs = nodes.map((node) => node.position.x)
    const ys = nodes.map((node) => node.position.y)
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    const bounds: Bounds = { x, y, w: Math.max(...xs) + NODE_WIDTH - x, h: Math.max(...ys) + NODE_HEIGHT - y }
    return { nodes, edges, bounds }
  }, [view])

  return (
    <div
      role="region"
      aria-label="Dependency chain"
      className="relative min-h-[30rem] min-w-0 flex-1 overflow-hidden chain-canvas rounded-xl md:min-h-[28rem]"
    >
      <div className="absolute inset-0">
        <ReactFlow
          key={resetKey}
          className="chain-graph"
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          fitViewOptions={FIT}
          minZoom={0.2}
          maxZoom={2}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Viewport bounds={bounds} />
        </ReactFlow>
      </div>
      <Legend />
    </div>
  )
}
