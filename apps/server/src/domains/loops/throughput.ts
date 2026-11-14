/**
 * The throughput loop's rules, with no I/O: what a day's facts rank as costs, the one improvement a project is asked for,
 * the figure that ledger row is measured by, and whether the figure moved three days after the ship. Costs are minutes of
 * the host's capacity (slot-minutes of failed or over-budget runs, minutes of queue or of a process that kept growing), so
 * the largest is the one worth a lead's time.
 */
import type { Finding } from './selfwatch-model.ts'
import { BASELINE_DAYS, DEFAULT_PEAK_MIB, FACTORY_PROJECT, PROCESS_GROWTH_MIB } from '../../kernel/throughput-limits.ts'

export const THROUGHPUT_KPIS = [
  'failed_run_minutes',
  'slot_minutes_per_issue',
  'step_peak_mib',
  'process_growth_mib',
  'queued_minutes',
] as const
export type ThroughputKpi = (typeof THROUGHPUT_KPIS)[number]

/** The window the ranking reads, and the window a ship is measured over. */
export const RANK_DAYS = 7
export const AFTER_DAYS = 3
const DAY_MS = 86_400_000
export const AFTER_DELAY_MS = AFTER_DAYS * DAY_MS

/** A finding costing less than this many minutes in the ranking window is not worth an Issue. */
export const MIN_COST_MINUTES = 30
/** Slot-minutes per closed Issue is a finding when it is this far above the project's median of the 14 days before. */
export const PER_ISSUE_FACTOR = 1.25
/** An after within this share of the before has not moved. */
export const MOVED_SHARE = 0.1
/** The share of `before` a time figure is asked to fall to. */
export const TARGET_SHARE = 0.5

/** The host in the window `[from, to)`, as the loop reads it: raw figures per project, thresholds not applied. */
export interface WindowFacts {
  days: number
  runs: { project: string; runs: number; failedRuns: number; failedMinutes: number; minutes: number }[]
  /** slot minutes and Issues closed `done` in the window; the median of the same ratio per day over the 14 days before (null: none) */
  perIssue: { project: string; minutes: number; closed: number; baselineMedian: number | null }[]
  /** per project and tier: runs with a peak, their 90th percentile, the project's peak budget and the minutes of runs over it */
  steps: { project: string; tier: string; runs: number; peakP90Mib: number; budgetMib: number; overMinutes: number }[]
  /** a process whose footprint grew between its first and last notable minute in the window */
  processes: { name: string; class: string; project: string; grownMib: number; minutes: number }[]
  /** minutes Issues of every project spent queued (filed or reopened to admitted) for admissions in the window: one row, on the factory, whose queue it is */
  queued: { project: string; minutes: number; admissions: number }[]
}

/** One thing that costs capacity, with the figure that measures it. */
export interface Candidate {
  project: string
  kpi: ThroughputKpi
  subject: string
  label: string
  /** per day for a minutes figure, a peak or a ratio otherwise */
  value: number
  unit: string
  target: number
  costMinutes: number
  query: string
}

const round = (value: number, decimals = 1): number => Math.round(value * 10 ** decimals) / 10 ** decimals

const READ = 'factory read throughput --hours 168'

/** What the window's facts rank as costs, largest first (then project, kpi, subject). */
export function rankCandidates(facts: WindowFacts): Candidate[] {
  const found: Candidate[] = []
  const days = Math.max(1, facts.days)
  for (const r of facts.runs) {
    if (r.failedMinutes < MIN_COST_MINUTES) continue
    const perDay = r.failedMinutes / days
    found.push({
      project: r.project,
      kpi: 'failed_run_minutes',
      subject: '*',
      label: `${round(r.failedMinutes)} slot-minutes in ${r.failedRuns} failed of ${r.runs} test-slot runs`,
      value: round(perDay),
      unit: 'slot-minutes/day',
      target: round(perDay * TARGET_SHARE),
      costMinutes: round(r.failedMinutes),
      query: `${READ} | .tests.byProject[] | select(.repo == "${r.project}") | .failedRunMinutes, divided by the ${days} days`,
    })
  }
  for (const p of facts.perIssue) {
    if (p.closed < 2 || p.baselineMedian === null || p.baselineMedian <= 0) continue
    const ratio = p.minutes / p.closed
    if (ratio < p.baselineMedian * PER_ISSUE_FACTOR) continue
    found.push({
      project: p.project,
      kpi: 'slot_minutes_per_issue',
      subject: '*',
      label: `${round(ratio)} slot-minutes per closed Issue against a 14-day median of ${round(p.baselineMedian)}`,
      value: round(ratio),
      unit: 'slot-minutes/Issue',
      target: round(p.baselineMedian),
      costMinutes: round((ratio - p.baselineMedian) * p.closed),
      query: `${READ} | .project[] | select(.repo == "${p.project}") | .slot.minutesPerClosedIssue`,
    })
  }
  for (const s of facts.steps) {
    if (s.peakP90Mib <= s.budgetMib || s.overMinutes < 1) continue
    found.push({
      project: s.project,
      kpi: 'step_peak_mib',
      subject: s.tier,
      label: `the ${s.tier} step peaks at ${s.peakP90Mib} MiB (90th percentile of ${s.runs} runs)`,
      value: s.peakP90Mib,
      unit: 'MiB',
      target: s.budgetMib,
      costMinutes: round(s.overMinutes),
      query: `step_costs of ${s.project}, tier ${s.tier}: the 90th percentile of peak_rss_mib; \`${READ} | .project[] | select(.repo == "${s.project}") | .slot.peakMib\` for the largest`,
    })
  }
  for (const p of facts.processes) {
    if (p.grownMib < PROCESS_GROWTH_MIB) continue
    found.push({
      project: p.project,
      kpi: 'process_growth_mib',
      subject: p.name,
      label: `${p.name} (${p.class}) grew by ${p.grownMib} MiB over ${p.minutes} notable minutes`,
      value: p.grownMib,
      unit: 'MiB',
      target: PROCESS_GROWTH_MIB / 2,
      costMinutes: p.minutes,
      query: `${READ} | .host.topProcesses[] | select(.name == "${p.name}") | .grownMib`,
    })
  }
  for (const q of facts.queued) {
    if (q.minutes < MIN_COST_MINUTES) continue
    const perDay = q.minutes / days
    found.push({
      project: q.project,
      kpi: 'queued_minutes',
      subject: '*',
      label: `${round(q.minutes)} minutes queued over ${q.admissions} admissions`,
      value: round(perDay),
      unit: 'minutes/day',
      target: round(perDay * TARGET_SHARE),
      costMinutes: round(q.minutes),
      query: `\`factory read kpis\` queue_time for the cut, every project's Issues from filed to admitted, divided by the ${days} days`,
    })
  }
  return found.toSorted(
    (a, b) =>
      b.costMinutes - a.costMinutes ||
      a.project.localeCompare(b.project) ||
      a.kpi.localeCompare(b.kpi) ||
      a.subject.localeCompare(b.subject),
  )
}

/**
 * The figure of a finding in another window, from the same facts: what the ledger reads as the `after`. Null when the
 * window has nothing to say about it (a project with no run, no Issue closed, no step of the tier); a process or queue
 * that does not appear is 0.
 */
export function figureOf(
  facts: WindowFacts,
  finding: { project: string; kpi: ThroughputKpi; subject: string },
): number | null {
  const days = Math.max(1, facts.days)
  switch (finding.kpi) {
    case 'failed_run_minutes': {
      const r = facts.runs.find((x) => x.project === finding.project)
      return r ? round(r.failedMinutes / days) : null
    }
    case 'slot_minutes_per_issue': {
      const p = facts.perIssue.find((x) => x.project === finding.project)
      return p && p.closed > 0 ? round(p.minutes / p.closed) : null
    }
    case 'step_peak_mib': {
      const s = facts.steps.find((x) => x.project === finding.project && x.tier === finding.subject)
      return s ? s.peakP90Mib : null
    }
    case 'process_growth_mib':
      return Math.max(
        0,
        ...facts.processes
          .filter((x) => x.project === finding.project && x.name === finding.subject)
          .map((x) => x.grownMib),
      )
    case 'queued_minutes': {
      const q = facts.queued.find((x) => x.project === finding.project)
      // the queue is the factory's: a finding of an earlier rule on another project has nothing to read
      return q ? round(q.minutes / days) : finding.project === FACTORY_PROJECT ? 0 : null
    }
  }
}

/** One finding as the ledger stores it (`migrations/1027_throughput_findings.sql`). */
export interface FindingRow {
  id: string
  project: string
  kpi: ThroughputKpi
  subject: string
  before: number
  target: number
  direction: 'up' | 'down'
  unit: string
  costMinutes: number
  query: string
  signalId: string | null
  issueId: string | null
  filedAt: Date
  shippedAt: Date | null
  after: number | null
  afterAt: Date | null
  status: 'open' | 'shipped' | 'moved' | 'flat' | 'worse' | 'dropped' | 'unmeasured'
  reopens: string | null
}

/** Better, flat or worse against `before`, down being better: a change of under `MOVED_SHARE` of `before` is flat. */
export function movedDown(before: number, after: number): 'moved' | 'flat' | 'worse' {
  const change = before === 0 ? (after === 0 ? 0 : 1) : (after - before) / Math.abs(before)
  if (Math.abs(change) < MOVED_SHARE) return 'flat'
  return change < 0 ? 'moved' : 'worse'
}

/** An Issue as the ledger step sees it: how it ended and when it shipped. */
export interface IssueFate {
  state: string
  outcome: string | null
  shippedAt: Date | null
}

/** What reading the ledger changes in a row; `null` leaves it. */
export interface LedgerChange {
  id: string
  patch: Partial<Pick<FindingRow, 'status' | 'shippedAt' | 'after' | 'afterAt'>>
}

/**
 * The ledger's reading: an open finding whose Issue shipped is `shipped` with its ship time; one whose Issue closed
 * without shipping is `dropped`; a shipped one whose three days are over is measured over `[shipped, shipped + 3 days)`,
 * moved, flat or worse (`unmeasured` when its window has nothing to say). `measure` is called once per due finding; `undefined` (it could not read) leaves the row for the next pass.
 */
export async function readLedger(
  rows: readonly FindingRow[],
  fates: ReadonlyMap<string, IssueFate>,
  now: Date,
  measure: (row: FindingRow, window: { from: Date; to: Date }) => Promise<number | null | undefined>,
): Promise<LedgerChange[]> {
  const changes: LedgerChange[] = []
  for (const row of rows) {
    if (row.status === 'open' && row.issueId) {
      const fate = fates.get(row.issueId)
      if (fate?.shippedAt) changes.push({ id: row.id, patch: { status: 'shipped', shippedAt: fate.shippedAt } })
      else if (fate?.state === 'closed') changes.push({ id: row.id, patch: { status: 'dropped' } })
      continue
    }
    if (row.status !== 'shipped' || !row.shippedAt) continue
    const to = new Date(row.shippedAt.getTime() + AFTER_DELAY_MS)
    if (to.getTime() > now.getTime()) continue
    const after = await measure(row, { from: row.shippedAt, to })
    if (after === undefined) continue
    changes.push({
      id: row.id,
      patch:
        after === null
          ? { status: 'unmeasured', afterAt: now }
          : { status: movedDown(row.before, after), after, afterAt: now },
    })
  }
  return changes
}

/** A project holds one open improvement: while its Issue is not shipped nothing else is filed for it (a shipped one waits for its after without holding, `heldSubjects` keeps its subject out of the ranking). */
export const holdsProject = (rows: readonly FindingRow[], project: string): boolean =>
  rows.some((r) => r.project === project && r.status === 'open')

/** The newest finding row of a subject that did not move, so its Issue's text can name it. */
export function reopenedFrom(
  rows: readonly FindingRow[],
  c: Pick<Candidate, 'project' | 'kpi' | 'subject'>,
): FindingRow | null {
  return (
    rows
      .filter(
        (r) =>
          r.project === c.project &&
          r.kpi === c.kpi &&
          r.subject === c.subject &&
          (r.status === 'flat' || r.status === 'worse'),
      )
      .toSorted((a, b) => b.filedAt.getTime() - a.filedAt.getTime())[0] ?? null
  )
}

/**
 * The subjects the next ranking leaves out: a finding still `open` or `shipped` (its after is not read yet), one that moved
 * while the ranking window still reaches back before its ship (the cost it fixed is still in the window), and one dropped in
 * the last 14 days.
 */
export function heldSubjects(rows: readonly FindingRow[], now: Date): Set<string> {
  const held = new Set<string>()
  for (const r of rows) {
    const sinceFiled = now.getTime() - r.filedAt.getTime()
    const sinceShip = r.shippedAt ? now.getTime() - r.shippedAt.getTime() : Infinity
    if (
      r.status === 'open' ||
      r.status === 'shipped' ||
      (r.status === 'moved' && sinceShip < RANK_DAYS * DAY_MS) ||
      (r.status === 'dropped' && sinceFiled < BASELINE_DAYS * DAY_MS)
    ) {
      held.add(`${r.project}:${r.kpi}:${r.subject}`)
    }
  }
  return held
}

export const subjectKey = (c: Pick<Candidate, 'project' | 'kpi' | 'subject'>): string =>
  `${c.project}:${c.kpi}:${c.subject}`

const num = (value: number): string => {
  const text = value.toFixed(2)
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text
}

/** The improvement signal's title: stable per project and figure, so a repeat of an open Issue amends it. */
export const improvementTitle = (c: Pick<Candidate, 'project' | 'kpi' | 'subject'>): string => {
  const what: Record<ThroughputKpi, string> = {
    failed_run_minutes: 'cut the slot-minutes lost to failed test runs',
    slot_minutes_per_issue: 'bring the slot-minutes per closed Issue back to the median',
    step_peak_mib: `bring the ${c.subject} step’s peak memory under its budget`,
    process_growth_mib: `stop ${c.subject} growing without bound`,
    queued_minutes: 'cut the time Issues wait queued',
  }
  return `Throughput: ${what[c.kpi]} in ${c.project}`
}

/**
 * The improvement's text: the measured before, the target, the query, the earlier attempt when this finding comes back,
 * and the marker the weekly retro's ledger reads (`kpi= before= direction=`, on one line at the end).
 */
export function improvementText(c: Candidate, input: { date: string; reopens: FindingRow | null }): string {
  const lines = [
    `Why: ${c.label}. It is the largest measured cost of ${c.project} in the last ${RANK_DAYS} days (${num(c.costMinutes)} minutes), ranked by the throughput loop without a model.`,
    `Measured before: ${num(c.value)} ${c.unit} (kpi ${c.kpi}${c.subject === '*' ? '' : `, ${c.subject}`}). Target: ${num(c.target)} ${c.unit}.`,
    `Query: ${c.query}.`,
  ]
  if (c.kpi === 'step_peak_mib')
    lines.push(
      `The target is the project's peak budget (\`budgets.peak\` in project.yaml, ${DEFAULT_PEAK_MIB} MiB when none).`,
    )
  if (input.reopens) {
    lines.push(
      `Comes back: an earlier improvement (${input.reopens.issueId ?? 'no Issue'}) shipped on ${input.reopens.shippedAt?.toISOString().slice(0, 10) ?? 'a date not recorded'}; its after of ${num(input.reopens.after ?? 0)} ${c.unit} did not move from ${num(input.reopens.before)}. Find what the earlier change did not reach.`,
    )
  }
  lines.push(
    `Change only what moves this figure and keep the same coverage of what ships. Three days after the ship the loop reads the figure again over those days and says whether it moved; if it did not, this comes back.`,
    `Retro: ${input.date} kpi=${c.kpi} before=${num(c.value)} direction=down`,
  )
  return lines.join('\n')
}

// ---- budgets --------------------------------------------------------------------------------------------------------------

/** One budget of one project against the last day's runs. */
export interface BudgetFact {
  project: string
  /** the repo text intake knows the project by */
  repo: string
  budget: 'fast' | 'peak' | 'fail'
  /** what the budget says, in words (`90s`, `2GiB`, `10%`) */
  limit: string
  /** the day's figure in words, and whether it is over the limit */
  value: string
  over: boolean
}

/** A breach of a project budget as a self-watch finding: one signal on the project's repo until the figure is back inside. */
export function budgetFindings(facts: readonly BudgetFact[]): Finding[] {
  return facts
    .filter((fact) => fact.over)
    .map((fact) => ({
      kind: 'budget_breach' as const,
      subject: `${fact.project}:${fact.budget}`,
      repo: fact.repo,
      title: `Throughput budget: ${fact.project} is over its ${fact.budget} budget of ${fact.limit}`,
      facts: [`budget ${fact.budget} of ${fact.project} is ${fact.limit}`, 'the last day is over it'],
      context: [`Last day: ${fact.value}.`, 'The budget is `budgets:` in the project’s project.yaml.'],
      reproduce: `factory read throughput --hours 24 | .project[] | select(.repo == "${fact.project}")`,
    }))
}

/** A project's budgets as the loop judges them, with the repo text intake files its signals on. */
export interface ProjectBudgets {
  project: string
  repo: string
  fastMs: number | null
  peakMib: number | null
  failShare: number | null
}
