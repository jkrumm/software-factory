import {
  BaseEdge,
  ControlButton,
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
import { ClockIcon, CornersOutIcon, HourglassIcon } from '@phosphor-icons/react'
import { Link } from '@tanstack/react-router'
import { useEffect, useMemo } from 'react'
import type { ChainModel } from '@software-factory/contract'
import { IssueCard } from '@/components/kit'
import {
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
import { type ChainGroup, type CollapsedView } from '@/lib/chain-collapse'
import { layoutOf } from '@/lib/chain-layout'
import { GroupCard, groupTitle } from './group-card'
import { useNow } from '@/lib/now'
import { cn } from '@/lib/utils'

type ChainNode = ChainModel['nodes'][number]
type CardNode = Node<{ node: ChainNode; waitsFor: string | null }, 'chain'>
type GroupNode = Node<{ group: ChainGroup; onOpen: (id: string) => void }, 'folded'>

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
        compact
        className={cn('chain-card h-full overflow-hidden', row && 'border border-dashed border-muted-foreground/50')}
        title={node.title}
        project={node.repo ?? 'No project'}
        kind={node.issueKind}
        number={number ? Number(number) : null}
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

/** A folded group: the node's size, a dashed card that opens in place when clicked. */
function Group({ data }: NodeProps<GroupNode>) {
  return (
    <div
      data-testid="chain-group"
      data-bucket={data.group.bucket}
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
      <GroupCard group={data.group} onOpen={data.onOpen} />
      <Handle type="source" position={Position.Right} isConnectable={false} className="opacity-0" />
    </div>
  )
}

/** `folded`, not `group`: xyflow styles a node of type `group` as a framed box of its own. */
const NODE_TYPES = { chain: Card, folded: Group }

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
/** A big graph (a chain of hundreds of nodes) is not shrunk past this on a desktop, where a card is still a card: the rest is panned to. */
const DESKTOP_FLOOR_ZOOM = 0.5
const FIT = { padding: 0.15, maxZoom: MAX_FIT_ZOOM }

interface Bounds {
  x: number
  y: number
  w: number
  h: number
  /** the top of the first column: where a graph too big to fit starts, so the screen opens on the first nodes and not on empty canvas */
  top: number
}

/** Centres the graph at the largest zoom that shows it whole (never above 1.4: a graph of two cards fills the canvas instead of floating in it); on a phone it stays legible and starts at the top left. */
function fitTo(setViewport: ReactFlowInstance['setViewport'], size: { width: number; height: number }, b: Bounds) {
  if (size.width === 0 || size.height === 0) return
  // the zoom controls sit at the bottom left from `md` up: the graph is centred in what is left of the width after a gutter for them
  const left = size.width < PHONE_WIDTH ? PAD : CONTROLS_PAD
  const room = size.width - left - PAD
  const whole = Math.min(MAX_FIT_ZOOM, room / b.w, (size.height - 2 * PAD) / b.h)
  if (size.width < PHONE_WIDTH && whole < PHONE_FLOOR_ZOOM) {
    void setViewport({ x: PAD - b.x * PHONE_FLOOR_ZOOM, y: PAD - b.top * PHONE_FLOOR_ZOOM, zoom: PHONE_FLOOR_ZOOM })
    return
  }
  if (whole < DESKTOP_FLOOR_ZOOM) {
    void setViewport({
      x: left - b.x * DESKTOP_FLOOR_ZOOM,
      y: PAD - b.y * DESKTOP_FLOOR_ZOOM,
      zoom: DESKTOP_FLOOR_ZOOM,
    })
    return
  }
  void setViewport({
    x: left + (room - b.w * whole) / 2 - b.x * whole,
    y: (size.height - b.h * whole) / 2 - b.y * whole,
    zoom: whole,
  })
}

/** Brings a group that was just opened into view at the floor zoom: its first row near the top, a rank of context to its left. */
function focusOn(setViewport: ReactFlowInstance['setViewport'], size: { width: number; height: number }, box: Bounds) {
  if (size.width === 0 || size.height === 0) return
  const zoom = size.width < PHONE_WIDTH ? PHONE_FLOOR_ZOOM : DESKTOP_FLOOR_ZOOM
  void setViewport({ x: Math.min(size.width * 0.3, 400) - box.x * zoom, y: PAD - box.y * zoom, zoom })
}

/**
 * Fits the graph again whenever the canvas changes size (the window, the sidebar, the phone turning) or its nodes change;
 * after a group was opened it shows that group instead. The fit control is ours (xyflow's own fit would run beside it and
 * ignore the floor zoom).
 */
function Viewport({ bounds, focus }: { bounds: Bounds; focus: Bounds | null }) {
  const { setViewport } = useReactFlow()
  const width = useStore((state) => state.width)
  const height = useStore((state) => state.height)
  useEffect(() => {
    if (focus) focusOn(setViewport, { width, height }, focus)
    else fitTo(setViewport, { width, height }, bounds)
  }, [width, height, bounds, focus, setViewport])
  return (
    <Controls position={width < PHONE_WIDTH ? 'top-right' : 'bottom-left'} showInteractive={false} showFitView={false}>
      <ControlButton
        title="Fit view"
        aria-label="Fit view"
        onClick={() => fitTo(setViewport, { width, height }, bounds)}
      >
        <CornersOutIcon />
      </ControlButton>
    </Controls>
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
export default function ChainGraph({
  view,
  resetKey,
  onOpen,
  focus,
}: {
  view: CollapsedView
  resetKey: string
  onOpen: (id: string) => void
  /** the rows of the group opened last, to bring into view; none: fit the whole graph */
  focus: string[]
}) {
  const { nodes, edges, bounds, focusBox } = useMemo(() => {
    const placed = layoutOf([...view.nodes, ...view.groups], view.edges)
    const byId = new Map<string, { title: string }>(view.nodes.map((node) => [node.id, node]))
    for (const group of view.groups) byId.set(group.id, { title: groupTitle(group) })
    const groups: GroupNode[] = view.groups.map((group) => ({
      id: group.id,
      type: 'folded',
      position: placed.get(group.id) ?? { x: 0, y: 0 },
      data: { group, onOpen },
      ariaRole: 'group',
      ariaLabel: `${groupTitle(group)}, ${group.repo || 'no project'}, folded`,
    }))
    const cards: CardNode[] = view.nodes.map((node) => ({
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
    const nodes: (CardNode | GroupNode)[] = [...cards, ...groups]
    const xs = nodes.map((node) => node.position.x)
    const ys = nodes.map((node) => node.position.y)
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    const top = Math.min(...nodes.filter((node) => node.position.x === x).map((node) => node.position.y))
    const bounds: Bounds = { x, y, top, w: Math.max(...xs) + NODE_WIDTH - x, h: Math.max(...ys) + NODE_HEIGHT - y }
    const focused = focus.flatMap((id) => {
      const at = placed.get(id)
      return at ? [at] : []
    })
    const focusBox: Bounds | null =
      focused.length === 0
        ? null
        : {
            x: Math.min(...focused.map((at) => at.x)),
            y: Math.min(...focused.map((at) => at.y)),
            top: 0,
            w: 0,
            h: 0,
          }
    return { nodes, edges, bounds, focusBox }
  }, [view, onOpen, focus])

  return (
    <div
      role="region"
      aria-label="Dependency chain"
      className={cn(
        'relative min-h-[30rem] min-w-0 flex-1 overflow-hidden chain-canvas rounded-xl md:min-h-[28rem]',
        view.groups.length > 0 && 'md:min-h-[min(44rem,70vh)]',
      )}
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
          minZoom={0.1}
          maxZoom={2}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Viewport bounds={bounds} focus={focusBox} />
        </ReactFlow>
      </div>
      <Legend />
    </div>
  )
}
