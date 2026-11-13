import type { ProcInfo } from '../../domains/capacity/leadcost.ts'
import { runProcess, type TextRunner } from './process.ts'
import type { PsRow } from './ps.ts'

/** The working directories of `lsof -nP -a -d cwd -Fpn`: a `p<pid>` line, then the `n<path>` of that process. */
export function parseLsofCwd(output: string): Map<number, string> {
  const cwds = new Map<number, string>()
  let pid: number | null = null
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      const n = Number(line.slice(1))
      pid = Number.isInteger(n) && n > 0 ? n : null
    } else if (line.startsWith('n') && pid !== null && line.length > 1) {
      cwds.set(pid, line.slice(1))
    }
  }
  return cwds
}

/** The process table joined with each process's directory and, when `top` could be read, its physical footprint (null for a process top did not list). */
export const joinProcesses = (
  rows: readonly PsRow[],
  cwds: ReadonlyMap<number, string>,
  footprints: ReadonlyMap<number, number> | null = null,
): ProcInfo[] =>
  rows.map((row) => ({
    pid: row.pid,
    ppid: row.ppid,
    rssKib: row.rssKib,
    footprintKib: footprints?.get(row.pid) ?? null,
    cwd: cwds.get(row.pid) ?? null,
  }))

/** The working directory of every process `lsof` can see; null when it timed out or failed outright. */
export async function readCwds(lsofBin: string, timeoutMs: number): Promise<Map<number, string> | null> {
  try {
    const out = await runProcess([lsofBin, '-nP', '-a', '-d', 'cwd', '-Fpn'], { timeoutMs })
    // lsof exits 1 when it could not look at some process but still lists the rest
    if (out.timedOut || (out.code !== 0 && out.stdout.trim() === '')) return null
    return parseLsofCwd(out.stdout)
  } catch {
    return null
  }
}

/**
 * `readCwds` through a metered runner, shared for `cacheMs`: the lead costs and the class snapshot of one host pass read
 * one `lsof`.
 */
export function cachedCwds(options: {
  runner: TextRunner
  lsofBin: string
  timeoutMs?: number
  cacheMs?: number
  now?: () => number
}): () => Promise<Map<number, string> | null> {
  const now = options.now ?? Date.now
  let cached: { at: number; cwds: Promise<Map<number, string> | null> } | null = null
  return () => {
    if (cached && now() - cached.at < (options.cacheMs ?? 10_000)) return cached.cwds
    const cwds = options.runner
      .run([options.lsofBin, '-nP', '-a', '-d', 'cwd', '-Fpn'], {
        timeoutMs: options.timeoutMs ?? 10_000,
        partial: true,
      })
      .then((text) => (text === null ? null : parseLsofCwd(text)))
    cached = { at: now(), cwds }
    return cwds
  }
}

export interface ProcessTableOptions {
  /** the rows of the host's one `ps` (cached by `hostWatch`: no second `ps` per tick) */
  rows: () => Promise<PsRow[] | null>
  /** the physical footprint of every process in KiB; null (or not given) leaves every footprint unknown */
  footprints?: () => Promise<ReadonlyMap<number, number> | null>
  lsofBin: string
  /** the directories, when another reader shares them (`cachedCwds`); else one `lsof` of its own */
  cwds?: () => Promise<Map<number, string> | null>
  timeoutMs?: number
}

export interface ProcessTable {
  /** null when `ps` or `lsof` could not answer; never an error */
  read(): Promise<ProcInfo[] | null>
}

export function processTable(options: ProcessTableOptions): ProcessTable {
  const timeoutMs = options.timeoutMs ?? 10_000

  return {
    async read() {
      const rows = await options.rows()
      if (rows === null) return null
      const [cwds, footprints] = await Promise.all([
        options.cwds ? options.cwds() : readCwds(options.lsofBin, timeoutMs),
        options.footprints ? options.footprints().catch(() => null) : null,
      ])
      return cwds === null ? null : joinProcesses(rows, cwds, footprints)
    },
  }
}
