import type { SQL } from 'bun'
import * as z from 'zod'
import type { BudgetFact, IssueFate, ProjectBudgets, WindowFacts } from '../domains/loops/throughput.ts'
import {
  BASELINE_DAYS,
  DEFAULT_PEAK_MIB,
  MIN_FAIL_RUNS,
  MIN_FAST_RUNS,
  PROCESS_GROWTH_MIB,
} from '../kernel/throughput-limits.ts'
import { boundedRead } from './bounded.ts'
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
})

const percentile = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) return 0
  const rank = (sorted.length - 1) * p
  const low = Math.floor(rank)
  const high = Math.ceil(rank)
  return (sorted[low] ?? 0) + ((sorted[high] ?? 0) - (sorted[low] ?? 0)) * (rank - low)
}

const stepRows = async (tx: SQL, from: Date, to: Date) =>
  (
    (await tx`
      SELECT ${tx.unsafe(REPO_OF_STEP)} AS repo, name, duration_ms, exit_code, peak_rss_mib AS peak
      FROM factory.step_costs WHERE repo IS NOT NULL AND at >= ${from} AND at < ${to}`) as unknown[]
  ).map((raw) => StepRow.parse(raw))

/**
 * The host over `[from, to)` as the throughput loop ranks it: the raw figures per project from `step_costs`, the closed
 * Issues, the notable processes and the queue intervals. `peakBudgetMib` is a project's `budgets.peak` (the default
 * for a project not in it). With `baseline`, a project's slot-minutes per closed Issue also carries the median of the same
 * ratio per day over the 14 days before `from`. Every figure is SQL over stored rows, bounded so a slow read ends as an
 * error the pass notes.
 */
export async function readWindowFacts(
  sql: SQL,
  options: { from: Date; to: Date; peakBudgetMib: ReadonlyMap<string, number>; baseline: boolean },
): Promise<WindowFacts> {
  const { from, to } = options
  const days = (to.getTime() - from.getTime()) / DAY_MS
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
      const since = new Date(from.getTime() - BASELINE_DAYS * DAY_MS)
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
        FROM slot JOIN done ON done.repo = slot.repo AND done.d = slot.d GROUP BY slot.repo`
      for (const raw of rows) {
        const r = z.object({ repo: z.string(), median: num }).parse(raw)
        baseline.set(r.repo, r.median)
      }
    }

    const grown: unknown[] = await tx`
      SELECT name, class, coalesce(repo, '') AS repo, max(footprint_mib) - min(footprint_mib) AS grown, count(*) AS minutes
      FROM factory.host_process_samples WHERE at >= ${from} AND at < ${to}
      GROUP BY pid, name, class, repo HAVING max(footprint_mib) - min(footprint_mib) >= ${PROCESS_GROWTH_MIB}`
    const queued: unknown[] = await tx`
      SELECT i.repo, sum(extract(epoch FROM (a.at - s.at)) / 60.0)::float8 AS minutes, count(*) AS admissions
      FROM factory.issue_events a
      JOIN factory.issues i ON i.id = a.issue_id
      JOIN LATERAL (
        SELECT x.at FROM factory.issue_events x
        WHERE x.issue_id = a.issue_id AND x.result = 'applied' AND x.kind IN ('filed', 'reopened') AND x.version < a.version
        ORDER BY x.version DESC LIMIT 1) s ON true
      WHERE a.kind = 'admitted' AND a.result = 'applied' AND a.at >= ${from} AND a.at < ${to}
      GROUP BY i.repo`

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
          project: r.repo === '' ? 'software-factory' : r.repo,
          grownMib: r.grown,
          minutes: r.minutes,
        }
      }),
      queued: queued.map((raw) => {
        const r = z.object({ repo: z.string(), minutes: num, admissions: num }).parse(raw)
        return { project: r.repo, minutes: r.minutes, admissions: r.admissions }
      }),
    }
  })
}

const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`
const share = (value: number): string => `${Math.round(value * 1000) / 10}%`

/**
 * Each set budget against the last 24 hours of the project's steps: `fast` the median of the fast-tier runs (at least
 * `MIN_FAST_RUNS` of them), `peak` the largest peak memory of one step, `fail` the share of steps that exited non-zero (at
 * least `MIN_FAIL_RUNS` steps). A budget the day has too few runs to judge is not over.
 */
export async function readBudgetFacts(
  sql: SQL,
  options: { now: Date; budgets: readonly ProjectBudgets[] },
): Promise<BudgetFact[]> {
  const from = new Date(options.now.getTime() - DAY_MS)
  const wanted = options.budgets.filter((b) => b.fastMs !== null || b.peakMib !== null || b.failShare !== null)
  if (wanted.length === 0) return []
  const steps = await boundedRead(sql, 20_000, (tx) => stepRows(tx, from, options.now))
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
        over: fast.length >= MIN_FAST_RUNS && median > b.fastMs,
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
      const failed = mine.filter((s) => s.exit_code !== null && s.exit_code !== 0).length
      const rate = mine.length === 0 ? 0 : failed / mine.length
      facts.push({
        project: b.project,
        repo: b.repo,
        budget: 'fail',
        limit: share(b.failShare),
        value: `${failed} of ${mine.length} steps failed (${share(rate)})`,
        over: mine.length >= MIN_FAIL_RUNS && rate > b.failShare,
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
