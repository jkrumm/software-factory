/** Data for the `/kit` route: real-shaped Issues, projects and series, pure data with no I/O. */
import type { StatCardProps } from './stat-card'
import type { IssueKind } from './kind-badge'
import type { LozengeState } from './lozenge'
import type { Step } from './step-rail'

/** The clock every age on `/kit` is read against. */
export const KIT_NOW = Date.parse('2026-11-09T12:00:00Z')

const ago = (minutes: number): string => new Date(KIT_NOW - minutes * 60_000).toISOString()

export interface KitIssue {
  key: string
  title: string
  project: string
  kind: IssueKind
  state: LozengeState
  reason: string | null
  since: string
}

export const KIT_ISSUES: KitIssue[] = [
  {
    key: 'export-time',
    title: 'Show the export time on the board',
    project: 'pearl',
    kind: 'feature',
    state: 'working',
    reason: null,
    since: ago(42),
  },
  {
    key: 'login-crash',
    title: 'The login page crashes on submit',
    project: 'argo',
    kind: 'bug',
    state: 'waiting',
    reason: 'Waiting for the answer to a Decision: which session store to keep',
    since: ago(190),
  },
  {
    key: 'database',
    title: 'Pick a database',
    project: 'argo',
    kind: 'chore',
    state: 'queued',
    reason: 'Queued behind Choose the export format: the chain is not done',
    since: ago(7),
  },
  {
    key: 'export-queue',
    title: 'Move the export job to the new queue',
    project: 'orion',
    kind: 'feature',
    state: 'watching',
    reason: null,
    since: ago(1500),
  },
  {
    key: 'host-down',
    title: 'The host stopped answering and three alerts fired',
    project: 'orion',
    kind: 'incident',
    state: 'settling',
    reason: null,
    since: ago(0.4),
  },
  {
    key: 'export-schema',
    title: 'Publish the export schema',
    project: 'pearl',
    kind: 'docs',
    state: 'done',
    reason: 'Shipped and verified on the host',
    since: ago(4300),
  },
  {
    key: 'runbook',
    title: 'Write the restore runbook for the export store',
    project: 'argo',
    kind: 'docs',
    state: 'working',
    reason: null,
    since: ago(95),
  },
  {
    key: 'old-flags',
    title: 'Remove the feature flags that shipped last quarter',
    project: 'orion',
    kind: 'chore',
    state: 'queued',
    reason: 'Queued behind Move the export job to the new queue: the chain is not done',
    since: ago(30),
  },
]

/** The origin word of a fixture Issue, for the cards that show one. */
export const KIT_ORIGIN: Record<string, string> = {
  'export-time': 'You',
  'login-crash': 'Application',
  database: 'You',
  'export-queue': 'GitHub',
  'host-down': 'Infrastructure',
  'export-schema': 'Factory',
  runbook: 'Feedback',
  'old-flags': 'You',
}

export const KIT_STATS: Record<'working' | 'waiting' | 'queued' | 'shipped', Omit<StatCardProps, 'icon'>> = {
  working: {
    title: 'Working',
    subtitle: 'Against the target of 6 leads',
    value: 4,
    delta: { value: 1, higherIsBetter: true },
    sub: 'Leads running right now',
    series: {
      values: [2, 3, 3, 4, 5, 4, 4, 5, 4],
      labels: [
        'Mon 00:00',
        'Mon 12:00',
        'Tue 00:00',
        'Tue 12:00',
        'Wed 00:00',
        'Wed 12:00',
        'Thu 00:00',
        'Thu 12:00',
        'Fri 00:00',
      ],
      futureFrom: 7,
      target: 6,
    },
    xLabels: ['Mon', 'Now', 'Sun'],
    footer: [
      { label: 'Peak', value: '5 leads' },
      { label: 'Idle slots', value: '2' },
    ],
  },
  waiting: {
    title: 'Waiting',
    subtitle: 'Against the last 7 days',
    value: 3,
    delta: { value: -2, higherIsBetter: false },
    sub: 'Two need you, one waits for a time',
    series: { values: [6, 5, 5, 4, 5, 4, 3], labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] },
    xLabels: ['Mon', 'Thu', 'Sun'],
    footer: [
      { label: 'Oldest', value: '3 h ago' },
      { label: 'On a person', value: '2' },
    ],
  },
  queued: {
    title: 'Queued',
    subtitle: 'Per day, last 7 days',
    value: 7,
    delta: { value: 0 },
    sub: 'Held back by the chain and the weekly pace',
    bars: [3, 5, 4, 8, 6, 9, 7],
    barLabels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    xLabels: ['Mon', 'Thu', 'Today'],
    footer: [
      { label: 'By the chain', value: '4' },
      { label: 'By the pace', value: '3' },
    ],
  },
  shipped: {
    title: 'Shipped this week',
    subtitle: 'Against the week before',
    value: 12,
    delta: { value: 4, higherIsBetter: true },
    sub: 'Issues closed as done',
    series: { values: [1, 2, 2, 4, 5, 7, 9, 12], labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Now'] },
    xLabels: ['Mon', 'Thu', 'Now'],
    footer: [
      { label: 'Per day', value: '1.7' },
      { label: 'Healed', value: '2' },
    ],
  },
}

export const KIT_PROPERTIES = [
  { label: 'Project', value: 'pearl' },
  { label: 'Origin', value: 'You' },
  { label: 'Account', value: 'Primary' },
  { label: 'Attempt', value: '2' },
  { label: 'Branch', value: undefined },
  { label: 'Watch', value: null },
]

export const KIT_STEPS: Step[] = [
  { id: 'filed', label: 'Filed by you', at: '09:14:02', durationMs: 900 },
  { id: 'settled', label: 'Settled as a feature', at: '09:14:41', durationMs: 38_000 },
  { id: 'lead', label: 'The lead started', at: '09:20:05', durationMs: 310_000 },
  {
    id: 'gate',
    label: 'The gate refused the ship',
    at: '10:02:33',
    durationMs: 4_200,
    failed: true,
    detail: 'make check failed: 2 tests in the board suite',
  },
  { id: 'shipped', label: 'Shipped', at: '10:41:19', durationMs: 120_000 },
]

export const KIT_METERS = [
  { label: 'Weekly window', value: 0.42 },
  { label: 'Memory', value: 0.78 },
  { label: 'Swap', value: 0.94 },
]

/** Fix commits by class and week for the stacked bars: nine classes in a fixed order, one of them "other" (the quiet slot). */
export const KIT_FIX_SERIES = [
  { key: 'tests', label: 'tests', slot: 1 },
  { key: 'docs', label: 'docs', slot: 2 },
  { key: 'tooling', label: 'tooling', slot: 3 },
  { key: 'review', label: 'review', slot: 4 },
  { key: 'logic', label: 'logic', slot: 5 },
  { key: 'contract', label: 'contract', slot: 6 },
  { key: 'concurrency', label: 'concurrency', slot: 7 },
  { key: 'environment', label: 'environment', slot: 8 },
  { key: 'other', label: 'other', slot: 9 },
]

export const KIT_FIX_BARS = [
  { label: 'Week to 2026-10-19', values: [1, 0, 2, 0, 3, 0, 0, 1, 0] },
  { label: 'Week to 2026-10-26', values: [2, 1, 1, 1, 2, 0, 1, 0, 1] },
  { label: 'Week to 2026-11-02', values: [0, 0, 3, 0, 1, 1, 0, 0, 0] },
  { label: 'Week to 2026-11-09', values: [1, 0, 1, 0, 0, 0, 2, 0, 0] },
]

/** Six windows of a KPI with a gap in the middle and a target range, as the Improve cards draw them. */
export const KIT_KPI_HISTORY: (number | null)[] = [0.31, 0.24, null, 0.12, 0.09, 0.06]
