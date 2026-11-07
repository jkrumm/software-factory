import { type IssueId, issueNumber } from '../../kernel/ids.ts'
import { type Edge, openBlockers } from './chain.ts'

/** The Issue kind that stops the line: an incident is a fix and is urgent. */
export const FIX_KIND = 'incident'

/** An Issue that is not closed, as the queue sees it. */
export interface OpenIssue {
  id: IssueId
  /** the project it belongs to; null while its repo names no project the factory knows */
  project: string | null
  kind: string
  state: 'settling' | 'queued' | 'working' | 'waiting' | 'watching'
  /** why it waits, when it does */
  waitReason: string | null
  /** a lead of an earlier attempt is still being finalized */
  finalizing: boolean
}

/** Why a queued Issue is not a candidate this round, in the words of the chain. */
export type ChainReason =
  | { kind: 'chain'; message: string; waitsFor: IssueId[] }
  | { kind: 'line'; message: string }
  | { kind: 'finalizing'; message: string }
  | { kind: 'unknown_project'; message: string }

export interface Ordered {
  issue: OpenIssue
  prio: number
  /** set when the chain keeps this Issue out of the candidates */
  reason: ChainReason | null
}

const isFix = (issue: OpenIssue): boolean => issue.kind === FIX_KIND

/**
 * The projects whose line is stopped: while a project has an incident Issue queued or working that nothing blocks,
 * production there is red, and only fixes are admitted. A waiting or watching incident stops nothing (an owner
 * decision never freezes a repo), and a lead already running is never touched.
 */
export function stoppedProjects(open: readonly OpenIssue[], edges: readonly Edge[]): Map<string, IssueId> {
  const stopped = new Map<string, IssueId>()
  for (const issue of open) {
    if (!isFix(issue) || issue.project === null) continue
    if (issue.state !== 'queued' && issue.state !== 'working') continue
    if (issue.finalizing || openBlockers(edges, issue.id).length > 0) continue
    if (!stopped.has(issue.project)) stopped.set(issue.project, issue.id)
  }
  return stopped
}

/**
 * The queued Issues in the order they are looked at, first rule first: the fix of a stopped line (an incident), then
 * dependencies (an Issue with an open blocker is no candidate: it follows the others, carrying its reason), then the
 * owner's `prio` (higher first, never overridden), then age (the lower Issue number). Each Issue carries the chain's
 * reason when it is not a candidate.
 */
export function orderQueue(input: {
  open: readonly OpenIssue[]
  edges: readonly Edge[]
  prio: ReadonlyMap<IssueId, number>
}): Ordered[] {
  const stopped = stoppedProjects(input.open, input.edges)
  const rows = input.open
    .filter((issue) => issue.state === 'queued')
    .map((issue): Ordered => ({
      issue,
      prio: input.prio.get(issue.id) ?? 0,
      reason: reasonOf(issue, input.edges, stopped),
    }))
  const rank = (row: Ordered): number => (row.reason !== null ? 2 : isFix(row.issue) ? 0 : 1)
  return rows.sort((a, b) => rank(a) - rank(b) || b.prio - a.prio || issueNumber(a.issue.id) - issueNumber(b.issue.id))
}

function reasonOf(issue: OpenIssue, edges: readonly Edge[], stopped: ReadonlyMap<string, IssueId>): ChainReason | null {
  const blockers = openBlockers(edges, issue.id)
  if (blockers.length > 0) {
    const list = blockers.map((b) => `Issue ${issueNumber(b)}`).join(', ')
    return { kind: 'chain', message: `waits for ${list} to close`, waitsFor: blockers }
  }
  if (issue.project === null) {
    return { kind: 'unknown_project', message: 'its repo is no project the factory has read yet' }
  }
  if (issue.finalizing) {
    return { kind: 'finalizing', message: 'the previous attempt is still being finalized' }
  }
  const line = stopped.get(issue.project)
  if (line && !isFix(issue)) {
    return {
      kind: 'line',
      message: `production of ${issue.project} is red (Issue ${issueNumber(line)}): only fixes run`,
    }
  }
  return null
}
