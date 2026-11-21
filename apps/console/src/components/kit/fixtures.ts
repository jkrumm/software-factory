/** Data for the `/kit` route: real-shaped Issues, projects and series, pure data with no I/O. */
import type { DecisionView, LeadSeat } from '@software-factory/contract'
import type { StatCardProps } from './stat-card'
import type { IssueKind } from '@software-factory/contract'
import type { LozengeState } from './lozenge'
import type { Step } from './step-rail'

/** The clock every age on `/kit` is read against. */
export const KIT_NOW = Date.parse('2026-11-09T12:00:00Z')

const ago = (minutes: number): string => new Date(KIT_NOW - minutes * 60_000).toISOString()

export interface KitIssue {
  key: string
  /** The Issue's number; null for a plan row. */
  number: number | null
  /** A plan row has no age. */
  title: string
  project: string
  kind: IssueKind
  state: LozengeState
  reason: string | null
  since: string | null
  /** The seat of its lead: actual, planned (not started yet) or none. */
  seat?: LeadSeat | null
}

export const KIT_ISSUES: KitIssue[] = [
  {
    key: 'export-time',
    number: 657,
    title: 'Show the export time on the dashboard',
    project: 'pearl',
    kind: 'feature',
    state: 'running',
    reason: null,
    since: ago(42),
    seat: { tier: 'sonnet', effort: 'high', role: 'lead', planned: false, rule: null, sizeKnown: true },
  },
  {
    key: 'login-crash',
    number: 642,
    title: 'The login page crashes on submit',
    project: 'argo',
    kind: 'bug',
    state: 'paused',
    reason: 'On you: a Decision about which session store to keep',
    since: ago(190),
  },
  {
    key: 'database',
    number: 618,
    title: 'Pick a database',
    project: 'argo',
    kind: 'chore',
    state: 'held',
    reason: 'Behind Choose the export format: the chain is not done',
    since: ago(7),
    seat: { tier: 'sonnet', effort: 'high', role: 'lead', planned: true, rule: null, sizeKnown: true },
  },
  {
    key: 'export-queue',
    number: 631,
    title: 'Move the export job to the new queue',
    project: 'orion',
    kind: 'feature',
    state: 'checking',
    reason: null,
    since: ago(1500),
  },
  {
    key: 'host-down',
    number: 660,
    title: 'The host stopped answering and three alerts fired',
    project: 'orion',
    kind: 'incident',
    state: 'held',
    reason: null,
    since: ago(0.4),
  },
  {
    key: 'export-schema',
    number: 604,
    title: 'Publish the export schema',
    project: 'pearl',
    kind: 'docs',
    state: 'done',
    reason: 'Shipped and verified on the host',
    since: ago(4300),
  },
  {
    key: 'runbook',
    number: 649,
    title: 'Write the restore runbook for the export store',
    project: 'argo',
    kind: 'docs',
    state: 'running',
    reason: null,
    since: ago(95),
    seat: { tier: 'haiku', effort: 'high', role: 'light', planned: false, rule: 'hygiene:links', sizeKnown: true },
  },
  {
    key: 'old-flags',
    number: 622,
    title: 'Remove the feature flags that shipped last quarter',
    project: 'orion',
    kind: 'chore',
    state: 'held',
    reason: 'Behind Move the export job to the new queue: the chain is not done',
    since: ago(30),
  },
  {
    key: 'long-title',
    number: 1042,
    title:
      'Make the export job resumable after a host restart, keep the partial files it already wrote, and report which rows were skipped when the same job is started again on the next scheduled run',
    project: 'orion',
    kind: 'bug',
    state: 'running',
    reason: 'Holding for the export store to finish its nightly compaction before the next batch may start',
    since: ago(260),
  },
  {
    key: 'plan-row',
    number: null,
    title: 'Add the archive step to the export plan',
    project: 'pearl',
    kind: 'feature',
    state: 'planned',
    reason: 'Not before Nov 20',
    since: null,
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
  'plan-row': 'Not filed yet',
}

export const KIT_STATS: Record<'running' | 'paused' | 'notStarted' | 'shipped', Omit<StatCardProps, 'icon'>> = {
  running: {
    title: 'Running',
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
  paused: {
    title: 'Paused',
    subtitle: 'Against the last 7 days',
    value: 3,
    delta: { value: -2, higherIsBetter: false },
    sub: 'Two on you, one on a timer',
    series: { values: [6, 5, 5, 4, 5, 4, 3], labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] },
    xLabels: ['Mon', 'Thu', 'Sun'],
    footer: [
      { label: 'Oldest', value: '3 h ago' },
      { label: 'On a person', value: '2' },
    ],
  },
  notStarted: {
    title: 'Not started',
    subtitle: 'Per day, last 7 days',
    value: 7,
    delta: { value: 0 },
    sub: 'Ready or held by the chain and the weekly pace',
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
    detail: 'make check failed: 2 tests in the dashboard suite',
  },
  { id: 'shipped', label: 'Shipped', at: '10:41:19', durationMs: 120_000 },
]

export const KIT_METERS = [
  { label: 'Weekly window', value: 0.42 },
  { label: 'Memory', value: 0.78 },
  { label: 'Swap', value: 0.94 },
]

/** Fix commits by cause and week for the stacked bars: nine causes in a fixed order, one of them "other" (the quiet slot). */
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

/** One Decision as `GET /v1/decisions/<id>` shows it: the form of `factory issue ask`, with the wait and the answer fields of a Decision still open. */
const decision = (
  n: number,
  form: Partial<DecisionView> & Pick<DecisionView, 'question' | 'recommendation' | 'options'>,
): DecisionView => ({
  id: `decision_kit_${n}`,
  issueId: `issue_${9000 + n}`,
  repo: 'example',
  attempt: 1,
  class: null,
  whyYours: null,
  checked: 'Read the Spec and the code it names.',
  exhibit: null,
  spec: null,
  noAnswer: { consequence: 'The lead goes on with the recommended option.', default: null, waitMinutes: null },
  askedAt: ago(90),
  defaultAt: null,
  status: 'open',
  answer: null,
  settledBy: null,
  source: null,
  answeredAt: null,
  withdrawnReason: null,
  worthAsking: null,
  path: [],
  judge: null,
  ...form,
})

/** A Decision's wireframe, drawn for this ask: not a screenshot of the lead's build. */
const WIREFRAME = {
  dock: 'data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20400%20300%22%3E%3Crect%20width%3D%22400%22%20height%3D%22300%22%20fill%3D%22%23f4f4f8%22%2F%3E%3Crect%20x%3D%220%22%20y%3D%220%22%20width%3D%22400%22%20height%3D%2226%22%20fill%3D%22%23e2e2e5%22%2F%3E%3Crect%20x%3D%2210%22%20y%3D%229%22%20width%3D%2270%22%20height%3D%228%22%20rx%3D%223%22%20fill%3D%22%23b4b4b8%22%2F%3E%3Crect%20x%3D%220%22%20y%3D%2226%22%20width%3D%2246%22%20height%3D%22264%22%20fill%3D%22%23e8e8ec%22%2F%3E%3Crect%20x%3D%2210%22%20y%3D%2240%22%20width%3D%2226%22%20height%3D%226%22%20rx%3D%223%22%20fill%3D%22%23b4b4b8%22%2F%3E%3Crect%20x%3D%2210%22%20y%3D%2256%22%20width%3D%2226%22%20height%3D%226%22%20rx%3D%223%22%20fill%3D%22%23b4b4b8%22%2F%3E%3Crect%20x%3D%2210%22%20y%3D%2272%22%20width%3D%2226%22%20height%3D%226%22%20rx%3D%223%22%20fill%3D%22%23b4b4b8%22%2F%3E%3Crect%20x%3D%2262%22%20y%3D%2244%22%20width%3D%22190%22%20height%3D%2222%22%20rx%3D%224%22%20fill%3D%22%23d9d9de%22%2F%3E%3Crect%20x%3D%2262%22%20y%3D%2278%22%20width%3D%22190%22%20height%3D%2222%22%20rx%3D%224%22%20fill%3D%22%23d9d9de%22%2F%3E%3Crect%20x%3D%2262%22%20y%3D%22112%22%20width%3D%22190%22%20height%3D%2222%22%20rx%3D%224%22%20fill%3D%22%23d9d9de%22%2F%3E%3Crect%20x%3D%2262%22%20y%3D%22146%22%20width%3D%22190%22%20height%3D%2222%22%20rx%3D%224%22%20fill%3D%22%23d9d9de%22%2F%3E%3Crect%20x%3D%2262%22%20y%3D%22180%22%20width%3D%22190%22%20height%3D%2222%22%20rx%3D%224%22%20fill%3D%22%23d9d9de%22%2F%3E%3Crect%20x%3D%2262%22%20y%3D%22214%22%20width%3D%22190%22%20height%3D%2222%22%20rx%3D%224%22%20fill%3D%22%23d9d9de%22%2F%3E%3Crect%20x%3D%22276%22%20y%3D%2226%22%20width%3D%22124%22%20height%3D%22264%22%20fill%3D%22%23fafafd%22%2F%3E%3Crect%20x%3D%22288%22%20y%3D%2240%22%20width%3D%2270%22%20height%3D%228%22%20rx%3D%223%22%20fill%3D%22%234374a6%22%2F%3E%3Crect%20x%3D%22288%22%20y%3D%2262%22%20width%3D%22100%22%20height%3D%226%22%20rx%3D%223%22%20fill%3D%22%23c8c8cc%22%2F%3E%3Crect%20x%3D%22288%22%20y%3D%2278%22%20width%3D%2290%22%20height%3D%226%22%20rx%3D%223%22%20fill%3D%22%23c8c8cc%22%2F%3E%3Crect%20x%3D%22288%22%20y%3D%2294%22%20width%3D%2296%22%20height%3D%226%22%20rx%3D%223%22%20fill%3D%22%23c8c8cc%22%2F%3E%3Ctext%20x%3D%22200%22%20y%3D%22288%22%20text-anchor%3D%22middle%22%20font-family%3D%22sans-serif%22%20font-size%3D%2211%22%20fill%3D%22%2369696c%22%3EPage%20reflows%20beside%20the%20panel%3C%2Ftext%3E%3C%2Fsvg%3E',
  float:
    'data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20400%20300%22%3E%3Crect%20width%3D%22400%22%20height%3D%22300%22%20fill%3D%22%23f4f4f8%22%2F%3E%3Crect%20x%3D%220%22%20y%3D%220%22%20width%3D%22400%22%20height%3D%2226%22%20fill%3D%22%23e2e2e5%22%2F%3E%3Crect%20x%3D%2210%22%20y%3D%229%22%20width%3D%2270%22%20height%3D%228%22%20rx%3D%223%22%20fill%3D%22%23b4b4b8%22%2F%3E%3Crect%20x%3D%220%22%20y%3D%2226%22%20width%3D%2246%22%20height%3D%22264%22%20fill%3D%22%23e8e8ec%22%2F%3E%3Crect%20x%3D%2210%22%20y%3D%2240%22%20width%3D%2226%22%20height%3D%226%22%20rx%3D%223%22%20fill%3D%22%23b4b4b8%22%2F%3E%3Crect%20x%3D%2210%22%20y%3D%2256%22%20width%3D%2226%22%20height%3D%226%22%20rx%3D%223%22%20fill%3D%22%23b4b4b8%22%2F%3E%3Crect%20x%3D%2210%22%20y%3D%2272%22%20width%3D%2226%22%20height%3D%226%22%20rx%3D%223%22%20fill%3D%22%23b4b4b8%22%2F%3E%3Crect%20x%3D%2262%22%20y%3D%2244%22%20width%3D%22310%22%20height%3D%2222%22%20rx%3D%224%22%20fill%3D%22%23d9d9de%22%2F%3E%3Crect%20x%3D%2262%22%20y%3D%2278%22%20width%3D%22310%22%20height%3D%2222%22%20rx%3D%224%22%20fill%3D%22%23d9d9de%22%2F%3E%3Crect%20x%3D%2262%22%20y%3D%22112%22%20width%3D%22310%22%20height%3D%2222%22%20rx%3D%224%22%20fill%3D%22%23d9d9de%22%2F%3E%3Crect%20x%3D%2262%22%20y%3D%22146%22%20width%3D%22310%22%20height%3D%2222%22%20rx%3D%224%22%20fill%3D%22%23d9d9de%22%2F%3E%3Crect%20x%3D%2262%22%20y%3D%22180%22%20width%3D%22310%22%20height%3D%2222%22%20rx%3D%224%22%20fill%3D%22%23d9d9de%22%2F%3E%3Crect%20x%3D%2262%22%20y%3D%22214%22%20width%3D%22310%22%20height%3D%2222%22%20rx%3D%224%22%20fill%3D%22%23d9d9de%22%2F%3E%3Crect%20x%3D%22196%22%20y%3D%2226%22%20width%3D%22204%22%20height%3D%22264%22%20fill%3D%22%23fafafd%22%20opacity%3D%220.97%22%2F%3E%3Crect%20x%3D%22210%22%20y%3D%2240%22%20width%3D%2280%22%20height%3D%228%22%20rx%3D%223%22%20fill%3D%22%234374a6%22%2F%3E%3Crect%20x%3D%22210%22%20y%3D%2262%22%20width%3D%22170%22%20height%3D%226%22%20rx%3D%223%22%20fill%3D%22%23c8c8cc%22%2F%3E%3Crect%20x%3D%22210%22%20y%3D%2278%22%20width%3D%22150%22%20height%3D%226%22%20rx%3D%223%22%20fill%3D%22%23c8c8cc%22%2F%3E%3Crect%20x%3D%22210%22%20y%3D%2294%22%20width%3D%22160%22%20height%3D%226%22%20rx%3D%223%22%20fill%3D%22%23c8c8cc%22%2F%3E%3Ctext%20x%3D%22200%22%20y%3D%22288%22%20text-anchor%3D%22middle%22%20font-family%3D%22sans-serif%22%20font-size%3D%2211%22%20fill%3D%22%2369696c%22%3EPanel%20floats%20over%20the%20page%3C%2Ftext%3E%3C%2Fsvg%3E',
  pin: 'data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20400%20300%22%3E%3Crect%20width%3D%22400%22%20height%3D%22300%22%20fill%3D%22%23f4f4f8%22%2F%3E%3Crect%20x%3D%220%22%20y%3D%220%22%20width%3D%22400%22%20height%3D%2226%22%20fill%3D%22%23e2e2e5%22%2F%3E%3Crect%20x%3D%2210%22%20y%3D%229%22%20width%3D%2270%22%20height%3D%228%22%20rx%3D%223%22%20fill%3D%22%23b4b4b8%22%2F%3E%3Crect%20x%3D%220%22%20y%3D%2226%22%20width%3D%2246%22%20height%3D%22264%22%20fill%3D%22%23e8e8ec%22%2F%3E%3Crect%20x%3D%2210%22%20y%3D%2240%22%20width%3D%2226%22%20height%3D%226%22%20rx%3D%223%22%20fill%3D%22%23b4b4b8%22%2F%3E%3Crect%20x%3D%2210%22%20y%3D%2256%22%20width%3D%2226%22%20height%3D%226%22%20rx%3D%223%22%20fill%3D%22%23b4b4b8%22%2F%3E%3Crect%20x%3D%2210%22%20y%3D%2272%22%20width%3D%2226%22%20height%3D%226%22%20rx%3D%223%22%20fill%3D%22%23b4b4b8%22%2F%3E%3Crect%20x%3D%2262%22%20y%3D%2244%22%20width%3D%22310%22%20height%3D%2222%22%20rx%3D%224%22%20fill%3D%22%23d9d9de%22%2F%3E%3Crect%20x%3D%2262%22%20y%3D%2278%22%20width%3D%22310%22%20height%3D%2222%22%20rx%3D%224%22%20fill%3D%22%23d9d9de%22%2F%3E%3Crect%20x%3D%2262%22%20y%3D%22112%22%20width%3D%22310%22%20height%3D%2222%22%20rx%3D%224%22%20fill%3D%22%23d9d9de%22%2F%3E%3Crect%20x%3D%2262%22%20y%3D%22146%22%20width%3D%22310%22%20height%3D%2222%22%20rx%3D%224%22%20fill%3D%22%23d9d9de%22%2F%3E%3Crect%20x%3D%2262%22%20y%3D%22180%22%20width%3D%22310%22%20height%3D%2222%22%20rx%3D%224%22%20fill%3D%22%23d9d9de%22%2F%3E%3Crect%20x%3D%2262%22%20y%3D%22214%22%20width%3D%22310%22%20height%3D%2222%22%20rx%3D%224%22%20fill%3D%22%23d9d9de%22%2F%3E%3Crect%20x%3D%22196%22%20y%3D%2226%22%20width%3D%22204%22%20height%3D%22264%22%20fill%3D%22%23fafafd%22%20opacity%3D%220.97%22%2F%3E%3Crect%20x%3D%22210%22%20y%3D%2240%22%20width%3D%2280%22%20height%3D%228%22%20rx%3D%223%22%20fill%3D%22%234374a6%22%2F%3E%3Ccircle%20cx%3D%22380%22%20cy%3D%2244%22%20r%3D%227%22%20fill%3D%22%234374a6%22%2F%3E%3Crect%20x%3D%22210%22%20y%3D%2262%22%20width%3D%22170%22%20height%3D%226%22%20rx%3D%223%22%20fill%3D%22%23c8c8cc%22%2F%3E%3Crect%20x%3D%22210%22%20y%3D%2278%22%20width%3D%22150%22%20height%3D%226%22%20rx%3D%223%22%20fill%3D%22%23c8c8cc%22%2F%3E%3Ctext%20x%3D%22200%22%20y%3D%22288%22%20text-anchor%3D%22middle%22%20font-family%3D%22sans-serif%22%20font-size%3D%2211%22%20fill%3D%22%2369696c%22%3EFloats%3B%20a%20pin%20docks%20it%3C%2Ftext%3E%3C%2Fsvg%3E',
}

/**
 * Five asks of 2026-11-14 to 2026-11-21 in the form of a Decision, one per exhibit type: each question and each option is one a
 * real Spec of that week put to its owner, cut to the form's limits. `/kit` shows them as the card the owner reads.
 */
export const KIT_DECISIONS: DecisionView[] = [
  decision(1, {
    class: 'look',
    whyYours: 'He has not seen the screen, and three real variants exist.',
    question: 'Should a record open in a panel that shrinks the page, or float over it?',
    recommendation: 'Float, with a pin to dock',
    spec: 'artifact_kit_dock',
    exhibit: {
      kind: 'pictures',
      pictures: [
        { option: 'Dock, shrink the page', image: WIREFRAME.dock },
        { option: 'Float over the page', image: WIREFRAME.float },
        { option: 'Float, with a pin to dock', image: WIREFRAME.pin },
      ],
    },
    options: [
      {
        label: 'Dock, shrink the page',
        leadsTo: 'A 26 rem panel at the end edge; the page reflows beside it.',
        reversible: true,
        cost: 'One layout track to remove.',
      },
      {
        label: 'Float over the page',
        leadsTo: 'The panel as it is today; nothing reflows.',
        reversible: true,
        cost: 'None: it is today.',
      },
      {
        label: 'Float, with a pin to dock',
        leadsTo: 'The floating panel, plus a pin that docks the record.',
        reversible: true,
        cost: 'One more button in every panel.',
      },
    ],
    checked:
      'At 1440 px with the rail open, a docked panel of the floating width leaves 592 px for the page; 26 rem leaves 784.',
    noAnswer: {
      consequence: 'The lead builds the recommended variant.',
      default: 'Float, with a pin to dock',
      waitMinutes: 1440,
    },
    defaultAt: ago(-1350),
  }),
  decision(2, {
    class: 'own_surface',
    whyYours: "It changes what his MacBook runs on a lead's words.",
    question: 'Which MacBook commands may run with no click while he is at the MacBook?',
    recommendation: 'Classes he said yes to once',
    exhibit: {
      kind: 'diagram',
      caption: 'A command runs by itself only when its class has his one yes.',
      mermaid:
        'flowchart LR\n  A[A lead writes a command] --> B{A class he said yes to?}\n  B -->|yes| C{Needs his fingertip?}\n  B -->|no| D[Waits for his Run click]\n  C -->|no| E[Runs by itself]\n  C -->|yes| F[1Password prompt starts]\n  F --> E\n  D --> G[He clicks Run]\n  G --> E',
    },
    options: [
      {
        label: 'Classes he said yes to once',
        leadsTo: 'A command of a known class runs by itself; the factory proposes each new class.',
        reversible: true,
        cost: 'One answer per class, ever.',
      },
      {
        label: 'Every command off a never list',
        leadsTo: "A lead's text runs as typed on his MacBook.",
        reversible: true,
        cost: 'One switch to turn off.',
      },
      {
        label: 'Keep the click',
        leadsTo: 'Every command waits for his Run.',
        reversible: true,
        cost: 'None: it is today.',
      },
    ],
    checked:
      '149 requests since 2026-10-15; none was refused by hand, and 28 failed on a command fault, never on consent.',
    noAnswer: { consequence: 'Every command still needs his click.', default: null, waitMinutes: null },
  }),
  decision(3, {
    class: 'spend',
    whyYours: 'It decides how much of a paid subscription sits idle.',
    question: 'Hold back a whole account for Fable, or only the half of it Fable can use?',
    recommendation: 'Reserve the Fable share only',
    exhibit: {
      kind: 'numbers',
      figures: [
        { label: 'Fable can use', value: '50', unit: "% of an account's weekly points" },
        { label: 'Held back today', value: '100', unit: '% of an account' },
        { label: 'Accounts checked', value: '3', unit: 'on 2026-11-19' },
      ],
    },
    options: [
      {
        label: 'Reserve the Fable share only',
        leadsTo: 'The account also takes other work while its Fable budget still fits.',
        reversible: true,
        cost: 'One mode per account to change.',
      },
      {
        label: 'Hold back the whole account',
        leadsTo: 'The account serves only Fable, as today.',
        reversible: true,
        cost: 'None: it is today.',
      },
    ],
    checked: 'The usage endpoint caps Fable at 50 weekly points per account, with the same reset as the weekly total.',
    noAnswer: {
      consequence: 'The lead builds the recommended mode.',
      default: 'Reserve the Fable share only',
      waitMinutes: 1440,
    },
    defaultAt: ago(-1350),
  }),
  decision(4, {
    class: 'direction',
    whyYours: 'What his app does after a merge is what its users get.',
    question: 'Should a shipped desktop change publish a release by itself?',
    recommendation: 'Release on ship',
    exhibit: {
      kind: 'before_after',
      today: [
        'A merge changes the code; the app he runs stays on the old build.',
        'Someone runs the release by hand on the mini.',
      ],
      after: [
        'A merged desktop change starts a release by itself, 25 to 35 minutes.',
        'A failed release leaves the feed on the last one.',
      ],
    },
    options: [
      {
        label: 'Release on ship',
        leadsTo: 'A shipped desktop change publishes a release; a share-only change releases nothing.',
        reversible: true,
        cost: 'One hook to remove.',
      },
      {
        label: 'Keep releasing by hand',
        leadsTo: 'A desktop change is done when merged; he runs the release.',
        reversible: true,
        cost: 'None: it is today.',
      },
    ],
    checked: 'The release script already leaves the feed unchanged on any failure before its last step.',
    noAnswer: { consequence: 'The lead builds the hook.', default: 'Release on ship', waitMinutes: 1440 },
    defaultAt: ago(-1350),
  }),
  decision(5, {
    class: 'direction',
    whyYours: "The address is the guide's public face.",
    question: "Where should the factory's guide live?",
    recommendation: "The repo's own github.io address",
    exhibit: {
      kind: 'table',
      criteria: ['Setup', 'Address', 'Switching later'],
      rows: [
        {
          option: "The repo's own github.io address",
          cells: ['None, works today', 'Under his GitHub account', '10 minutes, one setting'],
        },
        {
          option: 'A subdomain of his own domain',
          cells: ['One CNAME, one Pages setting', 'His own domain', '10 minutes, one setting'],
        },
      ],
    },
    options: [
      {
        label: "The repo's own github.io address",
        leadsTo: 'The guide builds and goes live with no setup.',
        reversible: true,
        cost: 'Ten minutes and one setting.',
      },
      {
        label: 'A subdomain of his own domain',
        leadsTo: 'The guide lives on his domain; GitHub redirects the old address.',
        reversible: true,
        cost: 'Ten minutes and one setting.',
      },
    ],
    checked: "The address software-factory.github.io is taken, so the repo's address is under his account.",
    noAnswer: {
      consequence: "The lead builds on the repo's address.",
      default: "The repo's own github.io address",
      waitMinutes: 1440,
    },
    defaultAt: ago(-1350),
  }),
]
