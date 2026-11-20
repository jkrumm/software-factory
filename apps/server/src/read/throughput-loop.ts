import type { SQL } from 'bun'
import * as z from 'zod'
import type {
  BudgetFact,
  IssueFate,
  ProjectBudgets,
  ProjectShape,
  TenantFacts,
  WaitFact,
  WindowFacts,
} from '../domains/improve/throughput.ts'
import { countedFrom, isCut, MIN_CUT_BASELINE_DAYS } from '../kernel/epoch.ts'
import {
  BASELINE_DAYS,
  DEFAULT_PEAK_MIB,
  MEMORY_FIT_KIND,
  MIN_FAIL_RUNS,
  MIN_FAST_RUNS,
  QUEUE_PROJECT,
  PROCESS_GROWTH_MIB,
  MIN_TENANT_BASELINE_DAYS,
  TENANT_DAY_HOURS,
  WAIT_SUBJECTS,
  waitSubjectOf,
} from '../kernel/throughput-limits.ts'
import { boundedRead } from './bounded.ts'
import { queuedHours } from './queue-time.ts'
import { REPO_OF_STEP } from './retro-build.ts'

const DAY_MS = 86_400_000
const num = z.coerce.number()

/** The tier of a step: `<project> check-fast` is `fast`, `<project> check` is `full`, any other step its own last word. */
const tierOf = (name: string): string => {
  const last = name.slice(name.lastIndexOf(' ') + 1)
  return last === 'check-fast' ? 'fast' : last === 'check' ? 'full' : last
}

const StepRow = z.object({
  repo: z.string(),
  name: z.string(),
  duration_ms: num,
  exit_code: z.coerce.number().nullable(),
  peak: z.coerce.number().nullable(),
  at: z.coerce.date(),
})

const percentile = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) return 0
  const rank = (sorted.length - 1) * p
  const low = Math.floor(rank)
  const high = Math.ceil(rank)
  return (sorted[low] ?? 0) + ((sorted[high] ?? 0) - (sorted[low] ?? 0)) * (rank - low)
}

interface WaitRow {
  kind: string
  project: string
  lane: string
  issue_ids: string
  minutes: number
}

/**
 * The wait rows as findings read them: memory and account waits are the factory's (one fact per reason, the repos they hit
 * named), a claim or lane wait is the repo's own (one fact per project, with its `leads` and the lanes its Issues waited in).
 */
function waitFacts(rows: readonly WaitRow[], shapes: ReadonlyMap<string, ProjectShape>): WaitFact[] {
  const facts = new Map<string, WaitFact & { ids: Set<string> }>()
  const byRepo = new Map<string, Map<string, number>>()
  for (const row of rows) {
    const reason = waitSubjectOf(row.kind)
    if (reason === null) continue
    const factory = reason === 'memory' || reason === 'account'
    const project = factory ? QUEUE_PROJECT : row.project
    const k = `${reason}\n${project}`
    const shape = shapes.get(row.project)
    const fact = facts.get(k) ?? {
      reason,
      project,
      minutes: 0,
      issues: 0,
      repos: [],
      fitMinutes: 0,
      leads: factory ? null : (shape?.leads ?? null),
      lanes: [],
      ids: new Set<string>(),
    }
    fact.minutes += row.minutes
    for (const id of row.issue_ids.split(',')) fact.ids.add(id)
    if (row.kind === MEMORY_FIT_KIND) fact.fitMinutes += row.minutes
    if (!factory && row.lane !== '') {
      const named = fact.lanes.find((l) => l.name === row.lane)
      if (named) named.minutes += row.minutes
      else fact.lanes.push({ name: row.lane, leads: shape?.lanes.get(row.lane) ?? null, minutes: row.minutes })
    }
    const repos = byRepo.get(k) ?? new Map<string, number>()
    repos.set(row.project, (repos.get(row.project) ?? 0) + row.minutes)
    byRepo.set(k, repos)
    facts.set(k, fact)
  }
  return [...facts.entries()].map(([k, { ids, ...fact }]) => ({
    ...fact,
    issues: ids.size,
    repos: [...(byRepo.get(k) ?? [])]
      .map(([project, minutes]) => ({ project, minutes }))
      .toSorted((a, b) => b.minutes - a.minutes || a.project.localeCompare(b.project)),
    lanes: fact.lanes.toSorted((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name)),
  }))
}

const stepRows = async (tx: SQL, from: Date, to: Date) =>
  (
    (await tx`
      SELECT ${tx.unsafe(REPO_OF_STEP)} AS repo, name, duration_ms, exit_code, peak_rss_mib AS peak, at
      FROM factory.step_costs WHERE repo IS NOT NULL AND at >= ${from} AND at < ${to}`) as unknown[]
  ).map((raw) => StepRow.parse(raw))

const HOUR_MS = 3_600_000

const median = (values: readonly number[]): number =>
  percentile(
    values.toSorted((a, b) => a - b),
    0.5,
  )

/**
 * The tenant class over `[from, to)` from the hourly rollups (`host_class_hours`: complete hours only, so an hour that had
 * not ended by `to` is not read). A mean is the summed MiB-minutes over the window's sampled hours times 60, so an hour a
 * tenant is absent counts 0. With `baseline`, each tenant's mean over the newest `TENANT_DAY_HOURS` is returned with its
 * median over the `BASELINE_DAYS` buckets of that length before them: a bucket is a day of the host being sampled, a
 * tenant absent in one counts 0, and fewer than `MIN_TENANT_BASELINE_DAYS` such buckets leave the median null.
 */
async function readTenantFacts(
  tx: SQL,
  from: Date,
  to: Date,
  baseline: boolean,
  epoch: Date | null = null,
): Promise<TenantFacts> {
  const dayFrom = countedFrom(new Date(to.getTime() - TENANT_DAY_HOURS * HOUR_MS), epoch)
  const since = countedFrom(new Date(dayFrom.getTime() - BASELINE_DAYS * TENANT_DAY_HOURS * HOUR_MS), epoch)
  const start = baseline ? new Date(Math.min(from.getTime(), since.getTime())) : from
  const hourRows: unknown[] = await tx`
    SELECT DISTINCT hour FROM factory.host_class_hours
    WHERE hour >= ${start} AND hour + interval '1 hour' <= ${to}`
  const tenantRows: unknown[] = await tx`
    SELECT hour, tenant, sum(mib_minutes)::float8 AS mib_minutes FROM factory.host_class_hours
    WHERE class = 'tenant' AND tenant <> '' AND hour >= ${start} AND hour + interval '1 hour' <= ${to}
    GROUP BY hour, tenant`
  const hours = hourRows.map((raw) => z.object({ hour: z.coerce.date() }).parse(raw).hour.getTime())
  const rows = tenantRows.map((raw) =>
    z.object({ hour: z.coerce.date(), tenant: z.string(), mib_minutes: num }).parse(raw),
  )
  const means = (windowFrom: Date) => {
    const sampled = hours.filter((h) => h >= windowFrom.getTime()).length
    const sums = new Map<string, number>()
    for (const r of rows) {
      if (r.hour.getTime() >= windowFrom.getTime()) sums.set(r.tenant, (sums.get(r.tenant) ?? 0) + r.mib_minutes)
    }
    return { sampled, mean: (tenant: string) => (sampled === 0 ? 0 : (sums.get(tenant) ?? 0) / (sampled * 60)), sums }
  }
  const window = means(from)
  const members = [...window.sums.keys()]
    .map((tenant) => ({ tenant, mib: Math.round(window.mean(tenant)) }))
    .toSorted((a, b) => b.mib - a.mib || a.tenant.localeCompare(b.tenant))
  const classMib = members.reduce((sum, m) => sum + m.mib, 0)

  const day: TenantFacts['day'] = []
  if (baseline) {
    const newest = means(dayFrom)
    const bucketMs = TENANT_DAY_HOURS * HOUR_MS
    // bucket 0 is the oldest of the 14 days before the newest 24 hours
    const bucketOf = (at: number) => Math.floor((at - since.getTime()) / bucketMs)
    const sampledBuckets = new Map<number, number>()
    for (const h of hours) {
      if (h < since.getTime() || h >= dayFrom.getTime()) continue
      sampledBuckets.set(bucketOf(h), (sampledBuckets.get(bucketOf(h)) ?? 0) + 1)
    }
    const perBucket = new Map<string, Map<number, number>>()
    for (const r of rows) {
      if (r.hour.getTime() < since.getTime() || r.hour.getTime() >= dayFrom.getTime()) continue
      const buckets = perBucket.get(r.tenant) ?? new Map<number, number>()
      buckets.set(bucketOf(r.hour.getTime()), (buckets.get(bucketOf(r.hour.getTime())) ?? 0) + r.mib_minutes)
      perBucket.set(r.tenant, buckets)
    }
    const enough = sampledBuckets.size >= MIN_TENANT_BASELINE_DAYS
    for (const tenant of new Set([...newest.sums.keys(), ...perBucket.keys()])) {
      const buckets = perBucket.get(tenant)
      day.push({
        tenant,
        mib: Math.round(newest.mean(tenant)),
        medianMib: enough
          ? Math.round(median([...sampledBuckets].map(([b, n]) => (buckets?.get(b) ?? 0) / (n * 60))))
          : null,
      })
    }
    day.sort((a, b) => a.tenant.localeCompare(b.tenant))
  }
  return { hours: window.sampled, classMib, members, day }
}

/**
 * The host over `[from, to)` as the throughput loop ranks it: the raw figures per project from `step_costs`, the closed
 * Issues, the notable processes and the queue intervals. `peakBudgetMib` is a project's `budgets.peak` (the default
 * for a project not in it). With `baseline`, a project's slot-minutes per closed Issue also carries the median of the same
 * ratio per day over the 14 days before `from`. Every figure is SQL over stored rows, bounded so a slow read ends as an
 * error the pass notes.
 */
export async function readWindowFacts(
  sql: SQL,
  options: {
    from: Date
    to: Date
    peakBudgetMib: ReadonlyMap<string, number>
    baseline: boolean
    /** per project: its `leads` and lane caps, named in a claim or lane wait's finding; absent: not named */
    shapes?: ReadonlyMap<string, ProjectShape>
    /** the counting epoch: the window starts there when it is later, and a baseline it cuts needs 3 days after it */
    epoch?: Date | null
  },
): Promise<WindowFacts> {
  const epoch = options.epoch ?? null
  const from = countedFrom(options.from, epoch)
  const { to } = options
  const days = Math.max(0, (to.getTime() - from.getTime()) / DAY_MS)
  return boundedRead(sql, 20_000, async (tx) => {
    const steps = await stepRows(tx, from, to)

    const runs = new Map<string, WindowFacts['runs'][number]>()
    const peaks = new Map<string, { project: string; tier: string; peaks: number[]; minutes: number[] }>()
    for (const row of steps) {
      const failed = row.exit_code !== null && row.exit_code !== 0
      const minutes = row.duration_ms / 60_000
      const r = runs.get(row.repo) ?? { project: row.repo, runs: 0, failedRuns: 0, failedMinutes: 0, minutes: 0 }
      r.runs++
      r.minutes += minutes
      if (failed) {
        r.failedRuns++
        r.failedMinutes += minutes
      }
      runs.set(row.repo, r)
      if (row.peak === null) continue
      const tier = tierOf(row.name)
      const k = `${row.repo}\n${tier}`
      const p = peaks.get(k) ?? { project: row.repo, tier, peaks: [], minutes: [] }
      p.peaks.push(row.peak)
      p.minutes.push(minutes)
      peaks.set(k, p)
    }

    const closedRows: unknown[] = await tx`
      SELECT i.repo, count(*) AS closed FROM factory.issue_events e JOIN factory.issues i ON i.id = e.issue_id
      WHERE e.result = 'applied' AND e.to_state = 'closed' AND e.outcome = 'done' AND e.at >= ${from} AND e.at < ${to}
      GROUP BY i.repo`
    const closed = new Map(
      closedRows.map((raw) => z.object({ repo: z.string(), closed: num }).parse(raw)).map((r) => [r.repo, r.closed]),
    )

    const baseline = new Map<string, number>()
    if (options.baseline) {
      const wanted = new Date(from.getTime() - BASELINE_DAYS * DAY_MS)
      const since = countedFrom(wanted, epoch)
      // a baseline the epoch cuts is a median of the days after it: with fewer than 3 of them there is none
      const needed = isCut(wanted, epoch) ? MIN_CUT_BASELINE_DAYS : 1
      const rows: unknown[] = await tx`
        WITH slot AS (
          SELECT ${tx.unsafe(REPO_OF_STEP)} AS repo, date_trunc('day', at) AS d, sum(duration_ms) / 60000.0 AS m
          FROM factory.step_costs WHERE repo IS NOT NULL AND at >= ${since} AND at < ${from} GROUP BY 1, 2),
        done AS (
          SELECT i.repo, date_trunc('day', e.at) AS d, count(*) AS c
          FROM factory.issue_events e JOIN factory.issues i ON i.id = e.issue_id
          WHERE e.result = 'applied' AND e.to_state = 'closed' AND e.outcome = 'done' AND e.at >= ${since} AND e.at < ${from}
          GROUP BY 1, 2)
        SELECT slot.repo, percentile_cont(0.5) WITHIN GROUP (ORDER BY slot.m / done.c)::float8 AS median
        FROM slot JOIN done ON done.repo = slot.repo AND done.d = slot.d GROUP BY slot.repo
        HAVING count(*) >= ${needed}`
      for (const raw of rows) {
        const r = z.object({ repo: z.string(), median: num }).parse(raw)
        baseline.set(r.repo, r.median)
      }
    }

    const grown: unknown[] = await tx`
      SELECT name, class, coalesce(repo, '') AS repo, max(footprint_mib) - min(footprint_mib) AS grown, count(*) AS minutes
      FROM factory.host_process_samples WHERE at >= ${from} AND at < ${to}
      GROUP BY pid, name, class, repo HAVING max(footprint_mib) - min(footprint_mib) >= ${PROCESS_GROWTH_MIB}`
    // the waits a lead can cut, by interval kind, project and the lane the Issue was filed in, clipped to the window
    const waitKinds = new Set<string>(Object.values(WAIT_SUBJECTS).flat())
    const spans = (await queuedHours(tx, { from, to })).filter((s) => waitKinds.has(s.kind))
    const queuedIssues = [...new Set(spans.map((s) => s.issue))]
    const laneRows: unknown[] =
      queuedIssues.length === 0
        ? []
        : await tx`
      SELECT issue_id, coalesce(payload->>'lane', '') AS lane FROM factory.issue_events
      WHERE kind = 'filed' AND version = 1 AND issue_id IN ${tx(queuedIssues)}`
    const laneOf = new Map(
      laneRows
        .map((raw) => z.object({ issue_id: z.string(), lane: z.string() }).parse(raw))
        .map((r) => [r.issue_id, r.lane]),
    )
    const waited = [...Map.groupBy(spans, (s) => JSON.stringify([s.kind, s.project, laneOf.get(s.issue) ?? '']))].map(
      ([key, rows]) => {
        const [kind, project, lane] = z.tuple([z.string(), z.string(), z.string()]).parse(JSON.parse(key))
        return {
          kind,
          project,
          lane,
          issue_ids: [...new Set(rows.map((s) => s.issue))].join(','),
          minutes: rows.reduce((sum, s) => sum + s.hours * 60, 0),
        }
      },
    )

    const tenants = await readTenantFacts(tx, from, to, options.baseline, epoch)
    const projects = new Set([...runs.keys(), ...closed.keys()])
    return {
      days,
      runs: [...runs.values()],
      perIssue: [...projects].map((project) => ({
        project,
        minutes: runs.get(project)?.minutes ?? 0,
        closed: closed.get(project) ?? 0,
        baselineMedian: baseline.get(project) ?? null,
      })),
      steps: [...peaks.values()].map((p) => {
        const budgetMib = options.peakBudgetMib.get(p.project) ?? DEFAULT_PEAK_MIB
        return {
          project: p.project,
          tier: p.tier,
          runs: p.peaks.length,
          peakP90Mib: Math.round(
            percentile(
              p.peaks.toSorted((a, b) => a - b),
              0.9,
            ),
          ),
          budgetMib,
          overMinutes: p.peaks.reduce((sum, peak, i) => (peak > budgetMib ? sum + (p.minutes[i] ?? 0) : sum), 0),
        }
      }),
      processes: grown.map((raw) => {
        const r = z
          .object({ name: z.string(), class: z.string(), repo: z.string(), grown: num, minutes: num })
          .parse(raw)
        return {
          name: r.name,
          class: r.class,
          project: r.repo === '' ? QUEUE_PROJECT : r.repo,
          grownMib: r.grown,
          minutes: r.minutes,
        }
      }),
      waits: waitFacts(waited, options.shapes ?? new Map()),
      tenants,
    }
  })
}

const isRed = (s: { exit_code: number | null }): boolean => s.exit_code !== null && s.exit_code !== 0

interface FailShare {
  failed: number
  /** the steps counted: every step bar a red `check-fast` */
  counted: number
  rate: number
}

/** The share of steps that exited non-zero, a red `check-fast` left out of both counts (a lead's pre-push fix loop). */
function failShare(steps: readonly z.infer<typeof StepRow>[]): FailShare {
  const counted = steps.filter((s) => !(isRed(s) && tierOf(s.name) === 'fast'))
  const red = counted.filter(isRed).length
  return { failed: red, counted: counted.length, rate: counted.length === 0 ? 0 : red / counted.length }
}

/** How many failing steps a breach names: the rest are a count, so the text stays one short line. */
const FAILURES_NAMED = 8

/** The counted failing steps by name and exit code, most first, so a lead needs no database read; `kept` red check-fast runs are said. */
function failureLines(steps: readonly z.infer<typeof StepRow>[], kept: number): string[] {
  const groups = new Map<string, { name: string; exit: number; count: number }>()
  for (const s of steps) {
    if (!isRed(s) || tierOf(s.name) === 'fast') continue
    const exit = s.exit_code ?? 0
    const key = `${s.name}\n${exit}`
    const group = groups.get(key) ?? { name: s.name, exit, count: 0 }
    group.count++
    groups.set(key, group)
  }
  const ranked = [...groups.values()].toSorted(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name) || a.exit - b.exit,
  )
  const named = ranked.slice(0, FAILURES_NAMED).map((g) => `${g.name} exit ${g.exit} x${g.count}`)
  const rest = ranked.slice(FAILURES_NAMED).reduce((sum, g) => sum + g.count, 0)
  const lines = named.length === 0 ? [] : [`Failing steps: ${named.join('; ')}${rest > 0 ? `; ${rest} more` : ''}.`]
  if (kept > 0) lines.push(`${kept} red check-fast runs are left out of the count: a lead fixes them before it pushes.`)
  return lines
}

const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`
const share = (value: number): string => `${Math.round(value * 1000) / 10}%`

/**
 * Each set budget against the last 24 hours of the project's steps: `fast` the median of the fast-tier runs (at least
 * `MIN_FAST_RUNS` of them), `peak` the largest peak memory of one step, `fail` the share of steps that exited non-zero (at
 * least `MIN_FAIL_RUNS` steps). A budget the day has too few runs to judge is not over, and neither is a median or a share
 * over a window the counting epoch cut under a day: it is one lead's red-green loop, not the project's day (the ranking
 * waits the same way, `MIN_RANK_DAYS`). `peak` is a maximum: a step over it is over in any window.
 *
 * `fail` leaves out a red `check-fast` (lint, tsc and the changed unit tests a lead fixes before it pushes: it never reaches
 * master), and is over only when the share held on the day before as well, judged over a whole day too: a one-day burst or
 * a window that reaches back past the epoch is no breach. The failing steps by name and exit code ride along as context.
 */
export async function readBudgetFacts(
  sql: SQL,
  options: { now: Date; budgets: readonly ProjectBudgets[]; epoch?: Date | null },
): Promise<BudgetFact[]> {
  const from = countedFrom(new Date(options.now.getTime() - DAY_MS), options.epoch ?? null)
  const wholeDay = options.now.getTime() - from.getTime() >= DAY_MS
  const wanted = options.budgets.filter((b) => b.fastMs !== null || b.peakMib !== null || b.failShare !== null)
  if (wanted.length === 0) return []
  const dayAgo = new Date(options.now.getTime() - DAY_MS)
  const before = countedFrom(new Date(dayAgo.getTime() - DAY_MS), options.epoch ?? null)
  const beforeWhole = dayAgo.getTime() - before.getTime() >= DAY_MS
  const wantsFail = wanted.some((b) => b.failShare !== null)
  const { steps, prior } = await boundedRead(sql, 20_000, async (tx) => ({
    steps: await stepRows(tx, from, options.now),
    prior: wantsFail && beforeWhole ? await stepRows(tx, before, dayAgo) : [],
  }))
  const facts: BudgetFact[] = []
  for (const b of wanted) {
    const mine = steps.filter((s) => s.repo === b.project)
    if (b.fastMs !== null) {
      const fast = mine
        .filter((s) => tierOf(s.name) === 'fast')
        .map((s) => s.duration_ms)
        .toSorted((x, y) => x - y)
      const median = percentile(fast, 0.5)
      facts.push({
        project: b.project,
        repo: b.repo,
        budget: 'fast',
        limit: seconds(b.fastMs),
        value: `the median of ${fast.length} fast runs is ${seconds(median)}`,
        over: wholeDay && fast.length >= MIN_FAST_RUNS && median > b.fastMs,
      })
    }
    if (b.peakMib !== null) {
      const peak = Math.max(0, ...mine.map((s) => s.peak ?? 0))
      facts.push({
        project: b.project,
        repo: b.repo,
        budget: 'peak',
        limit: b.peakMib % 1024 === 0 ? `${b.peakMib / 1024}GiB` : `${b.peakMib}MiB`,
        value: `the largest step peaked at ${peak} MiB`,
        over: peak > b.peakMib,
      })
    }
    if (b.failShare !== null) {
      const today = failShare(mine)
      const yesterday = failShare(prior.filter((s) => s.repo === b.project))
      const holds = (day: FailShare): boolean => day.counted >= MIN_FAIL_RUNS && day.rate > (b.failShare ?? 1)
      const kept = mine.filter((s) => isRed(s) && tierOf(s.name) === 'fast').length
      facts.push({
        project: b.project,
        repo: b.repo,
        budget: 'fail',
        limit: share(b.failShare),
        value: `${today.failed} of ${today.counted} steps failed (${share(today.rate)})${
          beforeWhole ? `, the day before ${yesterday.failed} of ${yesterday.counted} (${share(yesterday.rate)})` : ''
        }`,
        over: wholeDay && beforeWhole && holds(today) && holds(yesterday),
        detail: failureLines(mine, kept),
      })
    }
  }
  return facts
}

/** How the Issues ended and when they shipped, by Issue id: what the ledger reads to know a finding's Issue shipped. */
export async function readIssueFates(sql: SQL, ids: readonly string[]): Promise<Map<string, IssueFate>> {
  if (ids.length === 0) return new Map()
  const rows: unknown[] = await boundedRead(
    sql,
    10_000,
    (tx) => tx`
      SELECT i.id, i.state, i.outcome,
        (SELECT max(e.at) FROM factory.issue_events e WHERE e.issue_id = i.id AND e.kind = 'shipped' AND e.result = 'applied') AS shipped_at
      FROM factory.issues i WHERE i.id = ANY(${tx.array([...ids], 'TEXT')})`,
  )
  return new Map(
    rows.map((raw) => {
      const r = z
        .object({
          id: z.string(),
          state: z.string(),
          outcome: z.string().nullable(),
          shipped_at: z.coerce.date().nullable(),
        })
        .parse(raw)
      return [r.id, { state: r.state, outcome: r.outcome, shippedAt: r.shipped_at }]
    }),
  )
}
