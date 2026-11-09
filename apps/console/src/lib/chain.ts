import type { ChainEdge, ChainModel, ChainNode } from '@software-factory/contract'
import { LOZENGE_STATES, type LozengeState } from '@/components/kit/lozenge'

export const NODE_WIDTH = 320
export const NODE_HEIGHT = 128

export interface ChainFilters {
  project?: string
}

/** What the screen draws: the nodes that have an edge (under the filter), the edges between them, and how many nodes have none. */
export interface ChainView {
  nodes: ChainNode[]
  edges: ChainEdge[]
  /** nodes without any edge (of the project, when filtered) and not on the schedule: not drawn */
  isolated: number
}

/** An edge runs from the node that waits to its blocker; it blocks until the blocker has closed. */
export const isBlocked = (edge: ChainEdge): boolean => !edge.closed

/** The projects any node belongs to, sorted. */
export const projectsOf = (data: Pick<ChainModel, 'nodes'>): string[] =>
  [...new Set(data.nodes.flatMap((node) => (node.repo ? [node.repo] : [])))].sort()

/**
 * The chain under the filter. A project keeps its own nodes and every node an edge joins them to, so an edge across
 * projects stays readable. A node without an edge is counted, not drawn.
 */
export function chainOf(data: Pick<ChainModel, 'nodes' | 'edges'>, filters: ChainFilters = {}): ChainView {
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
    isolated: data.nodes.filter((node) => own(node) && !linked.has(node.id) && !node.notBefore).length,
  }
}

/**
 * The one source of the Chain's counts. Per project: the nodes the graph draws when that project is picked, and the
 * nodes it leaves out because no edge joins them. `isolated` is the same count with no project picked.
 */
export function chainCounts(data: Pick<ChainModel, 'nodes' | 'edges'>): {
  projects: Record<string, { drawn: number; isolated: number }>
  isolated: number
} {
  const projects = Object.fromEntries(
    projectsOf(data).map((repo) => {
      const view = chainOf(data, { project: repo })
      return [repo, { drawn: view.nodes.filter((node) => node.repo === repo).length, isolated: view.isolated }]
    }),
  )
  return { projects, isolated: chainOf(data).isolated }
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
  `${count} more ${count === 1 ? 'item has' : 'items have'} no dependencies, so ${count === 1 ? 'it is' : 'they are'} not drawn`

const isLozenge = (state: string): state is LozengeState => (LOZENGE_STATES as readonly string[]).includes(state)

/** The Lozenge of a node: its state, or a neutral one carrying the state's word where the kit has no such state. */
export function lozengeOf(node: Pick<ChainNode, 'kind' | 'state'>): { state: LozengeState; label?: string } {
  if (node.kind === 'row' && node.state === 'filable') return { state: 'queued', label: stateWord('filable') }
  if (isLozenge(node.state)) return { state: node.state }
  return { state: 'queued', label: stateWord(node.state) }
}

const DAY = 86_400_000
const HORIZON_DAYS = 120
const MIN_DAYS = 7
const DAY_TICKS_UP_TO = 14

/** `Mon 16 Nov, 09:00` in the viewer's zone; another year than `now`'s is named (`Thu 1 Jan 2099, 01:00`). */
export function dateWords(iso: string, now: number = Date.now()): string {
  const parts = new Map(
    new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value]),
  )
  const year = new Date(iso).getFullYear()
  const named = year === new Date(now).getFullYear() ? '' : ` ${year}`
  return `${parts.get('weekday')} ${parts.get('day')} ${parts.get('month')}${named}, ${parts.get('hour')}:${parts.get('minute')}`
}

/** The absolute instant, in UTC, for a hover. */
export const utcWords = (iso: string): string => `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`

/** The distance to a later instant: "in 40 min", "in 5 h", "in 6 days", "in 3 years"; at or before now: "due". */
export function untilWords(ms: number): string {
  if (ms <= 0) return 'due'
  if (ms < 3_600_000) return `in ${Math.max(1, Math.floor(ms / 60_000))} min`
  if (ms < DAY) return `in ${Math.floor(ms / 3_600_000)} h`
  const days = Math.floor(ms / DAY)
  if (days >= 365) return `in ${Math.floor(days / 365)} years`
  return `in ${days} ${days === 1 ? 'day' : 'days'}`
}

/** The reason line of a plan row that waits for a date, with the instant for its hover. */
export const notBeforeReason = (iso: string, now: number = Date.now()): { text: string; title: string } => ({
  text: `Not before ${dateWords(iso, now)}`,
  title: utcWords(iso),
})

export interface ScheduleItem {
  node: ChainNode
  /** the date (ms) */
  at: number
  /** 0..1 on the axis; a due row is pinned at 0 (Now), a later one is 1 and not drawn on the axis */
  position: number
  /** 0 is nearest the axis; in the Later cell the row's place in the stack */
  lane: number
  /** dated beyond the horizon: shown in the Later cell */
  later: boolean
  /** the date has passed and the row is still not filed */
  due: boolean
}

export interface ScheduleTick {
  at: number
  position: number
  label: string
}

export interface Schedule {
  start: number
  end: number
  unit: 'day' | 'week'
  ticks: ScheduleTick[]
  /** in date order */
  items: ScheduleItem[]
  /** how many lanes the axis needs */
  lanes: number
}

const midnightAfter = (ms: number): Date => {
  const date = new Date(ms)
  date.setHours(24, 0, 0, 0)
  return date
}

const tickLabel = (date: Date, unit: 'day' | 'week'): string =>
  unit === 'day'
    ? date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' })
    : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

/**
 * The rows that wait for a date, on an axis from `now` to the last date inside 120 days (at least 7 days). A row dated
 * past the horizon is `later`; a row whose date has passed is `due` and pinned at Now. Chips are `gap` (a share of the axis)
 * wide: a chip that would cover a later dot sits above that chip's lane. Day ticks up to 14 days, Mondays after.
 */
export function scheduleOf(nodes: ChainNode[], now: number, gap = 0.2): Schedule {
  const dated = nodes
    .flatMap((node) => (node.notBefore ? [{ node, at: Date.parse(node.notBefore) }] : []))
    .filter((item) => Number.isFinite(item.at))
    .sort((a, b) => a.at - b.at || a.node.title.localeCompare(b.node.title))
  const horizon = now + HORIZON_DAYS * DAY
  const inside = dated.filter((item) => item.at <= horizon)
  const end = Math.max(now + MIN_DAYS * DAY, ...inside.map((item) => item.at))
  const span = end - now

  // A chip is `gap` wide from its dot, so a later dot within `gap` lies under it. Each chip goes above every later chip it
  // overlaps, so every dot's stem stays visible up to its own chip (processed from the last date back).
  const onAxis = dated.filter((item) => item.at <= horizon)
  const positions = onAxis.map((item) => Math.min(1, Math.max(0, (item.at - now) / span)))
  const lanes: number[] = []
  for (let i = onAxis.length - 1; i >= 0; i--) {
    let lane = 0
    for (let j = i + 1; j < onAxis.length; j++) {
      if ((positions[j] ?? 0) - (positions[i] ?? 0) < gap) lane = Math.max(lane, (lanes[j] ?? 0) + 1)
    }
    lanes[i] = lane
  }
  let later = 0
  const items = dated.map(({ node, at }, index): ScheduleItem => {
    if (at > horizon) return { node, at, position: 1, lane: later++, later: true, due: false }
    return { node, at, position: positions[index] ?? 0, lane: lanes[index] ?? 0, later: false, due: at <= now }
  })

  const unit = span / DAY <= DAY_TICKS_UP_TO ? 'day' : 'week'
  const ticks: ScheduleTick[] = []
  for (const date = midnightAfter(now); date.getTime() <= end; date.setDate(date.getDate() + 1)) {
    if (unit === 'week' && date.getDay() !== 1) continue
    ticks.push({ at: date.getTime(), position: (date.getTime() - now) / span, label: tickLabel(date, unit) })
  }
  return { start: now, end, unit, ticks, items, lanes: Math.max(0, ...lanes) + (lanes.length > 0 ? 1 : 0) }
}

/** "Waits for A" or "Waits for A and 2 more": the blockers of a node that have not closed; none: null. */
export function waitsForWords(id: string, edges: ChainEdge[], byId: Map<string, ChainNode>): string | null {
  const open = edges.filter((edge) => edge.from === id && isBlocked(edge))
  const first = open[0] && byId.get(open[0].to)
  if (!first) return null
  return open.length === 1 ? `Waits for ${first.title}` : `Waits for ${first.title} and ${open.length - 1} more`
}

/** What a node's reason line says and which icon it takes: a date, an open blocker, or the state in `docs/language.md`'s words. */
export interface NodeReason {
  text: string
  /** the UTC instant for a date */
  title?: string
  icon: 'clock' | 'hourglass' | 'state'
}

const STATE_REASON: Record<string, string> = {
  settling: 'Triage is not done',
  queued: 'Ready to start',
  working: 'A lead is working',
  watching: 'Shipped, the watch is on',
  waiting: 'A named wait',
  closed: 'Closed, no longer blocks',
}

/**
 * The one factual line under a node's chips: a plan row's date, then a `dependency` wait as who it waits for, an Issue's other wait reason as Flow shows it, then who it waits for,
 * then what its state means. A row with none of these has no line.
 */
export function reasonOf(node: ChainNode, waitsFor: string | null, now: number = Date.now()): NodeReason | null {
  if (node.kind === 'row' && node.notBefore) {
    const date = notBeforeReason(node.notBefore, now)
    return { text: date.text, title: date.title, icon: 'clock' }
  }
  if (node.state === 'closed') return { text: STATE_REASON.closed ?? '', icon: 'state' }
  // a `dependency` wait is the chain itself: name the open blocker; any other wait reason is worded as Flow words it
  if (node.waitReason === 'dependency' && waitsFor) return { text: waitsFor, icon: 'hourglass' }
  if (node.waitReason) return { text: node.waitReason, icon: 'state' }
  if (waitsFor) return { text: waitsFor, icon: 'hourglass' }
  if (node.kind === 'row') return node.state === 'filable' ? { text: 'Nothing holds it back', icon: 'state' } : null
  const text = STATE_REASON[node.state]
  return text ? { text, icon: 'state' } : null
}
