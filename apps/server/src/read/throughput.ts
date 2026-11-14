import type { SQL } from 'bun'
import * as z from 'zod'
import type { ThroughputModel } from '@software-factory/contract'
import { boundedRead } from './bounded.ts'

const TOP_KEYS = 20
const TOP_PROCESSES = 15
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

    const seconds = (ms: number | null) => round((ms ?? 0) / 1000, 1)
    const found = new Map(classRows.map((raw) => ClassRow.parse(raw)).map((r) => [r.class, r]))
    const byClass = CLASSES.map((name) => {
      const r = found.get(name)
      const cpuSeconds = seconds(r?.cpu ?? null)
      return {
        class: name,
        footprintMib: mean(r?.fp ?? 0),
        peakMib: r?.peak ?? 0,
        cpuSeconds,
        cores: minutes === 0 ? 0 : round((r?.cpu ?? 0) / 1000 / (minutes * 60), 2),
        procs: mean(r?.procs ?? 0, 1),
      }
    }).sort((a, b) => b.footprintMib - a.footprintMib || a.class.localeCompare(b.class))

    const collectorSeconds = (signals.collector_ms ?? 0) / 1000
    return {
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
    }
  })

  return { at: now.toISOString(), hours, window: { from: from.toISOString(), to: to.toISOString() }, ...body }
}
