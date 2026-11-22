import type { IssueSize, OpenIssueState } from '@software-factory/contract'
import { type IssueId, issueNumber } from '../../kernel/ids.ts'
import { type Edge, openBlockers } from './chain.ts'

/** The Issue kind that stops the line: an incident is a fix and is urgent. */
const FIX_KIND = 'incident'

/** An Issue that is not closed, as the queue sees it. */
export interface OpenIssue {
  id: IssueId
  /** the project it belongs to; null while its repo names no project the factory knows */
  project: string | null
  kind: string
  state: OpenIssueState
  /** why it waits, when it does */
  waitReason: string | null
  /** a lead of an earlier attempt is still being finalized */
  finalizing: boolean
  /** the Spec its filer attached has no verdict yet: the owner has not seen it, and the 24 hours have not run out */
  specPending: boolean
  /** triage's size; absent or null when it judged none (read as medium) */
  size?: IssueSize | null | undefined
  /** since when it has been in this state: a queued Issue's age in the queue; absent or null counts no ageing */
  since?: Date | null | undefined
}

/** Why a queued Issue is not a candidate this round, in the words of the chain. */
export type ChainReason =
  | { kind: 'chain'; message: string; waitsFor: IssueId[] }
  | { kind: 'line'; message: string }
  | { kind: 'finalizing'; message: string }
  | { kind: 'spec'; message: string }
  | { kind: 'unknown_project'; message: string }

export interface Ordered {
  issue: OpenIssue
  prio: number
  /** the owner's priority of its project; 0 when none */
  projectPrio: number
  /** true when the project's priority put this Issue ahead of a candidate of another project at the same Issue prio */
  byProjectPrio: boolean
  /** set when the chain keeps this Issue out of the candidates */
  reason: ChainReason | null
  /** for an Issue its `after` edges hold: what would keep it out with those edges gone (null: nothing of the chain's) */
  withoutEdges: ChainReason | null
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
    if (issue.finalizing || issue.specPending || openBlockers(edges, issue.id).length > 0) continue
    if (!stopped.has(issue.project)) stopped.set(issue.project, issue.id)
  }
  return stopped
}

/** What finishes sooner starts first: the rank of a size, an unsized Issue read as medium. */
const SIZE_RANK: Record<IssueSize, number> = { small: 0, medium: 1, large: 2 }
const UNSIZED_RANK = SIZE_RANK.medium

/** A queued Issue moves up one size rank for every this long it has waited, so a large one is not starved (12 hours at most). */
const AGEING_STEP_MS = 6 * 3_600_000

/**
 * The throughput key of a queued Issue: its size rank less one for each `AGEING_STEP_MS` it has waited, never below
 * zero (the rank of a small one). Lower runs first.
 */
function throughputKey(issue: OpenIssue, now: Date | undefined): number {
  const rank = issue.size ? SIZE_RANK[issue.size] : UNSIZED_RANK
  if (!now || !issue.since) return rank
  const steps = Math.floor(Math.max(0, now.getTime() - issue.since.getTime()) / AGEING_STEP_MS)
  return Math.max(0, rank - steps)
}

/**
 * The queued Issues in the order they are looked at, first rule first: the fix of a stopped line (an incident), then
 * dependencies (an Issue with an open blocker, or a filed Spec without a verdict, is no candidate: it follows the others, carrying its reason), then the
 * owner's `prio` (higher first, never overridden), then the owner's priority of its project (higher first), then age (the lower Issue number). Each Issue carries the chain's
 * reason when it is not a candidate.
 *
 * Within one project and one prio the order is for throughput: what finishes sooner first (`throughputKey`, with
 * ageing), then the queue model's own order (`modelOrder`, an Issue it did not place last), then the lower Issue number.
 * Only the places of one project's Issues of one prio are exchanged among themselves: the owner's prio, the chain and
 * the interleaving of projects stay as the first rules made them.
 */
export function orderQueue(input: {
  open: readonly OpenIssue[]
  edges: readonly Edge[]
  prio: ReadonlyMap<IssueId, number>
  /** the owner's priority per project name; a project not in it counts 0 */
  projectPrio?: ReadonlyMap<string, number> | undefined
  now?: Date | undefined
  /** the position of each Issue in the newest order the queue model gave its repo */
  modelOrder?: ReadonlyMap<IssueId, number> | undefined
}): Ordered[] {
  const stopped = stoppedProjects(input.open, input.edges)
  const rows = input.open
    .filter((issue) => issue.state === 'queued')
    .map((issue): Ordered => ({
      issue,
      prio: input.prio.get(issue.id) ?? 0,
      projectPrio: issue.project === null ? 0 : (input.projectPrio?.get(issue.project) ?? 0),
      byProjectPrio: false,
      reason: reasonOf(issue, input.edges, stopped),
      withoutEdges: reasonOf(issue, [], stopped),
    }))
  const rank = (row: Ordered): number => (row.reason !== null ? 2 : isFix(row.issue) ? 0 : 1)
  rows.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      b.prio - a.prio ||
      b.projectPrio - a.projectPrio ||
      issueNumber(a.issue.id) - issueNumber(b.issue.id),
  )
  // The project priority decided a place when a row stands elsewhere in its band (one class, one Issue prio) than its Issue number alone would put it.
  const bands = new Map<string, Ordered[]>()
  for (const row of rows) bands.set(`${rank(row)}|${row.prio}`, [...(bands.get(`${rank(row)}|${row.prio}`) ?? []), row])
  for (const band of bands.values()) {
    const byNumber = [...band].sort((a, b) => issueNumber(a.issue.id) - issueNumber(b.issue.id))
    band.forEach((row, at) => {
      row.byProjectPrio = byNumber[at] !== row
    })
  }

  const model = (row: Ordered): number => input.modelOrder?.get(row.issue.id) ?? Number.POSITIVE_INFINITY
  const sooner = (a: Ordered, b: Ordered): number =>
    throughputKey(a.issue, input.now) - throughputKey(b.issue, input.now) ||
    (model(a) === model(b) ? 0 : model(a) < model(b) ? -1 : 1) ||
    issueNumber(a.issue.id) - issueNumber(b.issue.id)
  const groups = new Map<string, number[]>()
  rows.forEach((row, at) => {
    if (row.reason !== null) return
    const groupKey = `${rank(row)}|${row.prio}|${row.issue.project ?? ''}`
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), at])
  })
  const placed = [...rows]
  for (const places of groups.values()) {
    const members = places.map((at) => rows[at] as Ordered).sort(sooner)
    places.forEach((at, i) => {
      placed[at] = members[i] as Ordered
    })
  }
  return placed
}

function reasonOf(issue: OpenIssue, edges: readonly Edge[], stopped: ReadonlyMap<string, IssueId>): ChainReason | null {
  const blockers = openBlockers(edges, issue.id)
  if (blockers.length > 0) {
    // An edge nobody stated says who inferred it and why, so the wait can be judged at a glance.
    const inferredBy = new Map(
      edges.filter((e) => e.issue === issue.id && !e.satisfied && e.inferredBy).map((e) => [e.after, e.inferredBy]),
    )
    const list = blockers
      .map((b) => `Issue ${issueNumber(b)}${inferredBy.has(b) ? ` (inferred by ${inferredBy.get(b)})` : ''}`)
      .join(', ')
    return { kind: 'chain', message: `waits for ${list} to close`, waitsFor: blockers }
  }
  if (issue.specPending) {
    return { kind: 'spec', message: "the Spec it was filed with waits for the owner's verdict (24 hours at most)" }
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
