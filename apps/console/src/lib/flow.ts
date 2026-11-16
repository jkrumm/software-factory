import {
  type FlowCount,
  FLOW_COUNT_STATES,
  flowCountOfState,
  flowCountsOf,
  FLOW_STATES,
  type FlowModel,
  type FlowState,
  type FlowTrendSeries,
} from '@software-factory/contract'
import type { IssueKind } from '@/components/kit/kind-badge'
import type { LozengeState } from '@/components/kit/lozenge'
import { ageWords } from '@/lib/age'

/** An Issue's state, or `closed` for one that is done, dropped, healed or cancelled lately: the key of `cardsOf`. */
export type StateKey = FlowState | 'closed'
export const STATE_KEYS: readonly StateKey[] = [...FLOW_STATES, 'closed']

/** What the list can be opened on: one of the three counts (working takes watching in, queued takes settling in) or what closed lately. */
export const LIST_STATES = ['working', 'waiting', 'queued', 'closed'] as const
export type ListState = (typeof LIST_STATES)[number]

export const LIST_LABEL: Record<ListState, string> = {
  working: 'Working',
  waiting: 'Waiting',
  queued: 'Queued',
  closed: 'Closed recently',
}

/** A `state` search value that names a list, or undefined. */
export const listStateOf = (value: unknown): ListState | undefined => LIST_STATES.find((key) => key === value)

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

/** One Issue as the list and the project page show it: the same shape for an open and a closed Issue. `since` is when it entered its state (closed: when it closed). */
export interface FlowCard {
  key: string
  /** the Issue's number, the address of its page (`/issues/<number>`) */
  number: number
  title: string
  repo: string
  origin: string
  kind: IssueKind
  /** the Issue's state, or a closed Issue's outcome */
  state: LozengeState
  /** the queue or wait reason, or the outcome of a closed one; null: no line */
  reason: string | null
  since: string
}

export interface FlowFilters {
  project?: string
  origin?: string
  /** Chooses which Issues the list shows (`/flow?state=working`); it never filters the cards of `cardsOf`. */
  state?: ListState
}

/** What a project or origin has open, split by the one definition of the three counts (`FLOW_COUNT_STATES`): Issues, never sessions. */
export type OpenSplit = Record<FlowCount, number>

/**
 * The open Issues of each project or origin, split into working, waiting and queued, before any filter. A closed Issue is
 * never counted, so a value whose Issues all closed has no entry at all.
 */
export function openSplits(data: FlowModel, field: 'repo' | 'origin'): Record<string, OpenSplit> {
  const splits: Record<string, OpenSplit> = {}
  for (const state of FLOW_STATES) {
    const count = flowCountOfState(state)
    if (!count) continue
    for (const issue of data.states[state].issues) {
      const split = (splits[issue[field]] ??= { working: 0, waiting: 0, queued: 0 })
      split[count] += 1
    }
  }
  return splits
}

/** The three counts of the whole factory: what the strip, the stat cards and the project digests show. */
export const flowCounts = (data: FlowModel): Record<FlowCount, number> =>
  flowCountsOf(
    Object.fromEntries(FLOW_STATES.map((state) => [state, data.states[state].count])) as Record<FlowState, number>,
  )

export type Cards = Record<StateKey, FlowCard[]>

const keep = (filters: FlowFilters, card: { repo: string; origin: string }): boolean =>
  (!filters.project || card.repo === filters.project) && (!filters.origin || card.origin === filters.origin)

/** The cards of every state under the project and origin filters, in the order the server sent them. */
export function cardsOf(data: FlowModel, filters: FlowFilters = {}): Cards {
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

export const countsOf = (cards: Cards): Record<StateKey, number> =>
  Object.fromEntries(STATE_KEYS.map((key) => [key, cards[key].length])) as Record<StateKey, number>

/** The Issues in a state other than closed: the one "open" figure of the sidebar and the Flow page's note. */
export const openCount = (counts: Record<StateKey, number>): number =>
  FLOW_STATES.reduce((sum, state) => sum + counts[state], 0)

/** "12 open, 3 closed in the last day" */
export function flowNote(counts: Record<StateKey, number>): string {
  return `${openCount(counts)} open, ${counts.closed} closed in the last day`
}

/**
 * The Issues the list shows: a count's states together (the number the strip and the stat card show), what closed lately,
 * or with no `state` every open Issue and then what closed lately. The project and origin filters are already in `cards`.
 */
export function listOf(cards: Cards, state?: ListState): FlowCard[] {
  if (state === 'closed') return cards.closed
  if (state) return FLOW_COUNT_STATES[state].flatMap((key) => cards[key])
  return STATE_KEYS.flatMap((key) => cards[key])
}

export type SortKey = 'number' | 'title' | 'project' | 'origin' | 'state' | 'since'
export interface Sort {
  key: SortKey
  direction: 'asc' | 'desc'
}

/** What the list opens sorted by: what has been in its state longest first, what closed lately newest first. */
export const defaultSort = (state?: ListState): Sort => ({
  key: 'since',
  direction: state === 'closed' ? 'desc' : 'asc',
})

/** The order a column of the list starts in when it is pressed: the words ascending, the number and the time newest first. */
export const startSort = (key: SortKey): Sort => ({ key, direction: key === 'number' ? 'desc' : 'asc' })

const SORT_VALUE: Record<SortKey, (card: FlowCard) => number | string> = {
  number: (card) => card.number,
  title: (card) => card.title.toLowerCase(),
  project: (card) => card.repo,
  origin: (card) => originWord(card.origin),
  state: (card) => card.state,
  since: (card) => Date.parse(card.since),
}

/** A sorted copy: ties keep the order they came in, so a re-sort never shuffles equal rows. */
export function sortedCards(cards: readonly FlowCard[], sort: Sort): FlowCard[] {
  const value = SORT_VALUE[sort.key]
  const sign = sort.direction === 'asc' ? 1 : -1
  return [...cards].sort((a, b) => {
    const x = value(a)
    const y = value(b)
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * sign
  })
}

/** The project the whole list belongs to when it is one, for the chain link; null when the rows span several. */
export function singleProject(cards: readonly FlowCard[]): string | null {
  const repos = new Set(cards.map((card) => card.repo))
  return repos.size === 1 ? ([...repos][0] ?? null) : null
}

/** The count each stat card shows, and the card's address: `/flow?state=<count>` (the list of the Issues it counts). */
export const STAT_STATES = ['working', 'waiting', 'queued'] as const

/** Issues of the states a count takes in (`FLOW_COUNT_STATES`), in the order the server sent them. */
const issuesOf = (data: FlowModel, count: FlowCount) =>
  FLOW_COUNT_STATES[count].flatMap((state) => data.states[state].issues)

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
  /** the list the card opens on /flow */
  state: ListState
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

/** The four stat cards: factory-wide, so never from the filtered cards. */
export function statsOf(data: FlowModel, now: number): FlowStat[] {
  const { trend } = data
  const issues = (count: FlowCount) => issuesOf(data, count)
  const labels = trend.at.map(shortDate)
  const xLabels = xLabelsOf(trend.at)
  const counts = flowCounts(data)
  const line = (count: (typeof STAT_STATES)[number]) => {
    // the daily samples of the count: the sum of the states it takes in, as the figure above them is
    const series = trend.at.map((_, i) =>
      FLOW_COUNT_STATES[count].reduce((total, state) => total + (trend.states[state][i] ?? 0), 0),
    )
    return {
      key: count,
      value: counts[count],
      delta: (series.at(-1) ?? 0) - (series[0] ?? 0),
      series,
      labels,
      xLabels,
      subtitle: 'Issues, vs 7 days ago',
      state: count,
    } as const
  }
  const watching = data.states.watching.count
  const settling = data.states.settling.count
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
          : `in ${plural(distinct(issues('working').map((i) => i.repo)), 'project')}${watching > 0 ? `, ${watching} of them watching` : ''}`,
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
          : [
              countWords(
                data.states.queued.issues.map((i) => i.queue?.kind ?? null),
                'ready',
              ),
              settling > 0 ? `${settling} settling` : '',
            ]
              .filter(Boolean)
              .join(', '),
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

/** The ranges of the trend chart's control: a window and the one bucket it is plotted by (24 hours and 7 days by the hour, 30 days by the day). */
export const TREND_RANGES = [
  { key: '24h', window: '24h', bucket: 'hour', label: '24 h' },
  { key: '7d', window: '7d', bucket: 'hour', label: '7 d' },
  { key: '30d', window: '30d', bucket: 'day', label: '30 d' },
] as const satisfies readonly {
  key: FlowTrendSeries['window']
  window: FlowTrendSeries['window']
  bucket: FlowTrendSeries['bucket']
  label: string
}[]
export type TrendRange = (typeof TREND_RANGES)[number]

/** What the chart opens on: 7 days by the hour, the server's default as well. */
export const DEFAULT_TREND_RANGE: TrendRange = TREND_RANGES[1]

/** A bucket's start as the chart words it: an hour in the viewer's zone, a day as its UTC date (the buckets sit on UTC days). */
export function bucketWords(at: number, bucket: FlowTrendSeries['bucket']): string {
  const date = new Date(at)
  if (bucket === 'day')
    return `${date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}`
  return `${date.toLocaleDateString('en-GB', { weekday: 'short' })} ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
}

/** One count of the trend as the chart plots it: the bucket starts, and the peak and the average of each bucket. */
export function trendLines(series: FlowTrendSeries, count: FlowCount) {
  return {
    times: series.buckets.map((b) => Date.parse(b.at)),
    peak: series.buckets.map((b) => b[count].peak),
    avg: series.buckets.map((b) => b[count].avg),
  }
}
