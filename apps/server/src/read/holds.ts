import type { ChainModel } from '@software-factory/contract'

/** What waits behind one node of the chain: open Issues and plan rows not yet filed, each with what it waits on directly. */
export interface Held {
  issues: { issue: string; after: string[] }[]
  /** `project:key` */
  rows: { row: string; after: string[] }[]
}

const ROW_PREFIX = 'row:'
const byId = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true })

/** A chain node id as a plan or a brief names it: an Issue's id, a row's `project:key`. */
export const nodeName = (id: string): string => (id.startsWith(ROW_PREFIX) ? id.slice(ROW_PREFIX.length) : id)

/**
 * The read of what each node holds, over the chain's open edges (an edge whose blocker closed holds nothing): every node
 * that waits behind it, directly or through others. Pure; the chain is read once and asked per head.
 */
export function holdsOf(chain: Pick<ChainModel, 'edges'>): (head: string) => Held {
  const dependents = new Map<string, Set<string>>()
  const blockers = new Map<string, Set<string>>()
  for (const edge of chain.edges) {
    if (edge.closed) continue
    dependents.set(edge.to, (dependents.get(edge.to) ?? new Set()).add(edge.from))
    blockers.set(edge.from, (blockers.get(edge.from) ?? new Set()).add(edge.to))
  }
  return (head) => {
    const seen = new Set<string>()
    const queue = [head]
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      for (const dependent of dependents.get(next) ?? []) {
        if (dependent === head || seen.has(dependent)) continue
        seen.add(dependent)
        queue.push(dependent)
      }
    }
    const after = (id: string): string[] => [...(blockers.get(id) ?? [])].map(nodeName).sort(byId)
    const ids = [...seen].sort(byId)
    return {
      issues: ids.filter((id) => !id.startsWith(ROW_PREFIX)).map((issue) => ({ issue, after: after(issue) })),
      rows: ids.filter((id) => id.startsWith(ROW_PREFIX)).map((id) => ({ row: nodeName(id), after: after(id) })),
    }
  }
}
