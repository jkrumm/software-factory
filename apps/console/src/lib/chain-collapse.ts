import type { ChainEdge, ChainNode } from '@software-factory/contract'
import type { ChainView } from './chain.ts'

/** A chain of this many nodes or fewer (under the filter) is drawn whole; a larger one is collapsed. */
export const COLLAPSE_ABOVE = 60
/** Per project: the plan rows that may file now drawn one by one, and the closed Issues drawn beside the work they unblocked. */
export const READY_BUDGET = 20
export const DONE_BUDGET = 6
/** Per project: the plan rows further out than this many steps from filing share the last group. */
export const STEP_CAP = 4

/** What a group holds: closed Issues, plan rows that may file now (past the budget), or plan rows `step` steps from filing. */
export type GroupBucket = 'done' | 'ready' | `step-${number}`

/** Several nodes of one project folded into one card. Its edges are the members' edges, merged. */
export interface ChainGroup {
  /** `group:<project>:<bucket>`: stable while the data changes, so an expanded group stays expanded */
  id: string
  repo: string
  bucket: GroupBucket
  /** 1..STEP_CAP for a `step-` bucket: how many plan rows must file and finish before the first of these can file (STEP_CAP: that many or more) */
  step: number | null
  members: ChainNode[]
  /** the earliest `notBefore` among the members, or null */
  earliest: string | null
}

export interface CollapsedView extends Omit<ChainView, 'nodes'> {
  /** the nodes drawn one by one */
  nodes: ChainNode[]
  groups: ChainGroup[]
  /** how many nodes the groups hold */
  folded: number
  /** closed Issues no drawn node is joined to: not drawn, in no group */
  dropped: number
}

const NO_PROJECT = ''

const groupId = (repo: string, bucket: GroupBucket): string => `group:${repo}:${bucket}`

const earliestOf = (members: ChainNode[]): string | null =>
  members.reduce<string | null>(
    (least, node) =>
      node.notBefore && (!least || Date.parse(node.notBefore) < Date.parse(least)) ? node.notBefore : least,
    null,
  )

/**
 * How many plan rows must file and close before a row can file: 0 for a row that may file now, else one more than the
 * deepest row it still waits for (an open Issue counts 0, a closed blocker nothing). Memoised; a cycle counts as 0.
 */
function depthsOf(nodes: ChainNode[], edges: ChainEdge[]): Map<string, number> {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const waitsFor = new Map<string, string[]>()
  for (const edge of edges) {
    if (!edge.closed) waitsFor.set(edge.from, [...(waitsFor.get(edge.from) ?? []), edge.to])
  }
  const depths = new Map<string, number>()
  const visiting = new Set<string>()
  const depthOf = (id: string): number => {
    const known = depths.get(id)
    if (known !== undefined) return known
    const node = byId.get(id)
    if (node?.kind !== 'row' || node.state === 'filable' || visiting.has(id)) return 0
    visiting.add(id)
    const deepest = Math.max(0, ...(waitsFor.get(id) ?? []).map(depthOf))
    visiting.delete(id)
    depths.set(id, 1 + deepest)
    return 1 + deepest
  }
  for (const node of nodes) depthOf(node.id)
  return depths
}

/**
 * The view the Chain opens on: every open Issue, the plan rows that may file now, and the closed Issues beside the work
 * they unblocked, each project's rest folded into groups (plan rows by their steps from filing, then closed Issues, then
 * the ready rows past the budget). A chain of `COLLAPSE_ABOVE` nodes or fewer is returned whole. A group in `expanded`
 * is drawn as its members, and the closed Issues those members wait for come with them.
 */
export function collapseOf(view: ChainView, expanded: ReadonlySet<string> = new Set()): CollapsedView {
  if (view.nodes.length <= COLLAPSE_ABOVE) return { ...view, groups: [], folded: 0, dropped: 0 }

  const byId = new Map(view.nodes.map((node) => [node.id, node]))
  const depths = depthsOf(view.nodes, view.edges)
  const neighbours = new Map<string, string[]>()
  for (const edge of view.edges) {
    neighbours.set(edge.from, [...(neighbours.get(edge.from) ?? []), edge.to])
    neighbours.set(edge.to, [...(neighbours.get(edge.to) ?? []), edge.from])
  }
  const repoOf = (node: ChainNode): string => node.repo ?? NO_PROJECT

  // 1. what is drawn one by one: open Issues, ready rows within the budget
  const shown = new Set<string>()
  const readyCount = new Map<string, number>()
  for (const node of view.nodes) {
    if (node.kind === 'issue' && node.state !== 'closed') shown.add(node.id)
    if (node.kind === 'row' && node.state === 'filable') {
      const used = readyCount.get(repoOf(node)) ?? 0
      readyCount.set(repoOf(node), used + 1)
      if (used < READY_BUDGET) shown.add(node.id)
    }
  }
  // a row that blocks a drawn Issue is drawn: the Issue's wait names it
  for (const edge of view.edges) {
    if (edge.closed || !shown.has(edge.from)) continue
    const blocker = byId.get(edge.to)
    if (blocker?.kind === 'row') shown.add(blocker.id)
  }

  // 2. the buckets of the rest
  const bucketOf = (node: ChainNode): GroupBucket => {
    if (node.kind === 'issue') return 'done'
    if (node.state === 'filable') return 'ready'
    return `step-${Math.min(STEP_CAP, Math.max(1, depths.get(node.id) ?? 1))}`
  }
  const members = new Map<string, ChainGroup>()
  const fold = (node: ChainNode): void => {
    const bucket = bucketOf(node)
    const id = groupId(repoOf(node), bucket)
    const group = members.get(id) ?? {
      id,
      repo: repoOf(node),
      bucket,
      step: bucket.startsWith('step-') ? Number(bucket.slice('step-'.length)) : null,
      members: [],
      earliest: null,
    }
    group.members.push(node)
    members.set(id, group)
  }

  // an expanded group is drawn as its members
  const expandedMembers = new Set<string>()
  for (const node of view.nodes) {
    if (node.kind === 'row' && !shown.has(node.id) && expanded.has(groupId(repoOf(node), bucketOf(node)))) {
      shown.add(node.id)
      expandedMembers.add(node.id)
    }
  }

  // closed Issues beside a drawn node: all beside an expanded member, else the newest DONE_BUDGET per project, the rest in
  // a group. One beside nothing drawn has nothing to say and is only counted.
  const drawn = new Set(shown)
  const closed = view.nodes
    .filter((node) => node.kind === 'issue' && node.state === 'closed')
    .toSorted((a, b) => Date.parse(b.since ?? '') - Date.parse(a.since ?? '') || a.id.localeCompare(b.id))
  const doneUsed = new Map<string, number>()
  let dropped = 0
  for (const node of closed) {
    const joined = neighbours.get(node.id) ?? []
    if (!joined.some((id) => drawn.has(id))) {
      dropped++
      continue
    }
    const used = doneUsed.get(repoOf(node)) ?? 0
    doneUsed.set(repoOf(node), used + 1)
    const open = expanded.has(groupId(repoOf(node), 'done'))
    if (joined.some((id) => expandedMembers.has(id)) || used < DONE_BUDGET || open) shown.add(node.id)
    else fold(node)
  }
  for (const node of view.nodes) if (node.kind === 'row' && !shown.has(node.id)) fold(node)

  // a group of one is the node itself
  const groups: ChainGroup[] = []
  const owner = new Map<string, string>()
  for (const group of members.values()) {
    if (group.members.length === 1 && group.members[0]) {
      shown.add(group.members[0].id)
      continue
    }
    group.earliest = earliestOf(group.members)
    groups.push(group)
    for (const node of group.members) owner.set(node.id, group.id)
  }
  groups.sort((a, b) => a.repo.localeCompare(b.repo) || a.id.localeCompare(b.id))

  // 3. edges between what is drawn, merged where several members share an end
  const endOf = (id: string): string | null => (shown.has(id) ? id : (owner.get(id) ?? null))
  const merged = new Map<string, ChainEdge>()
  for (const edge of view.edges) {
    const from = endOf(edge.from)
    const to = endOf(edge.to)
    if (!from || !to || from === to) continue
    const key = `${to}>${from}`
    const known = merged.get(key)
    merged.set(key, { from, to, closed: (known?.closed ?? true) && edge.closed })
  }

  const nodes = view.nodes.filter((node) => shown.has(node.id))
  return {
    nodes,
    groups,
    edges: [...merged.values()],
    isolated: view.isolated,
    folded: groups.reduce((sum, group) => sum + group.members.length, 0),
    dropped,
  }
}

/** `expanded` with the group opened, or closed when it was open. */
export const toggled = (expanded: ReadonlySet<string>, id: string): Set<string> => {
  const next = new Set(expanded)
  if (!next.delete(id)) next.add(id)
  return next
}
