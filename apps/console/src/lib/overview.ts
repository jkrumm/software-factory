import {
  OPEN_ISSUE_STATES,
  type FlowModel,
  type NeedItem,
  type NeedsModel,
  type ProjectIndexRow,
} from '@software-factory/contract'
import { queueReasonWords } from './improve.ts'

/** How many needs the Overview names; the rest are the count. */
const TOP_NEEDS = 3

/** What wants the owner: the total and the oldest few (the longest open first: they cost the most). */
export function needsOf(model: Pick<NeedsModel, 'items'>): { total: number; top: NeedItem[] } {
  const top = [...model.items].sort((a, b) => b.ageMs - a.ageMs).slice(0, TOP_NEEDS)
  return { total: model.items.length, top }
}

export interface ProjectCount {
  project: string
  count: number
}

const byCount = (counts: Map<string, number>): ProjectCount[] =>
  [...counts]
    .map(([project, count]) => ({ project, count }))
    .sort((a, b) => b.count - a.count || a.project.localeCompare(b.project))

const tally = (repos: readonly string[]): ProjectCount[] => {
  const counts = new Map<string, number>()
  for (const repo of repos) counts.set(repo, (counts.get(repo) ?? 0) + 1)
  return byCount(counts)
}

/**
 * Production as the open Issues tell it: a project is red while an incident Issue of it is open, and a ship is in its
 * Checking window while its Issue is in Watch. Regressions come from the project index (`regressedOf`).
 */
export function productionOf(data: Pick<FlowModel, 'states'>): { red: ProjectCount[]; checking: ProjectCount[] } {
  const open = OPEN_ISSUE_STATES.flatMap((state) => data.states[state].issues)
  return {
    red: tally(open.filter((issue) => issue.kind === 'incident').map((issue) => issue.repo)),
    checking: tally(data.states.watching.issues.map((issue) => issue.repo)),
  }
}

/**
 * Projects whose newest watch regressed in the last 7 days and that have no open incident (those are red already), the
 * newest regression first: the lamp the Projects table shows, so the Overview and the table agree.
 */
export function regressedOf(rows: readonly Pick<ProjectIndexRow, 'name' | 'production'>[]): ProjectCount[] {
  return rows
    .filter((row) => row.production.incidents === 0 && row.production.regressionAt !== null)
    .sort((a, b) => (b.production.regressionAt ?? '').localeCompare(a.production.regressionAt ?? ''))
    .map((row) => ({ project: row.name, count: 1 }))
}

/** What shipped in the last 24 hours (closed done or healed), by project, the most first. */
export function shippedOf(data: Pick<FlowModel, 'closedRecently'>): { total: number; byProject: ProjectCount[] } {
  const shipped = data.closedRecently.filter((issue) => issue.outcome === 'done' || issue.outcome === 'healed')
  return { total: shipped.length, byProject: tally(shipped.map((issue) => issue.repo)) }
}

export interface QueueBinding {
  /** Issues not started: kept out by a reason, or only waiting their turn */
  notStarted: number
  /** the reason that keeps the most of them out, in words, with how many it keeps; null: nothing keeps any out */
  binding: { kind: string; words: string; count: number; message: string } | null
  /** the queue's own state when it is not running freely */
  state: 'pace' | 'drain' | null
}

const DRAIN_PREFIX = 'drain:'

/** A reason in words: a project's drain names the project; the whole queue's drain names the queue. */
const reasonWordsOf = (key: string): string =>
  key.startsWith(DRAIN_PREFIX) ? `${key.slice(DRAIN_PREFIX.length)} is draining` : queueReasonWords(key)

/** Why the queue does not move now: the reason holding the most Issues out, and the message of its first one. A project's drain is its own reason. */
export function queueBindingOf(data: Pick<FlowModel, 'states' | 'queueStates'>): QueueBinding {
  const queued = data.states.queued.issues
  const global = data.queueStates.global
  const counts = new Map<string, number>()
  const firstMessage = new Map<string, string>()
  for (const issue of queued) {
    const queue = issue.queue
    if (!queue) continue
    const key = queue.kind === 'drain' && global !== 'drain' ? `${DRAIN_PREFIX}${issue.repo}` : queue.kind
    counts.set(key, (counts.get(key) ?? 0) + 1)
    if (!firstMessage.has(key)) firstMessage.set(key, queue.message)
  }
  const top = byCount(counts)[0]
  return {
    // Not started is Ready plus Held, the stat card's word: a settling Issue is Held too
    notStarted: queued.length + data.states.settling.issues.length,
    binding: top
      ? {
          kind: top.project,
          words: reasonWordsOf(top.project),
          count: top.count,
          message: firstMessage.get(top.project) ?? '',
        }
      : null,
    state: global === 'run' ? null : global,
  }
}
