const UNIT_KIB: Record<string, number> = { B: 1 / 1024, K: 1, M: 1024, G: 1024 ** 2, T: 1024 ** 3 }

// pid, then ppid (optional), MEM with its unit (and top's growth mark), then TIME (optional)
const LINE = /^\s*(\d+)\s+(?:(\d+)\s+)?(\d+(?:[.,]\d+)?)([BKMGT])[+-]?(?:\s+(\d+:\d{2}(?:[.:]\d{2})?))?\s*$/
const PROCESSES = /^Processes:\s+(\d+)\s+total/
const IDLE = /^CPU usage:.*?(\d+(?:[.,]\d+)?)%\s+idle/

export interface TopRow {
  ppid: number | null
  /** the physical footprint, KiB */
  kib: number
  /** the CPU time used since the process started; null when the column was not asked for */
  cpuMs: number | null
}

export interface TopSnapshot {
  /** the header's process count */
  processes: number | null
  /** the header's CPU idle share, percent */
  cpuIdlePct: number | null
  rows: Map<number, TopRow>
}

/** top's TIME: `minutes:seconds.hundredths`, or `hours:minutes:seconds` for a long-lived process. */
export function parseTopTime(text: string): number | null {
  const short = /^(\d+):(\d{2})\.(\d{2})$/.exec(text)
  if (short) return (Number(short[1]) * 60 + Number(short[2])) * 1000 + Number(short[3]) * 10
  const long = /^(\d+):(\d{2}):(\d{2})$/.exec(text)
  if (long) return (Number(long[1]) * 3600 + Number(long[2]) * 60 + Number(long[3])) * 1000
  return null
}

/**
 * One `top -l 1 -n <count> -stats pid,ppid,mem,time` (or `-stats pid,mem`): the header's process count and CPU idle,
 * and per pid the parent, the physical footprint in KiB and the CPU time. top's MEM column is the kernel's
 * `phys_footprint` (dirty, compressed and swapped pages, shared clean pages left out), printed to three digits in K, M
 * or G. A line that does not parse is skipped; a pid listed twice keeps its first row.
 */
export function parseTop(output: string): TopSnapshot {
  const snapshot: TopSnapshot = { processes: null, cpuIdlePct: null, rows: new Map() }
  for (const line of output.split('\n')) {
    const processes = PROCESSES.exec(line)
    if (processes) snapshot.processes = Number(processes[1])
    const idle = IDLE.exec(line)
    if (idle) snapshot.cpuIdlePct = Number((idle[1] ?? '').replace(',', '.'))
    const match = LINE.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    if (snapshot.rows.has(pid)) continue
    const kib = Number((match[3] ?? '0').replace(',', '.')) * (UNIT_KIB[match[4] ?? 'K'] ?? 1)
    snapshot.rows.set(pid, {
      ppid: match[2] === undefined ? null : Number(match[2]),
      kib: Math.round(kib),
      cpuMs: match[5] === undefined ? null : parseTopTime(match[5]),
    })
  }
  return snapshot
}

/** The physical footprint of every process of a `top` snapshot, in KiB. */
export function parseTopFootprints(output: string): Map<number, number> {
  return new Map([...parseTop(output).rows].map(([pid, row]) => [pid, row.kib]))
}
