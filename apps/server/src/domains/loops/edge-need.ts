import type { IssueId } from '../../kernel/ids.ts'
import { issueNumber } from '../../kernel/ids.ts'
import { meaningfulPaths, sharesPath } from '../../kernel/edge-need.ts'

/** A blocker that waits on the owner this long no longer holds the Issues behind it back (the owner's own prio and edges stay). */
export const OWNER_WAIT_MS = 6 * 3_600_000

/** The waits of an Issue that need the owner: a Decision, a Spec or Concept verdict, an Errand. */
export const OWNER_WAITS: ReadonlySet<string> = new Set(['decision', 'review', 'errand'])

/** An edge the factory added and that still holds an Issue back, with what the sweep needs to judge it. */
export interface HeldEdge {
  issue: IssueId
  after: IssueId
  /** `triage: …` or `queue: …`: an edge nobody stated always has one */
  inferredBy: string
  /** the state of the Issue the edge holds back; only a queued one is swept */
  issueState: string
  blockerState: string
  blockerWait: string | null
  /** since when the blocker has been in its state */
  blockerSince: Date | null
  /** every path the shipped commits of the Issue touched; null while it shipped nothing (its files are not known) */
  issuePaths: string[] | null
  blockerPaths: string[] | null
}

export type RemovalKind = 'disjoint' | 'owner_wait'

export interface EdgeRemoval {
  issue: IssueId
  after: IssueId
  kind: RemovalKind
  reason: string
}

/**
 * The factory-added edges to take back. Only an edge with `inferredBy` is ever judged (the caller reads no other), and
 * only for an Issue that is still queued. An edge goes when
 * - the files of the two Issues turned out disjoint: both shipped, and no meaningful path is in both, or
 * - its blocker has waited on the owner for more than `ownerWaitMs`.
 */
export function sweepEdges(
  edges: readonly HeldEdge[],
  now: Date,
  options: { ownerWaitMs?: number } = {},
): EdgeRemoval[] {
  const ownerWaitMs = options.ownerWaitMs ?? OWNER_WAIT_MS
  const removals: EdgeRemoval[] = []
  for (const edge of edges) {
    if (!edge.inferredBy || edge.issueState !== 'queued') continue
    const blocker = `Issue ${issueNumber(edge.after)}`
    if (edge.issuePaths && edge.blockerPaths && !sharesPath(edge.issuePaths, edge.blockerPaths)) {
      removals.push({
        issue: edge.issue,
        after: edge.after,
        kind: 'disjoint',
        reason: `the files turned out disjoint (${meaningfulPaths(edge.issuePaths).length} paths of the Issue, ${meaningfulPaths(edge.blockerPaths).length} of ${blocker}, none shared)`,
      })
      continue
    }
    if (
      edge.blockerState === 'waiting' &&
      edge.blockerWait !== null &&
      OWNER_WAITS.has(edge.blockerWait) &&
      edge.blockerSince !== null &&
      now.getTime() - edge.blockerSince.getTime() > ownerWaitMs
    ) {
      const hours = Math.floor((now.getTime() - edge.blockerSince.getTime()) / 3_600_000)
      removals.push({
        issue: edge.issue,
        after: edge.after,
        kind: 'owner_wait',
        reason: `${blocker} has waited on the owner (${edge.blockerWait}) for ${hours} hours`,
      })
    }
  }
  return removals
}
