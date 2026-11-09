import type { HostProcess } from '@software-factory/contract'
import type { HostReader } from '../../domains/capacity/ports.ts'
import { parsePs, type PsRow, residentBytes, topProcesses } from './ps.ts'
import { runProcess } from './process.ts'

export interface HostWatchOptions {
  /** the swap and load readings, as admission takes them (`hostReader`) */
  host: HostReader
  /** `sysctl`, for `hw.memsize` */
  sysctlBin: string
  /** `ps`, the macOS one: `-Ao pid=,pcpu=,rss=,comm=` */
  psBin: string
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
}

/**
 * The host as the Live popover shows it: the top processes of one timed `ps` (cached for 10 s, so many readers cost one),
 * and the minute sample (load, memory in use as resident memory over RAM, swap). Every failure is empty or null, never an
 * error: a host that cannot answer is a gap in the chart.
 */
export function hostWatch(options: HostWatchOptions): HostWatch {
  const now = options.now ?? Date.now
  const cacheMs = options.cacheMs ?? 10_000
  const timeoutMs = options.timeoutMs ?? 5_000
  let cached: { at: number; rows: Promise<PsRow[] | null> } | null = null
  let ramBytes: number | null = null

  const run = async (cmd: string[]): Promise<string | null> => {
    try {
      const out = await runProcess(cmd, { timeoutMs })
      return out.timedOut || out.code !== 0 ? null : out.stdout
    } catch {
      return null
    }
  }

  const processes = (): Promise<PsRow[] | null> => {
    if (cached && now() - cached.at < cacheMs) return cached.rows
    const rows = run([options.psBin, '-Ao', 'pid=,pcpu=,rss=,comm=']).then((text) =>
      text === null ? null : parsePs(text),
    )
    cached = { at: now(), rows }
    return rows
  }

  const memsize = async (): Promise<number | null> => {
    if (ramBytes !== null) return ramBytes
    const n = Number((await run([options.sysctlBin, '-n', 'hw.memsize']))?.trim())
    if (!Number.isFinite(n) || n <= 0) return null
    ramBytes = n
    return n
  }

  return {
    async top() {
      const rows = await processes()
      return rows ? topProcesses(rows) : { topByCpu: [], topByMemory: [] }
    },

    async sample(): Promise<HostSampleReading> {
      const [load, memory, rows, ram] = await Promise.all([
        options.host.load().catch(() => null),
        options.host.memory().catch(() => null),
        processes(),
        memsize(),
      ])
      return {
        load: load?.ok ? load.value : null,
        memoryUsedPct: rows && ram ? Math.round((residentBytes(rows) / ram) * 1000) / 10 : null,
        swapUsedPct: memory?.ok ? memory.value.swapUsedPct : null,
        swapoutMbPer300s: memory?.ok ? memory.value.swapoutMbPer300s : null,
      }
    },
  }
}
