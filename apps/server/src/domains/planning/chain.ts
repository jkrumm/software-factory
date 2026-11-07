import type { IssueId } from '../../kernel/ids.ts'

/**
 * An edge of the chain: `issue` runs only after `after` has closed, in any outcome (a stopped blocker releases what
 * waits for it). An edge is satisfied once, when its blocker is seen closed; a blocker that reopens holds nobody back.
 */
export interface Edge {
  issue: IssueId
  after: IssueId
  satisfied: boolean
}

/** The blockers of an Issue that have not closed yet. */
export const openBlockers = (edges: readonly Edge[], issue: IssueId): IssueId[] =>
  edges.filter((edge) => edge.issue === issue && !edge.satisfied).map((edge) => edge.after)

/**
 * The path that adding `issue -> after` would close into a cycle (`after` waits, through open edges, for `issue`), from
 * `after` to `issue`; undefined when it closes none. An Issue is not after itself.
 */
export function cycleThrough(edges: readonly Edge[], issue: IssueId, after: IssueId): IssueId[] | undefined {
  if (issue === after) return [issue, after]
  const next = new Map<IssueId, IssueId[]>()
  for (const edge of edges) if (!edge.satisfied) next.set(edge.issue, [...(next.get(edge.issue) ?? []), edge.after])
  const walk = (at: IssueId, path: IssueId[], seen: Set<IssueId>): IssueId[] | undefined => {
    if (at === issue) return [...path, at]
    if (seen.has(at)) return undefined
    seen.add(at)
    for (const on of next.get(at) ?? []) {
      const found = walk(on, [...path, at], seen)
      if (found) return found
    }
    return undefined
  }
  return walk(after, [], new Set())
}

/** Edges whose blocker is closed and which are not yet recorded as satisfied. */
export const newlySatisfied = (edges: readonly Edge[], closed: ReadonlySet<IssueId>): Edge[] =>
  edges.filter((edge) => !edge.satisfied && closed.has(edge.after))
