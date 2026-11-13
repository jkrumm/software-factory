import type { HostProcess } from '@software-factory/contract'
import type { HostReader } from '../../domains/capacity/ports.ts'
import { parsePs, type PsRow, topProcesses } from './ps.ts'
import { parseTop, type TopSnapshot } from './top.ts'
import { memoryUsedPct } from './vm-memory.ts'
import { type TextRunner, textRunner } from './process.ts'

export interface HostWatchOptions {
  /** the swap and load readings, as admission takes them (`hostReader`) */
  host: HostReader
  /** `sysctl`, for `hw.memsize` and the page counts */
  sysctlBin: string
  /** `ps`, the macOS one: `-Ao pid=,ppid=,pcpu=,rss=,comm=` */
  psBin: string
  /** `top`, the macOS one, for each process's physical footprint; without it every footprint is unknown */
  topBin?: string
  /** `vm_stat`, for the wired and compressor pages (default `/usr/bin/vm_stat`) */
  vmStatBin?: string
  /** runs the helpers and counts their CPU (the host loop's collector cost); a fresh one when absent */
  runner?: TextRunner
  /** concurrent readers within this long share one `ps` */
  cacheMs?: number
  timeoutMs?: number
  now?: () => number
}

/** One minute sample; the host loop's `HostSampler` port takes it as it is. */
export interface HostSampleReading {
  load: number | null
  memoryUsedPct: number | null
  swapUsedPct: number | null
  swapoutMbPer300s: number | null
}

export interface HostWatch {
  sample(): Promise<HostSampleReading>
  top(): Promise<{ topByCpu: HostProcess[]; topByMemory: HostProcess[] }>
  /** the same cached `ps` rows; null when `ps` failed */
  rows(): Promise<PsRow[] | null>
  /** the physical footprint in KiB of every process, from one `top` snapshot cached like the rows; null when `top` failed or is not configured */
  footprints(): Promise<Map<number, number> | null>
  /** that `top` snapshot: per pid the parent, footprint and CPU time, and the header's process count and CPU idle */
  topSnapshot(): Promise<TopSnapshot | null>
}

/**
 * The host as the Live popover shows it: the top processes of one timed `ps` (cached for 10 s, so many readers cost one),
 * and the minute sample (load, memory in use as the kernel's app, wired and compressed memory over RAM, swap). Every failure is empty or null, never an
 * error: a host that cannot answer is a gap in the chart.
 */
export function hostWatch(options: HostWatchOptions): HostWatch {
  const now = options.now ?? Date.now
  const cacheMs = options.cacheMs ?? 10_000
  const timeoutMs = options.timeoutMs ?? 5_000
  let cached: { at: number; rows: Promise<PsRow[] | null> } | null = null
  let ramBytes: number | null = null
  const runner = options.runner ?? textRunner(timeoutMs)
  const run = (cmd: string[]): Promise<string | null> => runner.run(cmd)

  const processes = (): Promise<PsRow[] | null> => {
    if (cached && now() - cached.at < cacheMs) return cached.rows
    const rows = run([options.psBin, '-Ao', 'pid=,ppid=,pcpu=,rss=,comm=']).then((text) =>
      text === null ? null : parsePs(text),
    )
    cached = { at: now(), rows }
    return rows
  }

  let cachedTop: { at: number; snapshot: Promise<TopSnapshot | null> } | null = null
  const topSnapshot = (): Promise<TopSnapshot | null> => {
    const topBin = options.topBin
    if (topBin === undefined) return Promise.resolve(null)
    if (cachedTop && now() - cachedTop.at < cacheMs) return cachedTop.snapshot
    const found = run([topBin, '-l', '1', '-n', '5000', '-stats', 'pid,ppid,mem,time']).then((text) => {
      const parsed = text === null ? null : parseTop(text)
      return parsed === null || parsed.rows.size === 0 ? null : parsed
    })
    cachedTop = { at: now(), snapshot: found }
    return found
  }
  const footprints = async (): Promise<Map<number, number> | null> => {
    const snapshot = await topSnapshot()
    return snapshot === null ? null : new Map([...snapshot.rows].map(([pid, row]) => [pid, row.kib]))
  }

  const memsize = async (): Promise<number | null> => {
    if (ramBytes !== null) return ramBytes
    const n = Number((await run([options.sysctlBin, '-n', 'hw.memsize']))?.trim())
    if (!Number.isFinite(n) || n <= 0) return null
    ramBytes = n
    return n
  }

  const memoryUsed = async (): Promise<number | null> => {
    const [ram, counts, vmStat] = await Promise.all([
      memsize(),
      run([options.sysctlBin, '-n', 'vm.page_pageable_internal_count', 'vm.page_purgeable_count', 'hw.pagesize']),
      run([options.vmStatBin ?? '/usr/bin/vm_stat']),
    ])
    return ram && counts !== null && vmStat !== null ? memoryUsedPct(counts, vmStat, ram) : null
  }

  return {
    rows: processes,
    footprints,
    topSnapshot,

    async top() {
      const rows = await processes()
      return rows ? topProcesses(rows) : { topByCpu: [], topByMemory: [] }
    },

    async sample(): Promise<HostSampleReading> {
      const [load, memory, used] = await Promise.all([
        options.host.load().catch(() => null),
        options.host.memory().catch(() => null),
        memoryUsed(),
      ])
      return {
        load: load?.ok ? load.value : null,
        memoryUsedPct: used,
        swapUsedPct: memory?.ok ? memory.value.swapUsedPct : null,
        swapoutMbPer300s: memory?.ok ? memory.value.swapoutMbPer300s : null,
      }
    },
  }
}
