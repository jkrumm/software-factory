import type { QueueAnswer, QueueRequest } from '@software-factory/contract'
import { type IssueId, issueNumber } from '../../kernel/ids.ts'
import type { CallOutcome } from './calls.ts'

/** One open Issue of a repo as the queue loop sees it. */
export interface QueueIssue {
  id: IssueId
  repo: string
  title: string
  kind: string
  state: string
  /** the owner's priority; 0 when never set */
  prio: number
  filedAt: Date
  /** the first words of the signal behind it, '' when none */
  summary: string
  /** the open `after` edges: the Issues it waits for that have not closed */
  blockers: IssueId[]
}

/** An edge the loop may add: `issue` runs only after `after` has closed. */
export interface QueueEdge {
  issue: IssueId
  after: IssueId
  reason: string
}

export interface RefusedEdge {
  issue: string
  after: string
  why: string
}

/** One ask of `factory-queue` as stored (`migrations/0960_queue_asks.sql`). */
export interface QueueAskRow {
  key: string
  repo: string
  shape: string
  round: number
  claimedAt: Date
  leaseUntil: Date
  outcome: CallOutcome | null
  answer: unknown
  /** the edges applied; null until the answer was applied (a crash between the two leaves it null) */
  applied: QueueEdge[] | null
  refused: RefusedEdge[] | null
  /** the shape of the repo's queue after the edges were applied */
  afterShape: string | null
  detail: string | null
  finishedAt: Date | null
}

/** Issues shown to the workflow at most. */
export const MAX_SHOWN = 40
export const MAX_EDGES_PER_ISSUE = 3
export const MAX_EDGES_PER_PASS = 10
export const MAX_TITLE = 500
export const MAX_SUMMARY = 600

const byNumber = (a: QueueIssue, b: QueueIssue): number => issueNumber(a.id) - issueNumber(b.id)

/** The Issues of one repo, grouped for the loop: the repo's rows in a stable order. */
export function byRepo(rows: readonly QueueIssue[]): Map<string, QueueIssue[]> {
  const repos = new Map<string, QueueIssue[]>()
  for (const row of [...rows].sort(byNumber)) repos.set(row.repo, [...(repos.get(row.repo) ?? []), row])
  return new Map([...repos].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** What the workflow is shown: the queued Issues first, then the chain context, at most `MAX_SHOWN`. */
export function shownOf(rows: readonly QueueIssue[]): QueueIssue[] {
  const sorted = [...rows].sort(byNumber)
  return [...sorted.filter((row) => row.state === 'queued'), ...sorted.filter((row) => row.state !== 'queued')].slice(
    0,
    MAX_SHOWN,
  )
}

/** The queued Issues that wait for nothing: the ones a lead could take now, and so the ones to put in order. */
export const candidatesOf = (rows: readonly QueueIssue[]): QueueIssue[] =>
  rows.filter((row) => row.state === 'queued' && row.blockers.length === 0)

/** A cycle through the open edges of these rows, as the path `a -> b -> a`; null when there is none. */
export function cycleIn(rows: readonly QueueIssue[]): IssueId[] | null {
  const next = new Map(rows.map((row) => [row.id, row.blockers]))
  const done = new Set<IssueId>()
  const walk = (node: IssueId, path: IssueId[]): IssueId[] | null => {
    const at = path.indexOf(node)
    if (at >= 0) return [...path.slice(at), node]
    if (done.has(node)) return null
    for (const blocker of next.get(node) ?? []) {
      const found = walk(blocker, [...path, node])
      if (found) return found
    }
    done.add(node)
    return null
  }
  for (const row of [...rows].sort(byNumber)) {
    const found = walk(row.id, [])
    if (found) return found
  }
  return null
}

/**
 * The queue's shape: what an ask depends on. The queued Issues with their priority and open blockers, and the context
 * Issues with their state. Age, title and summary are left out, so time passing does not make a new shape.
 */
export function shapeOf(rows: readonly QueueIssue[]): string {
  const sorted = shownOf(rows).sort(byNumber)
  const queued = sorted
    .filter((row) => row.state === 'queued')
    .map((row) => [row.id, row.prio, [...row.blockers].sort()])
  const context = sorted.filter((row) => row.state !== 'queued').map((row) => [row.id, row.state])
  return new Bun.CryptoHasher('sha256')
    .update(JSON.stringify([queued, context]))
    .digest('hex')
    .slice(0, 16)
}

/** The request for `factory-queue`: the shown Issues, with titles and summaries scrubbed and cut. */
export function requestOf(
  rows: readonly QueueIssue[],
  now: Date,
  clean: (text: string) => string,
): QueueRequest | null {
  const shown = shownOf(rows)
  const first = shown[0]
  if (!first) return null
  return {
    repo: first.repo,
    issues: shown.map((row) => ({
      id: row.id,
      title: clean(row.title).slice(0, MAX_TITLE) || row.id,
      kind: row.kind,
      state: row.state,
      prio: row.prio,
      ageMinutes: Math.max(0, Math.floor((now.getTime() - row.filedAt.getTime()) / 60_000)),
      size: null,
      summary: clean(row.summary).slice(0, MAX_SUMMARY),
      after: row.blockers.slice(0, 20),
    })),
  }
}

export interface Checked {
  accepted: QueueEdge[]
  refused: RefusedEdge[]
}

/**
 * The edges of an answer that may be applied. An edge needs a shown queued Issue that waits and a shown open Issue to wait
 * for, different, not an edge it has already, not a repeat, and never against the owner: a queued Issue the owner ranked
 * higher does not wait for one ranked lower. At most `MAX_EDGES_PER_ISSUE` per Issue and `MAX_EDGES_PER_PASS` in all.
 * `order` is recorded by the caller and never applied.
 */
export function checkQueue(rows: readonly QueueIssue[], answer: QueueAnswer): Checked {
  const shown = new Map(shownOf(rows).map((row) => [row.id as string, row]))
  const accepted: QueueEdge[] = []
  const refused: RefusedEdge[] = []
  const perIssue = new Map<string, number>()
  for (const edge of answer.edges) {
    const refuse = (why: string) => refused.push({ issue: edge.issue, after: edge.after, why })
    const waiting = shown.get(edge.issue)
    const blocker = shown.get(edge.after)
    if (waiting?.state !== 'queued') refuse('not a queued Issue that was shown')
    else if (!blocker) refuse('the Issue to wait for was not shown')
    else if (waiting.id === blocker.id) refuse('an Issue cannot wait for itself')
    else if (waiting.blockers.includes(blocker.id)) refuse('the edge exists already')
    else if (accepted.some((a) => a.issue === waiting.id && a.after === blocker.id)) refuse('named twice')
    else if (blocker.state === 'queued' && blocker.prio < waiting.prio) refuse('against the owner’s priority')
    else if ((perIssue.get(waiting.id) ?? 0) >= MAX_EDGES_PER_ISSUE) refuse('too many edges for one Issue')
    else if (accepted.length >= MAX_EDGES_PER_PASS) refuse('too many edges in one pass')
    else {
      perIssue.set(waiting.id, (perIssue.get(waiting.id) ?? 0) + 1)
      accepted.push({ issue: waiting.id, after: blocker.id, reason: edge.reason })
    }
  }
  return { accepted, refused }
}
