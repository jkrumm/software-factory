/**
 * The throughput loop's rules, with no I/O: what a day's facts rank as costs, the one improvement a project is asked for,
 * the figure that ledger row is measured by, and whether the figure moved three days after the ship. Costs are minutes of
 * the host's capacity (slot-minutes of failed or over-budget runs, minutes of queue or of a process that kept growing), so
 * the largest is the one worth a lead's time.
 */
import { DEFAULT_TENANT_BUDGET_MIB } from '../../kernel/throughput-limits.ts'
import { movedDown as movedBy, type ClosedFinding } from './ledger.ts'
import { subjectKeyOf, type Finding } from './selfwatch-model.ts'
import {
  BASELINE_DAYS,
  DEFAULT_PEAK_MIB,
  QUEUE_PROJECT,
  PROCESS_GROWTH_MIB,
  SLOT_MEMORY_MIB,
  TENANT_DAY_HOURS,
  TENANT_GROWTH_MIB,
  isKernelTask,
  isSharedMemoryProgram,
  isTransientScanner,
  isVmTenant,
  WAIT_SUBJECTS,
  type WaitSubject,
} from '../../kernel/throughput-limits.ts'

export const THROUGHPUT_KPIS = [
  'failed_run_minutes',
  'slot_minutes_per_issue',
  'step_peak_mib',
  'process_growth_mib',
  'queued_minutes',
  'tenant_class_mib',
  'tenant_growth_mib',
] as const
export type ThroughputKpi = (typeof THROUGHPUT_KPIS)[number]

/** The window the ranking reads, and the window a ship is measured over. */
export const RANK_DAYS = 7
export const AFTER_DAYS = 3
const DAY_MS = 86_400_000
const AFTER_DELAY_MS = AFTER_DAYS * DAY_MS

/** A finding costing less than this many minutes in the ranking window is not worth an Issue. */
const MIN_COST_MINUTES = 30
/** Slot-minutes per closed Issue is a finding when it is this far above the project's median of the 14 days before. */
const PER_ISSUE_FACTOR = 1.25
/** An after within this share of the before has not moved. */
const MOVED_SHARE = 0.1
/** The KPIs counted from single runs: a shipped fix of one retires the project's runs from before it (`lastFixOf`). */
const RUN_KPIS: readonly string[] = ['failed_run_minutes', 'step_peak_mib']
/** A step peak is not read again from fewer runs than this since the last fix: one run is no percentile. */
const MIN_RUNS_SINCE_FIX = 3
/** The most runs a finding lists. */
const RUNS_LISTED = 20
/** The share of `before` a time figure is asked to fall to. */
const TARGET_SHARE = 0.5

/** One finished test-slot step, as a finding lists the runs behind its figure. */
export interface StepRun {
  at: Date
  name: string
  minutes: number
  peakMib: number | null
  exitCode: number | null
  commit: string | null
  /** the last directory of where it was started: a lead's worktree names its Issue */
  dir: string | null
}

/** The host in the window `[from, to)`, as the loop reads it: raw figures per project, thresholds not applied. */
export interface WindowFacts {
  days: number
  runs: {
    project: string
    runs: number
    failedRuns: number
    failedMinutes: number
    minutes: number
    failed?: StepRun[]
  }[]
  /** slot minutes and Issues closed `done` in the window; the median of the same ratio per day over the 14 days before (null: none) */
  perIssue: { project: string; minutes: number; closed: number; baselineMedian: number | null }[]
  /** per project and tier: runs with a peak, their 90th percentile, the project's peak budget and the minutes of runs over it */
  steps: {
    project: string
    tier: string
    runs: number
    peakP90Mib: number
    budgetMib: number
    overMinutes: number
    /** the runs over the budget */
    over?: StepRun[]
  }[]
  /** a process whose footprint grew between its first and last notable minute in the window */
  processes: { name: string; class: string; project: string; grownMib: number; minutes: number }[]
  /** the minutes queued Issues waited for a reason a lead can cut, per reason and the project it is acted on */
  waits: WaitFact[]
  /** the tenant class (launchd jobs and VMs) as the hourly rollups of the window give it */
  tenants: TenantFacts
}

/**
 * The tenant class over a window, from `host_class_hours`: means are the summed MiB-minutes over the sampled hours times 60,
 * so an hour a tenant is absent counts 0 (a cluster's shared mapping is counted once, as the class rows store it).
 */
export interface TenantFacts {
  /** the hours of the window with class rows; 0 means the window has no reading */
  hours: number
  /** the class's mean footprint over the window, MiB */
  classMib: number
  /** every tenant's mean footprint over the window, largest first */
  members: { tenant: string; mib: number }[]
  /** with a baseline: each tenant's mean over the window's newest 24 hours, and its median over the 14 days before them (null: too short a past to say) */
  day: { tenant: string; mib: number; medianMib: number | null }[]
}

/** Where tenant findings are filed (the repo that owns the host's configuration) and the class's budget. */
export interface TenantPolicy {
  project: string
  budgetMib: number
}

/** A project's `leads` and the cap it sets on each lane (`leads` of the lane; null: none), as its project.yaml declares them. */
export interface ProjectShape {
  leads: number
  lanes: ReadonlyMap<string, number | null>
}

/**
 * Queue minutes (`factory.queue_intervals`) clipped to the window, for one reason of `WAIT_SUBJECTS`. A memory or account wait
 * is the factory's to cut (`project` is the factory); a claim or lane wait is a repo's (`project` is that repo), whose
 * `leads` and lanes the finding names.
 */
export interface WaitFact {
  reason: WaitSubject
  project: string
  minutes: number
  /** the distinct Issues that waited */
  issues: number
  /** the repos the waiting Issues belonged to, the most minutes first */
  repos: { project: string; minutes: number }[]
  /** memory only: the minutes of `minutes` that were the lead-fit refusal (a repo's lead learned to take more than is free) */
  fitMinutes: number
  /** claim and lane: the project's `leads`; null when not known */
  leads: number | null
  /** claim and lane: the lanes the waiting Issues were filed in, with the project's cap on each (null: none) and the minutes waited */
  lanes: { name: string; leads: number | null; minutes: number }[]
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
  /** the runs the figure was computed from, one line each; absent for a figure no single run makes */
  evidence?: string[]
  /** set when only the runs since a shipped fix were counted */
  since?: FixShip
}

/** A shipped improvement of a project's KPI. */
export interface FixShip {
  at: Date
  issueId: string
}

const runLine = (r: StepRun): string =>
  [
    `${r.at.toISOString().slice(0, 16)}Z ${r.name}`,
    r.peakMib === null ? null : `peak ${r.peakMib} MiB`,
    `${Math.round(r.minutes * 10) / 10} min`,
    r.exitCode === null ? 'no exit code' : `exit ${r.exitCode}`,
    r.commit === null ? null : `commit ${r.commit.slice(0, 8)}`,
    r.dir === null ? null : `in ${r.dir}`,
  ]
    .filter((part) => part !== null)
    .join(', ')

/** The listed runs, largest first by `size`, and how many are left out. */
const evidenceOf = (runs: readonly StepRun[] | undefined, size: (r: StepRun) => number): { evidence?: string[] } => {
  if (!runs || runs.length === 0) return {}
  const listed = runs
    .toSorted((a, b) => size(b) - size(a) || b.at.getTime() - a.at.getTime())
    .slice(0, RUNS_LISTED)
    .map(runLine)
  const rest = runs.length - listed.length
  return { evidence: rest > 0 ? [...listed, `${rest} more`] : listed }
}

const byCost = (a: Candidate, b: Candidate): number =>
  b.costMinutes - a.costMinutes ||
  a.project.localeCompare(b.project) ||
  a.kpi.localeCompare(b.kpi) ||
  a.subject.localeCompare(b.subject)

const round = (value: number, decimals = 1): number => Math.round(value * 10 ** decimals) / 10 ** decimals

const READ_HOURS = '--hours 168'
const READ = `factory read throughput ${READ_HOURS}`
const MINUTES_PER_DAY = 1440

const gib = (mib: number): string => `${round(mib / 1024)} GiB`

const minutesText = (minutes: number): string => `${Math.round(minutes)} min`
const hitMost = (repos: WaitFact['repos']): string =>
  repos.length === 0
    ? ''
    : `; hit most: ${repos
        .slice(0, 3)
        .map((r) => `${r.project} ${minutesText(r.minutes)}`)
        .join(', ')}`
const lanesText = (lanes: WaitFact['lanes']): string =>
  lanes.length === 0
    ? ''
    : `; lanes: ${lanes.map((l) => `${l.name}${l.leads === null ? '' : ` (leads: ${l.leads})`} ${minutesText(l.minutes)}`).join(', ')}`
const leadsText = (leads: number | null): string => (leads === null ? '' : ` (\`leads: ${leads}\` in its project.yaml)`)

/** What a wait finding says it measured, and who it hit. */
function waitLabel(q: WaitFact): string {
  const issues = `${q.issues} Issue${q.issues === 1 ? '' : 's'}`
  switch (q.reason) {
    case 'memory': {
      const fit = q.fitMinutes > 0 ? `, ${minutesText(q.fitMinutes)} of it a lead that did not fit the free memory` : ''
      return `${round(q.minutes)} minutes queued for host memory by ${issues}${fit}${hitMost(q.repos)}`
    }
    case 'account':
      return `${round(q.minutes)} minutes queued for an account (its window closed, or its lead cap) by ${issues}${hitMost(q.repos)}`
    case 'claim':
      return `${round(q.minutes)} minutes ${issues} of ${q.project} queued for a free claim in the repo${leadsText(q.leads)}${lanesText(q.lanes)}`
    case 'lane':
      return `${round(q.minutes)} minutes ${issues} of ${q.project} queued for a lane's cap${leadsText(q.leads)}${lanesText(q.lanes)}`
  }
}

/** The read that shows a wait finding's figure again. */
function waitQuery(q: WaitFact, days: number): string {
  const kinds = WAIT_SUBJECTS[q.reason].map((k) => `.kind == "${k}"`).join(' or ')
  const all = `\`factory read capacity-loop --days ${days} | .queueByReason[] | select(${kinds})\` (queuedHours, divided by the ${days} days)`
  return q.project === QUEUE_PROJECT
    ? all
    : `the queue_intervals of ${q.project} of kind ${WAIT_SUBJECTS[q.reason].join(' or ')} (the minutes between from_at and to_at in the window, divided by the ${days} days); ${all} for every project together`
}

/** What the window's facts rank as costs, largest first (then project, kpi, subject). */
export function rankCandidates(facts: WindowFacts, tenants: TenantPolicy | null = null): Candidate[] {
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
      query: `${READ} | .tests.byProject[] | select(.repo == "${r.project}") | .failedRunMinutes, divided by the ${round(days, 2)} days`,
      ...evidenceOf(r.failed, (run) => run.minutes),
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
      ...evidenceOf(s.over, (run) => run.peakMib ?? 0),
    })
  }
  for (const p of facts.processes) {
    // a tenant's growth is `tenant_growth_mib`'s, filed on the repo that owns the host's configuration; an owner's process
    // (an app, a terminal's `npm` or `bun`) runs no code of a repo here, so no Issue can shrink it
    if (
      p.grownMib < PROCESS_GROWTH_MIB ||
      isSharedMemoryProgram(p.name) ||
      isKernelTask(p.name) ||
      isTransientScanner(p.name) ||
      p.class === 'tenant' ||
      p.class === 'owner'
    )
      continue
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
  for (const q of facts.waits) {
    if (q.minutes < MIN_COST_MINUTES) continue
    const perDay = q.minutes / days
    found.push({
      project: q.project,
      kpi: 'queued_minutes',
      subject: q.reason,
      label: waitLabel(q),
      value: round(perDay),
      unit: 'minutes/day',
      target: round(perDay * TARGET_SHARE),
      costMinutes: round(q.minutes),
      query: waitQuery(q, days),
    })
  }
  if (tenants) found.push(...tenantCandidates(facts, tenants))
  return found.toSorted(byCost)
}

/** The newest shipped fix of the candidate's project and KPI, whatever its subject; null for a KPI not counted from runs. */
export function lastFixOf(rows: readonly FindingRow[], c: Pick<Candidate, 'project' | 'kpi'>): FixShip | null {
  if (!RUN_KPIS.includes(c.kpi)) return null
  let last: FixShip | null = null
  for (const r of rows) {
    if (r.project !== c.project || r.kpi !== c.kpi || !r.shippedAt) continue
    if (!last || r.shippedAt > last.at) last = { at: r.shippedAt, issueId: r.issueId }
  }
  return last
}

/**
 * A candidate read again from `facts` of the window since the last fix, so runs the fix already covered make no finding;
 * null when those runs do not rank it (under its threshold, or too few of them for a step's percentile).
 */
export function countedSince(facts: WindowFacts, candidate: Candidate, fix: FixShip): Candidate | null {
  const again = rankCandidates(facts).find((c) => subjectKey(c) === subjectKey(candidate))
  if (!again) return null
  if (again.kpi === 'step_peak_mib') {
    const step = facts.steps.find((s) => s.project === again.project && s.tier === again.subject)
    if (!step || step.runs < MIN_RUNS_SINCE_FIX) return null
  }
  // the read that shows the figure again covers the same window as the figure
  const hours = Math.max(1, Math.round(facts.days * 24))
  return { ...again, query: again.query.replace(READ_HOURS, `--hours ${hours}`), since: fix }
}

export const rankOrder = (candidates: readonly Candidate[]): Candidate[] => candidates.toSorted(byCost)

/**
 * The two findings about standing memory, both filed on `policy.project` (a tenant is a launchd job or VM that repo
 * configures). The excess is turned into minutes of capacity as slot-minutes: the minutes a test slot of `SLOT_MEMORY_MIB`
 * (the default step budget) could have held it, over the window for the class and over the newest day for a tenant.
 */
function tenantCandidates(facts: WindowFacts, policy: TenantPolicy): Candidate[] {
  const found: Candidate[] = []
  const { tenants } = facts
  if (tenants.hours === 0) return found
  const days = Math.max(1, facts.days)
  if (tenants.classMib > policy.budgetMib) {
    const largest = tenants.members
      .slice(0, 3)
      .map((m) => `${m.tenant} ${gib(m.mib)}`)
      .join(', ')
    found.push({
      project: policy.project,
      kpi: 'tenant_class_mib',
      subject: '*',
      label: `the tenant class held ${gib(tenants.classMib)} on average over ${round(days)} days against its budget of ${gib(policy.budgetMib)}; the largest tenants: ${largest}`,
      value: round(tenants.classMib, 0),
      unit: 'MiB',
      target: policy.budgetMib,
      costMinutes: round(((tenants.classMib - policy.budgetMib) / SLOT_MEMORY_MIB) * days * MINUTES_PER_DAY),
      query: `${READ} | .host.byCause[] | select(.class == "tenant") | .footprintMib, against .host.tenantBudget.budgetMib; .host.byTenant[] for the tenants`,
    })
  }
  for (const t of tenants.day) {
    if (t.medianMib === null || t.mib - t.medianMib < TENANT_GROWTH_MIB) continue
    // a VM that ran in the past fills up to its ceiling (`isVmTenant`); one that was not there (median 0) is new memory
    if (isVmTenant(t.tenant) && t.medianMib > 0) continue
    found.push({
      project: policy.project,
      kpi: 'tenant_growth_mib',
      subject: t.tenant,
      label: `${t.tenant} held ${gib(t.mib)} on average over the last ${TENANT_DAY_HOURS} hours against a median of ${gib(t.medianMib)} over the 14 days before`,
      value: round(t.mib, 0),
      unit: 'MiB',
      target: round(t.medianMib, 0),
      costMinutes: round(((t.mib - t.medianMib) / SLOT_MEMORY_MIB) * (TENANT_DAY_HOURS * 60)),
      query: `${READ} | .host.byTenant[] | select(.tenant == "${t.tenant}") | .footprintMib; its median of the 14 days before is in \`host_class_hours\` (class tenant, one row per hour)`,
    })
  }
  return found
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
      // the one figure of the first rule (`*`: every wait from filing to admission) is not recorded by reason: nothing to read
      if (finding.subject === '*') return null
      const q = facts.waits.find((x) => x.project === finding.project && x.reason === finding.subject)
      return q ? round(q.minutes / days) : 0
    }
    case 'tenant_class_mib':
      return facts.tenants.hours === 0 ? null : round(facts.tenants.classMib, 0)
    case 'tenant_growth_mib':
      // a tenant that does not appear in a window with readings held nothing
      return facts.tenants.hours === 0
        ? null
        : round(facts.tenants.members.find((m) => m.tenant === finding.subject)?.mib ?? 0, 0)
  }
}

/** One finding as the ledger stores it (`loop_findings`, `migrations/1061_loop_ledger.sql`); `id` is its Issue. */
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
  signalId: string | null
  issueId: string
  filedAt: Date
  shippedAt: Date | null
  after: number | null
  afterAt: Date | null
  status: 'open' | 'shipped' | 'moved' | 'flat' | 'worse' | 'dropped' | 'unmeasured'
  reopens: string | null
}

/** Better, flat or worse against `before`, down being better: a change of under `MOVED_SHARE` of `before` is flat. */
export function movedDown(before: number, after: number): 'moved' | 'flat' | 'worse' {
  return movedBy(before, after, MOVED_SHARE)
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
  /** the counting epoch: a shipped finding filed before it has no `before` on this side, so it is `unmeasured`, never judged */
  epoch: Date | null = null,
): Promise<LedgerChange[]> {
  const changes: LedgerChange[] = []
  for (const row of rows) {
    if (epoch !== null && row.status === 'shipped' && row.filedAt < epoch) {
      changes.push({ id: row.id, patch: { status: 'unmeasured', afterAt: now } })
      continue
    }
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

/** What a `queued_minutes` subject waited for, in a title. */
const QUEUE_WAITS: Record<string, string> = {
  memory: 'host memory',
  account: 'an account',
  claim: 'a claim',
  lane: 'a lane',
}

/** The improvement signal's title: stable per project and figure, so a repeat of an open Issue amends it. */
export const improvementTitle = (c: Pick<Candidate, 'project' | 'kpi' | 'subject'>): string => {
  const what: Record<ThroughputKpi, string> = {
    failed_run_minutes: 'cut the slot-minutes lost to failed test runs',
    slot_minutes_per_issue: 'bring the slot-minutes per closed Issue back to the median',
    step_peak_mib: `bring the ${c.subject} step’s peak memory under its budget`,
    process_growth_mib: `stop ${c.subject} growing without bound`,
    queued_minutes: `cut the time Issues wait queued for ${QUEUE_WAITS[c.subject] ?? 'a reason'}`,
    tenant_class_mib: 'bring the standing memory of the tenant class under its budget',
    tenant_growth_mib: `bring ${c.subject} back to the memory it usually holds`,
  }
  return `Throughput: ${what[c.kpi]} in ${c.project}`
}

/**
 * The improvement's text: the measured before, the target, the query, the earlier attempt when this finding comes back,
 * and the marker the weekly retro's ledger reads (`kpi= before= direction=`, on one line at the end).
 */
export function improvementText(c: Candidate, input: { date: string; reopens: FindingRow | null }): string {
  const window = c.since
    ? `since ${c.since.at.toISOString().slice(0, 16)}Z, when the last fix of this figure (${c.since.issueId}) shipped; earlier runs are not counted`
    : `in the last ${RANK_DAYS} days`
  const lines = [
    `Why: ${c.label}. It is the largest measured cost of ${c.project} ${window} (${num(c.costMinutes)} minutes), ranked by the throughput loop without a model.`,
    `Measured before: ${num(c.value)} ${c.unit} (kpi ${c.kpi}${c.subject === '*' ? '' : `, ${c.subject}`}). Target: ${num(c.target)} ${c.unit}.`,
    `Query: ${c.query}.`,
  ]
  if (c.kpi === 'step_peak_mib')
    lines.push(
      `The target is the project's peak budget (\`budgets.peak\` in project.yaml, ${DEFAULT_PEAK_MIB} MiB when none).`,
    )
  if (c.kpi === 'tenant_class_mib' || c.kpi === 'tenant_growth_mib')
    lines.push(
      c.kpi === 'tenant_class_mib'
        ? `The memory is the host's, not this repo's: a tenant is a launchd job or a VM this repo configures. The target is the tenant class's budget (${DEFAULT_TENANT_BUDGET_MIB} MiB). The cost counts the excess as slot-minutes: the minutes a test slot of ${SLOT_MEMORY_MIB} MiB could have held it over ${RANK_DAYS} days.`
        : `The memory is the host's, not this repo's: a tenant is a launchd job or a VM this repo configures. The rule needs no list of tenants: a tenant ${TENANT_GROWTH_MIB} MiB or more above its own median fires it (a VM only when it was not there before: one that ran fills up to its configured ceiling), and the target is that median. The cost counts the excess as slot-minutes over the ${TENANT_DAY_HOURS} hours.`,
    )
  if (input.reopens) {
    lines.push(
      `Comes back: an earlier improvement (${input.reopens.issueId ?? 'no Issue'}) shipped on ${input.reopens.shippedAt?.toISOString().slice(0, 10) ?? 'a date not recorded'}; its after of ${num(input.reopens.after ?? 0)} ${c.unit} did not move from ${num(input.reopens.before)}. Find what the earlier change did not reach.`,
    )
  }
  if (c.evidence) {
    const what = c.kpi === 'step_peak_mib' ? 'over the budget, largest peak first' : 'that failed, longest first'
    lines.push(`Runs ${what}:\n${c.evidence.map((line) => `- ${line}`).join('\n')}`)
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
  /** more lines for the lead (the failing steps of a `fail` breach): context, never hashed */
  detail?: string[]
  /** the day's number the breach is filed against, kept in the ledger (a `fail` breach: the failed share in percent) */
  figure?: number
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
      ...(fact.figure === undefined ? {} : { figure: fact.figure }),
      facts: [`budget ${fact.budget} of ${fact.project} is ${fact.limit}`, 'the last day is over it'],
      context: [
        `Last day: ${fact.value}.`,
        ...(fact.detail ?? []),
        'The budget is `budgets:` in the project’s project.yaml.',
      ],
      reproduce: `factory read throughput --hours 24 | .project[] | select(.repo == "${fact.project}")`,
    }))
}

/**
 * Why a `fail` breach is not filed now, or null to file it (any other finding: null). The cost of failed runs is the one
 * the throughput loop ranks (`failed_run_minutes`): while that improvement of the project is not shipped and not closed
 * (`improving`, by project) the breach is the same cost twice. After the breach's last Issue closed `dropped`
 * (`previous`), only a share worse than the one that Issue was filed against is news.
 */
export function failBreachHeld(
  finding: Finding,
  input: { improving: ReadonlyMap<string, string>; previous: ClosedFinding | undefined },
): string | null {
  if (finding.kind !== 'budget_breach' || !finding.subject.endsWith(':fail')) return null
  const improvement = input.improving.get(finding.subject.slice(0, -':fail'.length))
  if (improvement) return `${subjectKeyOf(finding)} (${improvement} holds the cost of its failed runs)`
  const { previous } = input
  if (previous?.outcome !== 'dropped' || previous.figure === null || finding.figure === undefined) return null
  if (finding.figure > previous.figure) return null
  return `${subjectKeyOf(finding)} (${previous.issue} was dropped at ${previous.figure}%, now ${finding.figure}%)`
}

/** A project's budgets as the loop judges them, with the repo text intake files its signals on. */
export interface ProjectBudgets {
  project: string
  repo: string
  fastMs: number | null
  peakMib: number | null
  failShare: number | null
  /** its `leads` and lane caps, named by a claim or lane wait's finding */
  shape?: ProjectShape
  /** the repo's absolute path: where its `project.yaml` is read to quote the comment of a cap */
  path?: string
}

/**
 * Whether a candidate's cost is already gone: its figure over the newest days (`recent`, the window a ship is measured over)
 * is at or under the target. A cost fixed days ago still sits in the 7-day total, and an Issue filed for it could only be
 * closed. A figure the recent days cannot give (no run, no closed Issue) says nothing, so the candidate stands.
 */
export function alreadyAtTarget(recent: WindowFacts, candidate: Candidate): boolean {
  const figure = figureOf(recent, candidate)
  return figure !== null && figure <= candidate.target
}
