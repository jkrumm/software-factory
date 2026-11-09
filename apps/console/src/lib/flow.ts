import { FLOW_STATES, type FlowModel, type FlowState } from '@software-factory/contract'
import type { IssueKind } from '@/components/kit/kind-badge'
import type { LozengeState } from '@/components/kit/lozenge'
import { ageWords } from '@/lib/age'

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

/**
 * The share of the board a column takes, by what it holds: an empty column is narrow (it has a sentence to say, no
 * titles to fit), a crowded one wider, and Closed recently the widest because it only grows.
 */
export function columnWeight(key: ColumnKey, count: number): number {
  if (count === 0) return 0.6
  const crowded = count >= 10
  if (key === 'closed') return crowded ? 2 : 1.25
  return crowded ? 1.4 : 1
}

/** `grid-template-columns` of the board: each column at least as wide as its cards can read, then its weight. */
export function boardColumns(keys: readonly ColumnKey[], counts: Record<ColumnKey, number>): string {
  return keys.map((key) => `minmax(${counts[key] === 0 ? 11 : 15}rem, ${columnWeight(key, counts[key])}fr)`).join(' ')
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
  /** the Issue's number, the address of its page (`/issues/<number>`) */
  number: number
  title: string
  repo: string
  origin: string
  kind: IssueKind
  /** the column's state, or a closed Issue's outcome */
  state: LozengeState
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
        number: numberOf(issue.id),
        title: issue.title,
        repo: issue.repo,
        origin: issue.origin,
        kind: issue.kind,
        state,
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
        number: numberOf(issue.id),
        title: issue.title,
        repo: issue.repo,
        origin: issue.origin,
        kind: issue.kind,
        state: issue.outcome,
        reason: null,
        since: issue.closedAt,
      })),
  }
}

/** `issue_12` is Issue 12. */
export const numberOf = (id: string): number => Number(id.replace(/^issue_/, ''))

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

/** The Issues in a column other than closed: the one "open" figure of the sidebar and the Flow page's note. */
export const openCount = (counts: Record<ColumnKey, number>): number =>
  FLOW_STATES.reduce((sum, state) => sum + counts[state], 0)

/** "12 open, 3 closed in the last day" */
export function boardNote(counts: Record<ColumnKey, number>): string {
  return `${openCount(counts)} open, ${counts.closed} closed in the last day`
}

/** The state each stat card counts, and the card's address: `/flow?state=<state>`. */
export const STAT_STATES = ['working', 'waiting', 'queued'] as const

export interface FlowStat {
  key: FlowState | 'shipped'
  title: string
  subtitle: string
  value: number
  /** last sample minus first; shipped: this week minus the week before */
  delta: number
  higherIsBetter: boolean
  /** the samples of a line (Issues in the state per day); shipped has bars instead */
  series?: number[]
  bars?: number[]
  /** tooltip labels for the samples or bars */
  labels: string[]
  xLabels: [string, string, string]
  sub: string
  footer: [{ label: string; value: string }, { label: string; value: string }]
  /** the column the card opens on /flow */
  state: ColumnKey
}

const sum = (values: readonly number[]): number => values.reduce((total, n) => total + n, 0)

/** "Nov 8" */
export const shortDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric' })

/** Start, middle and "Now" of the trend's eight daily samples. */
export function xLabelsOf(at: readonly string[]): [string, string, string] {
  return [shortDate(at[0] ?? ''), shortDate(at[Math.floor(at.length / 2) - 1] ?? ''), 'Now']
}

/** "2 decision, 1 review": counts by word, biggest first; null counts as `none`. */
export function countWords(words: readonly (string | null)[], none: string): string {
  const counts = new Map<string, number>()
  for (const word of words) {
    const key = (word ?? none).replaceAll('_', ' ')
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([word, n]) => `${n} ${word}`)
    .join(', ')
}

/** The longest time any of the Issues has been in its state: "3 h", or "None". */
export function longestWords(since: readonly string[], now: number): string {
  if (since.length === 0) return 'None'
  const oldest = Math.min(...since.map((s) => Date.parse(s)))
  return ageWords(Math.max(0, now - oldest)).replace(/ ago$/, '')
}

const distinct = (values: readonly string[]): number => new Set(values).size
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** The four stat cards above the board: factory-wide, so never from the filtered board. */
export function statsOf(data: FlowModel, now: number): FlowStat[] {
  const { trend } = data
  const issues = (state: FlowState) => data.states[state].issues
  const labels = trend.at.map(shortDate)
  const xLabels = xLabelsOf(trend.at)
  const line = (state: (typeof STAT_STATES)[number]) => {
    const series = trend.states[state]
    return {
      key: state,
      value: data.states[state].count,
      delta: (series.at(-1) ?? 0) - (series[0] ?? 0),
      series,
      labels,
      xLabels,
      subtitle: 'vs 7 days ago, all projects',
      state,
    } as const
  }
  const shipped = sum(trend.shipped)
  const queue = data.queueStates.global
  const queueWord = `${queue.charAt(0).toUpperCase()}${queue.slice(1)}`
  return [
    {
      ...line('working'),
      title: 'Working',
      higherIsBetter: true,
      sub:
        issues('working').length === 0
          ? 'Nothing running'
          : `in ${plural(distinct(issues('working').map((i) => i.repo)), 'project')}`,
      footer: [
        {
          label: 'Oldest',
          value: longestWords(
            issues('working').map((i) => i.since),
            now,
          ),
        },
        { label: 'Queue', value: queueWord },
      ],
    },
    {
      ...line('waiting'),
      title: 'Waiting',
      higherIsBetter: false,
      sub:
        issues('waiting').length === 0
          ? 'Nothing waits'
          : countWords(
              issues('waiting').map((i) => i.waitReason),
              'unknown',
            ),
      footer: [
        {
          label: 'Oldest',
          value: longestWords(
            issues('waiting').map((i) => i.since),
            now,
          ),
        },
        { label: 'Projects', value: String(distinct(issues('waiting').map((i) => i.repo))) },
      ],
    },
    {
      ...line('queued'),
      title: 'Queued',
      higherIsBetter: false,
      sub:
        issues('queued').length === 0
          ? 'Nothing queued'
          : countWords(
              issues('queued').map((i) => i.queue?.kind ?? null),
              'ready',
            ),
      footer: [
        {
          label: 'Oldest',
          value: longestWords(
            issues('queued').map((i) => i.since),
            now,
          ),
        },
        { label: 'Projects', value: String(distinct(issues('queued').map((i) => i.repo))) },
      ],
    },
    {
      key: 'shipped',
      title: 'Shipped this week',
      subtitle: 'vs prior week, all projects',
      value: shipped,
      delta: shipped - trend.shippedBefore,
      higherIsBetter: true,
      bars: trend.shipped,
      labels: trend.at.slice(1).map(shortDate),
      xLabels,
      sub: `${trend.shippedBefore} in the 7 days before`,
      footer: [
        { label: 'Best day', value: String(Math.max(0, ...trend.shipped)) },
        { label: 'Last day', value: String(trend.shipped.at(-1) ?? 0) },
      ],
      state: 'closed',
    },
  ]
}
