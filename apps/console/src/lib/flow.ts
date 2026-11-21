import {
  addWork,
  emptyWorkCounts,
  ISSUE_ORIGINS,
  type IssueKind,
  type IssueOrigin,
  OPEN_ISSUE_STATES,
  type OpenIssueState,
  type FlowIssue,
  type FlowModel,
  type FlowTrendSeries,
  type HeldSplit,
  type PausedSplit,
  type ReadyLimit,
  WORK_TREND_STATES,
  WORK_WORDS,
  type WorkCounts,
  type WorkTrendKey,
  type WorkWord,
  workOf,
} from '@software-factory/contract'
import type { LozengeState } from '@/components/kit/lozenge'
import { ageWords } from '@/lib/age'
import { pausedReason } from '@/lib/paused-reason'

/** An Issue's place under the five words, or `closed` for one that is done, dropped, healed or cancelled lately: the key of `cardsOf`. */
export type StateKey = WorkWord | 'closed'
export const STATE_KEYS: readonly StateKey[] = [...WORK_WORDS, 'closed']

/** What the list can be opened on: one of the five words or what closed lately. */
const LIST_STATES = STATE_KEYS
export type ListState = StateKey

export const LIST_LABEL: Record<ListState, string> = {
  running: 'Running',
  paused: 'Paused',
  ready: 'Ready',
  held: 'Held',
  checking: 'Checking',
  closed: 'Closed recently',
}

/** Paused, by who or what it waits for (`PausedSplit`), as the words after the count. */
const PAUSED_LABEL: Record<PausedSplit, string> = {
  you: 'on you',
  timer: 'on a timer',
  issue: 'on another Issue',
  stalled: 'stalled',
}

/** Ready, by the one limit that holds it (`ReadyLimit`). */
const READY_LABEL: Record<ReadyLimit, string> = {
  seat: 'room in the allowance',
  host: 'the host',
  repo: "the repo's claims",
  account: "the account's window",
}

/** Held, by what keeps it from starting (`HeldSplit`). */
const HELD_LABEL: Record<HeldSplit, string> = {
  issue: 'behind another Issue',
  line: 'the line is red',
  drain: 'drained',
  spec: 'an open Spec',
  settling: 'being settled',
}

/** "on you 1, on a timer 4": the non-zero parts of a split, in the order of its labels. */
function splitWords(counts: Readonly<Record<string, number>>, labels: Readonly<Record<string, string>>): string {
  return Object.keys(labels)
    .flatMap((key) => (counts[key] ? [`${labels[key]} ${counts[key]}`] : []))
    .join(', ')
}

/** What each word holds and why, for a title: "4 Paused. <definition>" follows with this ("on you 1, stalled 1"). */
export function workSplitWords(work: WorkCounts, word: WorkWord): string {
  if (word === 'paused') return splitWords(work.split.paused, PAUSED_LABEL)
  if (word === 'ready') return splitWords(work.split.ready, READY_LABEL)
  if (word === 'held') return splitWords(work.split.held, HELD_LABEL)
  return ''
}

const LEGACY_STATE: Readonly<Record<OpenIssueState, ListState>> = {
  working: 'running',
  waiting: 'paused',
  queued: 'ready',
  settling: 'held',
  watching: 'checking',
}

/** A `state` search value that names a list, or undefined; the stored names of an old link read as the word that replaced them. */
export const listStateOf = (value: unknown): ListState | undefined =>
  LIST_STATES.find((key) => key === value) ??
  (typeof value === 'string' && Object.hasOwn(LEGACY_STATE, value) ? LEGACY_STATE[value as OpenIssueState] : undefined)

/** An Issue's origin as the word the owner reads. */
const ORIGIN_LABEL: Readonly<Record<IssueOrigin, string>> = {
  you: 'You',
  application: 'Application',
  infrastructure: 'Infrastructure',
  github: 'GitHub',
  feedback: 'Feedback',
  factory: 'Factory',
}
export type Origin = IssueOrigin
const ORIGIN_ORDER = ISSUE_ORIGINS

export const originWord = (origin: string): string => ORIGIN_LABEL[origin as IssueOrigin] ?? origin

/** One Issue as the list and the project page show it: the same shape for an open and a closed Issue. `since` is when it entered its state (closed: when it closed). */
export interface FlowCard {
  key: string
  /** the Issue's number, the address of its page (`/issues/<number>`) */
  number: number
  title: string
  repo: string
  origin: string
  kind: IssueKind
  /** the word the Issue stands under, or a closed Issue's outcome */
  state: LozengeState
  /** the split of the word (who it is paused on, what holds it); null: running, checking or closed */
  split: string | null
  /** the queue or wait reason, or the outcome of a closed one; null: no line */
  reason: string | null
  /** the seat of its lead for the badge (planned: not started yet); null: none known */
  seat: FlowIssue['seat']
  since: string
}

export interface FlowFilters {
  project?: string
  origin?: string
  /** Chooses which Issues the list shows (`/?state=running`); it never filters the cards of `cardsOf`. */
  state?: ListState
}

type OpenIssue = FlowModel['states'][OpenIssueState]['issues'][number]

const workOfIssue = (issue: OpenIssue, state: OpenIssueState) =>
  workOf({ state, waitReason: issue.waitReason, queueKind: issue.queue?.kind ?? null })

/**
 * The open Issues of each project or origin by the five words, before any filter. A closed Issue is never counted, so a
 * value whose Issues all closed has no entry at all.
 */
export function openSplits(data: FlowModel, field: 'repo' | 'origin'): Record<string, WorkCounts> {
  const splits: Record<string, WorkCounts> = {}
  for (const state of OPEN_ISSUE_STATES) {
    for (const issue of data.states[state].issues) {
      addWork((splits[issue[field]] ??= emptyWorkCounts()), workOfIssue(issue, state))
    }
  }
  return splits
}

export type Cards = Record<StateKey, FlowCard[]>

const keep = (filters: FlowFilters, card: { repo: string; origin: string }): boolean =>
  (!filters.project || card.repo === filters.project) && (!filters.origin || card.origin === filters.origin)

/** The cards of every state under the project and origin filters, in the order the server sent them. */
export function cardsOf(data: FlowModel, filters: FlowFilters = {}): Cards {
  const cards: Cards = { running: [], paused: [], ready: [], held: [], checking: [], closed: [] }
  for (const state of OPEN_ISSUE_STATES) {
    for (const issue of data.states[state].issues) {
      if (!keep(filters, issue)) continue
      const work = workOfIssue(issue, state)
      if (!work) continue
      cards[work.word].push({
        key: issue.id,
        number: numberOf(issue.id),
        title: issue.title,
        repo: issue.repo,
        origin: issue.origin,
        kind: issue.kind,
        state: work.word,
        split: work.split,
        reason:
          work.word === 'paused'
            ? pausedReason(issue.waitReason)
            : work.word === 'ready' || work.word === 'held'
              ? (issue.queue?.message ?? (state === 'settling' ? 'Being settled' : null))
              : null,
        seat: issue.seat,
        since: issue.since,
      })
    }
  }
  cards.closed = data.closedRecently
    .filter((issue) => keep(filters, issue))
    .map((issue) => ({
      key: issue.id,
      number: numberOf(issue.id),
      title: issue.title,
      repo: issue.repo,
      origin: issue.origin,
      kind: issue.kind,
      state: issue.outcome,
      split: null,
      reason: null,
      seat: issue.seat,
      since: issue.closedAt,
    }))
  return cards
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
    ...OPEN_ISSUE_STATES.flatMap((state) => data.states[state].issues.map((i) => i.origin)),
    ...data.closedRecently.map((c) => c.origin),
  ])
  return ORIGIN_ORDER.filter((origin) => present.has(origin))
}

export const countsOf = (cards: Cards): Record<StateKey, number> =>
  Object.fromEntries(STATE_KEYS.map((key) => [key, cards[key].length])) as Record<StateKey, number>

/** The Issues under one of the five words: the one "open" figure of the sidebar and the Flow page's note. */
export const openCount = (counts: Record<StateKey, number>): number =>
  WORK_WORDS.reduce((sum, word) => sum + counts[word], 0)

/** "12 open, 3 closed in the last day" */
export function flowNote(counts: Record<StateKey, number>): string {
  return `${openCount(counts)} open, ${counts.closed} closed in the last day`
}

/**
 * The Issues the list shows: one word's (or what closed lately), or with no `state` every open Issue and then what closed
 * lately. The project and origin filters are already in `cards`.
 */
export function listOf(cards: Cards, state?: ListState): FlowCard[] {
  if (state) return cards[state]
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

/** The cards above the list, each counting one trend series (Not started is Ready and Held together). */
const STAT_KEYS = ['running', 'paused', 'notStarted'] as const satisfies readonly WorkTrendKey[]

/** The list a stat card opens on the Overview. */
const STAT_COLUMN: Record<(typeof STAT_KEYS)[number], ListState | undefined> = {
  running: 'running',
  paused: 'paused',
  // Ready and Held together have no list of their own: the card opens the whole list
  notStarted: undefined,
}

/** Issues in the stored states a trend series counts, in the order the server sent them. */
const issuesOf = (data: FlowModel, key: WorkTrendKey) =>
  WORK_TREND_STATES[key].flatMap((state) => data.states[state].issues)

export interface FlowStat {
  key: (typeof STAT_KEYS)[number] | 'shipped'
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
  /** the list the card opens on the Overview */
  /** the list the card opens; none: the whole list */
  state: ListState | undefined
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

/** The four stat cards above the list: factory-wide, so never from the filtered cards. */
export function statsOf(data: FlowModel, now: number): FlowStat[] {
  const { trend, work } = data
  const issues = (key: WorkTrendKey) => issuesOf(data, key)
  const labels = trend.at.map(shortDate)
  const xLabels = xLabelsOf(trend.at)
  const values = { running: work.running, paused: work.paused, notStarted: work.ready + work.held }
  const line = (key: (typeof STAT_KEYS)[number]) => {
    // the daily samples: the sum of the stored states the series takes in, as the figure above them is
    const series = trend.at.map((_, i) =>
      WORK_TREND_STATES[key].reduce((total, state) => total + (trend.states[state][i] ?? 0), 0),
    )
    return {
      key,
      value: values[key],
      delta: (series.at(-1) ?? 0) - (series[0] ?? 0),
      series,
      labels,
      xLabels,
      subtitle: 'Issues, vs 7 days ago',
      state: STAT_COLUMN[key],
    } as const
  }
  const shipped = sum(trend.shipped)
  const queue = data.queueStates.global
  const queueWord = `${queue.charAt(0).toUpperCase()}${queue.slice(1)}`
  const oldest = (key: WorkTrendKey) =>
    longestWords(
      issues(key).map((i) => i.since),
      now,
    )
  const projects = (key: WorkTrendKey) => String(distinct(issues(key).map((i) => i.repo)))
  return [
    {
      ...line('running'),
      title: 'Running',
      higherIsBetter: true,
      sub:
        work.running === 0
          ? 'Nothing running'
          : `in ${plural(distinct(issues('running').map((i) => i.repo)), 'project')}${work.checking > 0 ? `, ${work.checking} more checking` : ''}`,
      footer: [
        { label: 'Oldest', value: oldest('running') },
        { label: 'Queue', value: queueWord },
      ],
    },
    {
      ...line('paused'),
      title: 'Paused',
      higherIsBetter: false,
      sub: work.paused === 0 ? 'Nothing paused' : splitWords(work.split.paused, PAUSED_LABEL),
      footer: [
        { label: 'Oldest', value: oldest('paused') },
        { label: 'Projects', value: projects('paused') },
      ],
    },
    {
      ...line('notStarted'),
      title: 'Not started',
      higherIsBetter: false,
      sub: work.ready + work.held === 0 ? 'Nothing to start' : `${work.ready} ready, ${work.held} held`,
      footer: [
        { label: 'Oldest', value: oldest('notStarted') },
        { label: 'Projects', value: projects('notStarted') },
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
export function trendLines(series: FlowTrendSeries, count: WorkTrendKey) {
  return {
    times: series.buckets.map((b) => Date.parse(b.at)),
    peak: series.buckets.map((b) => b[count].peak),
    avg: series.buckets.map((b) => b[count].avg),
  }
}
