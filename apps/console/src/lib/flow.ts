import { FLOW_STATES, type FlowModel, type FlowState } from '@software-factory/contract'

export type ColumnKey = FlowState | 'closed'
export const COLUMN_KEYS: readonly ColumnKey[] = [...FLOW_STATES, 'closed']

export const COLUMN_LABEL: Record<ColumnKey, string> = {
  settling: 'Settling',
  queued: 'Queued',
  working: 'Working',
  waiting: 'Waiting',
  watching: 'Watching',
  closed: 'Closed recently',
}

/** An Issue's origin as the word the owner reads. */
export const ORIGIN_LABEL = {
  you: 'You',
  application: 'Application',
  infrastructure: 'Infrastructure',
  github: 'GitHub',
  feedback: 'Feedback',
  factory: 'Factory',
} as const
export type Origin = keyof typeof ORIGIN_LABEL
const ORIGIN_ORDER = Object.keys(ORIGIN_LABEL) as Origin[]

export const OUTCOME_LABEL = { done: 'Done', dropped: 'Dropped', healed: 'Healed', cancelled: 'Cancelled' } as const

export const originWord = (origin: string): string => ORIGIN_LABEL[origin as Origin] ?? origin

/** One card of the board: the same shape for an open and a closed Issue. `since` is when it entered its state (closed: when it closed). */
export interface FlowCard {
  key: string
  title: string
  repo: string
  origin: string
  /** the queue or wait reason, or the outcome of a closed one; null: no line */
  reason: string | null
  since: string
}

export interface FlowFilters {
  project?: string
  origin?: string
  /** Chooses which column shows (`/flow?state=working`); it never filters rows, so `boardOf` ignores it. */
  state?: ColumnKey
}

/** A `state` search value that names a column, or undefined. */
export const columnKeyOf = (value: unknown): ColumnKey | undefined => COLUMN_KEYS.find((key) => key === value)

/** The columns to show: only the chosen one with a `state`, else all of them. */
export const visibleColumns = (state?: ColumnKey): readonly ColumnKey[] => (state ? [state] : COLUMN_KEYS)

/** How many cards each project or origin has across every column, before any filter. */
export function facetCounts(data: FlowModel, field: 'repo' | 'origin'): Record<string, number> {
  const board = boardOf(data)
  const counts: Record<string, number> = {}
  for (const key of COLUMN_KEYS) for (const card of board[key]) counts[card[field]] = (counts[card[field]] ?? 0) + 1
  return counts
}

export type Board = Record<ColumnKey, FlowCard[]>

const keep = (filters: FlowFilters, card: { repo: string; origin: string }): boolean =>
  (!filters.project || card.repo === filters.project) && (!filters.origin || card.origin === filters.origin)

/** The cards of every column under the filters, in the order the server sent them. */
export function boardOf(data: FlowModel, filters: FlowFilters = {}): Board {
  const open = (state: FlowState): FlowCard[] =>
    data.states[state].issues
      .filter((issue) => keep(filters, issue))
      .map((issue) => ({
        key: issue.id,
        title: issue.title,
        repo: issue.repo,
        origin: issue.origin,
        reason: state === 'waiting' ? issue.waitReason : state === 'queued' ? (issue.queue?.message ?? null) : null,
        since: issue.since,
      }))
  return {
    settling: open('settling'),
    queued: open('queued'),
    working: open('working'),
    waiting: open('waiting'),
    watching: open('watching'),
    closed: data.closedRecently
      .filter((issue) => keep(filters, issue))
      .map((issue) => ({
        key: issue.id,
        title: issue.title,
        repo: issue.repo,
        origin: issue.origin,
        reason: OUTCOME_LABEL[issue.outcome],
        since: issue.closedAt,
      })),
  }
}

/** The projects present in the data, sorted. */
export function projectsOf(data: FlowModel): string[] {
  const repos = new Set([...data.perProject.map((p) => p.repo), ...data.closedRecently.map((c) => c.repo)])
  return [...repos].sort((a, b) => a.localeCompare(b))
}

/** The origins present in the data, in the fixed order of the words. */
export function originsOf(data: FlowModel): Origin[] {
  const present = new Set<string>([
    ...FLOW_STATES.flatMap((state) => data.states[state].issues.map((i) => i.origin)),
    ...data.closedRecently.map((c) => c.origin),
  ])
  return ORIGIN_ORDER.filter((origin) => present.has(origin))
}

export const countsOf = (board: Board): Record<ColumnKey, number> =>
  Object.fromEntries(COLUMN_KEYS.map((key) => [key, board[key].length])) as Record<ColumnKey, number>

/** The tab a phone opens on: Working, or the first column with a card. */
export function defaultTab(counts: Record<ColumnKey, number>): ColumnKey {
  if (counts.working > 0) return 'working'
  return COLUMN_KEYS.find((key) => counts[key] > 0) ?? 'working'
}

/** "12 open, 3 closed in the last day" */
export function boardNote(counts: Record<ColumnKey, number>): string {
  const open = FLOW_STATES.reduce((sum, state) => sum + counts[state], 0)
  return `${open} open, ${counts.closed} closed in the last day`
}
