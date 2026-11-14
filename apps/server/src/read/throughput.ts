import type { SQL } from 'bun'
import * as z from 'zod'
import type { ThroughputModel } from '@software-factory/contract'
import { boundedRead } from './bounded.ts'
import { readAccount } from './throughput-account.ts'

const TOP_KEYS = 20
const TOP_PROCESSES = 15
const TOP_FLAKY = 20
const TOP_FINDINGS = 50
const CLASSES = ['lead', 'step', 'tenant', 'factory', 'system', 'owner', 'other'] as const

const num = z.coerce.number()
const nullNum = z.coerce.number().nullable()

const Signals = z.object({
  normal: num,
  warning: num,
  critical: num,
  unread: num,
  load_p50: nullNum,
  load_max: nullNum,
  idle_p50: nullNum,
  idle_min: nullNum,
  compressor_p50: nullNum,
  compressor_max: nullNum,
  swap_p50: nullNum,
  swap_max: nullNum,
  processes_p50: nullNum,
  processes_max: nullNum,
  vm_min: nullNum,
  vm_last: nullNum,
  collector_minutes: num,
  collector_ms: nullNum,
})
const ClassRow = z.object({ class: z.string(), fp: num, peak: num, cpu: nullNum, procs: num })
const RepoRow = z.object({ repo: z.string(), fp: num, peak: num, cpu: nullNum, lead: num, step: num })
const TenantRow = z.object({ tenant: z.string(), fp: num, peak: num, cpu: nullNum })
const ProcessRow = z.object({
  name: z.string(),
  class: z.string(),
  repo: z.string().nullable(),
  tenant: z.string().nullable(),
  peak: num,
  cpu: nullNum,
  minutes: num,
  grown: nullNum,
})

const RunRow = z.object({
  repo: z.string(),
  runs: num,
  failed_runs: num,
  run_ms: num,
  failed_ms: num,
  results: num,
  flaky_tests: num,
  pairs: num,
  flaky_pairs: num,
})
const FlakyRow = z.object({
  repo: z.string(),
  suite: z.string(),
  name: z.string(),
  flaky_commits: num,
  runs: num,
  failures: num,
  first_flake: z.coerce.date(),
  last_flake: z.coerce.date(),
})

const TimelineRow = z.object({ at: z.coerce.date(), level: z.coerce.number().nullable(), swap: nullNum, load: nullNum })
const FindingRow = z.object({
  id: z.string(),
  project: z.string(),
  kpi: z.string(),
  subject: z.string(),
  before: num,
  target: num,
  after: nullNum,
  direction: z.enum(['up', 'down']),
  unit: z.string(),
  cost_minutes: num,
  status: z.string(),
  issue_id: z.string().nullable(),
  filed_at: z.coerce.date(),
  shipped_at: z.coerce.date().nullable(),
  after_at: z.coerce.date().nullable(),
})

/** The timeline's bucket: 5 minutes up to a day, 15 up to three days, else an hour. */
export const bucketMinutesOf = (hours: number): number => (hours <= 24 ? 5 : hours <= 72 ? 15 : 60)

const round = (value: number, decimals: number) => Math.round(value * 10 ** decimals) / 10 ** decimals

/**
 * Where the host's memory and CPU went over the last `hours` hours, over the window `[now - hours, now)`: sums and peaks
 * come from SQL over the per-minute class rows, the means divide by the window's snapshot minutes here. A key's
 * per-minute total is the sum of its rows at that minute, so a minute the key is absent counts 0 in its mean. The test
 * restates every figure in plain SQL over seeded rows.
 */
export async function readThroughput(sql: SQL, options: { now: Date; hours: number }): Promise<ThroughputModel> {
  const { now, hours } = options
  const from = new Date(now.getTime() - hours * 3_600_000)
  const to = now

  const body = await boundedRead(sql, 10_000, async (tx) => {
    const [minutesRow] = await tx`
      SELECT count(DISTINCT at) AS n FROM factory.host_class_samples WHERE at >= ${from} AND at < ${to}`
    const minutes = num.parse(minutesRow?.n)
    const mean = (sum: number, decimals = 0) => (minutes === 0 ? 0 : round(sum / minutes, decimals))

    const [signalsRow] = await tx`
      SELECT
        count(*) FILTER (WHERE pressure_level = 1) AS normal,
        count(*) FILTER (WHERE pressure_level = 2) AS warning,
        count(*) FILTER (WHERE pressure_level = 4) AS critical,
        count(*) FILTER (WHERE pressure_level IS NULL) AS unread,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY load)::float8 AS load_p50, max(load)::float8 AS load_max,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY cpu_idle_pct)::float8 AS idle_p50, min(cpu_idle_pct)::float8 AS idle_min,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY compressor_mib)::float8 AS compressor_p50, max(compressor_mib)::float8 AS compressor_max,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY swap_used_pct)::float8 AS swap_p50, max(swap_used_pct)::float8 AS swap_max,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY processes)::float8 AS processes_p50, max(processes)::float8 AS processes_max,
        min(vm_free_gib)::float8 AS vm_min,
        (array_agg(vm_free_gib ORDER BY at DESC) FILTER (WHERE vm_free_gib IS NOT NULL))[1]::float8 AS vm_last,
        count(collector_cpu_ms) AS collector_minutes, sum(collector_cpu_ms) AS collector_ms
      FROM factory.host_samples WHERE at >= ${from} AND at < ${to}`
    const signals = Signals.parse(signalsRow)

    const classRows: unknown[] = await tx`
      WITH m AS (
        SELECT at, class, sum(footprint_mib) AS fp, sum(cpu_ms) AS cpu, sum(procs) AS procs
        FROM factory.host_class_samples WHERE at >= ${from} AND at < ${to} GROUP BY at, class)
      SELECT class, sum(fp) AS fp, max(fp) AS peak, sum(cpu) AS cpu, sum(procs) AS procs FROM m GROUP BY class`
    const repoRows: unknown[] = await tx`
      WITH m AS (
        SELECT at, repo, sum(footprint_mib) AS fp, sum(cpu_ms) AS cpu,
          sum(footprint_mib) FILTER (WHERE class = 'lead') AS lead, sum(footprint_mib) FILTER (WHERE class = 'step') AS step
        FROM factory.host_class_samples
        WHERE class IN ('lead', 'step') AND repo IS NOT NULL AND at >= ${from} AND at < ${to} GROUP BY at, repo)
      SELECT repo, sum(fp) AS fp, max(fp) AS peak, sum(cpu) AS cpu, coalesce(sum(lead), 0) AS lead, coalesce(sum(step), 0) AS step
      FROM m GROUP BY repo ORDER BY sum(fp) DESC, repo LIMIT ${TOP_KEYS}`
    const tenantRows: unknown[] = await tx`
      WITH m AS (
        SELECT at, tenant, sum(footprint_mib) AS fp, sum(cpu_ms) AS cpu
        FROM factory.host_class_samples
        WHERE class = 'tenant' AND tenant IS NOT NULL AND at >= ${from} AND at < ${to} GROUP BY at, tenant)
      SELECT tenant, sum(fp) AS fp, max(fp) AS peak, sum(cpu) AS cpu
      FROM m GROUP BY tenant ORDER BY sum(fp) DESC, tenant LIMIT ${TOP_KEYS}`
    const processRows: unknown[] = await tx`
      SELECT name, class, repo, tenant, max(footprint_mib) AS peak, sum(cpu_ms) AS cpu, count(*) AS minutes,
        max(grown_mib) AS grown
      FROM factory.host_process_samples WHERE at >= ${from} AND at < ${to}
      GROUP BY name, class, repo, tenant
      ORDER BY max(footprint_mib) DESC, name, class, repo NULLS FIRST, tenant NULLS FIRST LIMIT ${TOP_PROCESSES}`

    // Runs are `step_costs` rows by their end (`at`). A test per run is one result: failed when any of its results failed.
    // A (test, commit) pair is flaky when clean-tree runs of that commit have both a pass and a fail; it was first seen
    // flaky when the later of its first pass and first fail came in.
    const runRows: unknown[] = await tx`
      WITH runs AS (
        SELECT repo, count(*) AS runs, count(*) FILTER (WHERE exit_code IS NOT NULL AND exit_code <> 0) AS failed_runs,
          sum(duration_ms) AS run_ms,
          coalesce(sum(duration_ms) FILTER (WHERE exit_code IS NOT NULL AND exit_code <> 0), 0) AS failed_ms
        FROM factory.step_costs WHERE repo IS NOT NULL AND at >= ${from} AND at < ${to} GROUP BY repo),
      results AS (
        SELECT repo, count(*) AS results FROM factory.test_results
        WHERE repo IS NOT NULL AND at >= ${from} AND at < ${to} GROUP BY repo),
      per_run AS (
        SELECT repo, test_suite_name AS suite, test_case_name AS name, vcs_ref_head_revision AS rev, step_cost_id,
          min(at) AS at, bool_or(test_case_result_status = 'fail') AS failed
        FROM factory.test_results
        WHERE repo IS NOT NULL AND vcs_ref_head_revision IS NOT NULL AND dirty = false
          AND test_case_result_status IN ('pass', 'fail') AND at >= ${from} AND at < ${to}
        GROUP BY repo, suite, name, rev, step_cost_id),
      per_pair AS (
        SELECT repo, suite, name, rev, count(*) AS runs, bool_or(failed) AS has_fail, bool_or(NOT failed) AS has_pass
        FROM per_run GROUP BY repo, suite, name, rev),
      pairs AS (
        SELECT repo, count(*) FILTER (WHERE runs >= 2) AS pairs,
          count(*) FILTER (WHERE has_fail AND has_pass) AS flaky_pairs,
          count(DISTINCT (suite, name)) FILTER (WHERE has_fail AND has_pass) AS flaky_tests
        FROM per_pair GROUP BY repo)
      SELECT runs.repo, runs.runs, runs.failed_runs, runs.run_ms, runs.failed_ms,
        coalesce(results.results, 0) AS results, coalesce(pairs.flaky_tests, 0) AS flaky_tests,
        coalesce(pairs.pairs, 0) AS pairs, coalesce(pairs.flaky_pairs, 0) AS flaky_pairs
      FROM runs LEFT JOIN results USING (repo) LEFT JOIN pairs USING (repo)
      ORDER BY runs.repo`
    const flakyRows: unknown[] = await tx`
      WITH per_run AS (
        SELECT repo, test_suite_name AS suite, test_case_name AS name, vcs_ref_head_revision AS rev, step_cost_id,
          min(at) AS at, bool_or(test_case_result_status = 'fail') AS failed
        FROM factory.test_results
        WHERE repo IS NOT NULL AND vcs_ref_head_revision IS NOT NULL AND dirty = false
          AND test_case_result_status IN ('pass', 'fail') AND at >= ${from} AND at < ${to}
        GROUP BY repo, suite, name, rev, step_cost_id),
      per_pair AS (
        SELECT repo, suite, name, rev, count(*) AS runs, count(*) FILTER (WHERE failed) AS failures,
          greatest(min(at) FILTER (WHERE failed), min(at) FILTER (WHERE NOT failed)) AS flaked_at
        FROM per_run GROUP BY repo, suite, name, rev
        HAVING bool_or(failed) AND bool_or(NOT failed))
      SELECT repo, suite, name, count(*) AS flaky_commits, sum(runs) AS runs, sum(failures) AS failures,
        min(flaked_at) AS first_flake, max(flaked_at) AS last_flake
      FROM per_pair GROUP BY repo, suite, name
      ORDER BY count(*) DESC, max(flaked_at) DESC, repo, suite, name LIMIT ${TOP_FLAKY}`

    const bucketMinutes = bucketMinutesOf(hours)
    const bucketSeconds = bucketMinutes * 60
    const timelineRows: unknown[] = await tx`
      SELECT to_timestamp(floor(extract(epoch FROM at) / ${bucketSeconds}::int) * ${bucketSeconds}::int) AS at,
        max(pressure_level) AS level, max(swap_used_pct)::float8 AS swap, max(load)::float8 AS load
      FROM factory.host_samples WHERE at >= ${from} AND at < ${to} GROUP BY 1 ORDER BY 1`
    const findingRows: unknown[] = await tx`
      SELECT id, project, kpi, subject, before, target, after, direction, unit, cost_minutes, status, issue_id, filed_at,
        shipped_at, after_at
      FROM factory.throughput_findings ORDER BY filed_at DESC, id LIMIT ${TOP_FINDINGS}`

    const seconds = (ms: number | null) => round((ms ?? 0) / 1000, 1)
    const found = new Map(classRows.map((raw) => ClassRow.parse(raw)).map((r) => [r.class, r]))
    const classTotal = [...found.values()].reduce((sum, r) => sum + r.fp, 0)
    const byClass = CLASSES.map((name) => {
      const r = found.get(name)
      const cpuSeconds = seconds(r?.cpu ?? null)
      return {
        share: classTotal === 0 ? 0 : round((r?.fp ?? 0) / classTotal, 4),
        class: name,
        footprintMib: mean(r?.fp ?? 0),
        peakMib: r?.peak ?? 0,
        cpuSeconds,
        cores: minutes === 0 ? 0 : round((r?.cpu ?? 0) / 1000 / (minutes * 60), 2),
        procs: mean(r?.procs ?? 0, 1),
      }
    }).sort((a, b) => b.footprintMib - a.footprintMib || a.class.localeCompare(b.class))

    const collectorSeconds = (signals.collector_ms ?? 0) / 1000
    const account = await readAccount(tx, from, to)
    return {
      ...account,
      host: {
        minutes,
        signals: {
          pressureMinutes: {
            normal: signals.normal,
            warning: signals.warning,
            critical: signals.critical,
            unread: signals.unread,
          },
          load: { p50: signals.load_p50, max: signals.load_max },
          cpuIdlePct: { p50: signals.idle_p50, min: signals.idle_min },
          compressorMib: { p50: signals.compressor_p50, max: signals.compressor_max },
          swapUsedPct: { p50: signals.swap_p50, max: signals.swap_max },
          processes: { p50: signals.processes_p50, max: signals.processes_max },
          vmFreeGib: { min: signals.vm_min, last: signals.vm_last },
        },
        collector: {
          minutes: signals.collector_minutes,
          cpuSeconds: collectorSeconds,
          coreShare: signals.collector_minutes === 0 ? null : collectorSeconds / (signals.collector_minutes * 60),
        },
        byClass,
        byRepo: repoRows.map((raw) => {
          const r = RepoRow.parse(raw)
          return {
            repo: r.repo,
            footprintMib: mean(r.fp),
            peakMib: r.peak,
            cpuSeconds: seconds(r.cpu),
            leadMib: mean(r.lead),
            stepMib: mean(r.step),
          }
        }),
        byTenant: tenantRows.map((raw) => {
          const r = TenantRow.parse(raw)
          return { tenant: r.tenant, footprintMib: mean(r.fp), peakMib: r.peak, cpuSeconds: seconds(r.cpu) }
        }),
        timeline: {
          bucketMinutes,
          points: timelineRows.map((raw) => {
            const r = TimelineRow.parse(raw)
            return { at: r.at.toISOString(), pressureLevel: r.level, swapUsedPct: r.swap, load: r.load }
          }),
        },
        topProcesses: processRows.map((raw) => {
          const r = ProcessRow.parse(raw)
          return {
            name: r.name,
            class: r.class,
            repo: r.repo,
            tenant: r.tenant,
            peakMib: r.peak,
            cpuSeconds: seconds(r.cpu),
            minutes: r.minutes,
            grownMib: r.grown,
          }
        }),
      },
      improvements: findingRows.map((raw) => {
        const r = FindingRow.parse(raw)
        return {
          id: r.id,
          project: r.project,
          kpi: r.kpi,
          subject: r.subject,
          before: r.before,
          target: r.target,
          after: r.after,
          direction: r.direction,
          unit: r.unit,
          costMinutes: r.cost_minutes,
          status: r.status,
          issue: r.issue_id,
          filedAt: r.filed_at.toISOString(),
          shippedAt: r.shipped_at?.toISOString() ?? null,
          afterAt: r.after_at?.toISOString() ?? null,
        }
      }),
      tests: {
        byProject: runRows.map((raw) => {
          const r = RunRow.parse(raw)
          return {
            repo: r.repo,
            runs: r.runs,
            failedRuns: r.failed_runs,
            runMinutes: round(r.run_ms / 60_000, 1),
            failedRunMinutes: round(r.failed_ms / 60_000, 1),
            testResults: r.results,
            flakyTests: r.flaky_tests,
            flakeRate: r.pairs === 0 ? null : round(r.flaky_pairs / r.pairs, 4),
          }
        }),
        flaky: flakyRows.map((raw) => {
          const r = FlakyRow.parse(raw)
          return {
            repo: r.repo,
            suite: r.suite,
            name: r.name,
            flakyCommits: r.flaky_commits,
            runs: r.runs,
            failures: r.failures,
            firstFlakeAt: r.first_flake.toISOString(),
            lastFlakeAt: r.last_flake.toISOString(),
          }
        }),
      },
    }
  })

  return { at: now.toISOString(), hours, window: { from: from.toISOString(), to: to.toISOString() }, ...body }
}
