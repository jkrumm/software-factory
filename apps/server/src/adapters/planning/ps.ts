import type { HostProcess } from '@software-factory/contract'
import { basename } from 'node:path'

/** One process of `ps -Ao pid=,pcpu=,rss=,comm=` before the lists are cut: rss in KiB. */
export interface PsRow {
  pid: number
  command: string
  cpuPct: number
  rssKib: number
}

const LINE = /^\s*(\d+)\s+(\d+(?:[.,]\d+)?)\s+(\d+)\s+(\S.*?)\s*$/

/** The rows of `ps -Ao pid=,pcpu=,rss=,comm=`; a line that does not parse is skipped. `command` is the executable's basename (the name may hold spaces). */
export function parsePs(output: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of output.split('\n')) {
    const match = LINE.exec(line)
    if (!match) continue
    const command = basename(match[4] ?? '')
    if (command === '') continue
    rows.push({
      pid: Number(match[1]),
      cpuPct: Number((match[2] ?? '0').replace(',', '.')),
      rssKib: Number(match[3]),
      command,
    })
  }
  return rows
}

const asProcess = (row: PsRow): HostProcess => ({
  pid: row.pid,
  command: row.command,
  cpuPct: Math.round(row.cpuPct * 10) / 10,
  memoryMb: Math.round((row.rssKib / 1024) * 10) / 10,
})

/** The busiest `count` processes by cpu and by resident memory (ties by pid, so the lists are stable). */
export function topProcesses(
  rows: readonly PsRow[],
  count = 8,
): { topByCpu: HostProcess[]; topByMemory: HostProcess[] } {
  const top = (key: 'cpuPct' | 'rssKib') =>
    [...rows]
      .sort((a, b) => b[key] - a[key] || a.pid - b.pid)
      .slice(0, count)
      .map(asProcess)
  return { topByCpu: top('cpuPct'), topByMemory: top('rssKib') }
}

/** Resident memory of every process in bytes. */
export const residentBytes = (rows: readonly PsRow[]): number => rows.reduce((sum, row) => sum + row.rssKib * 1024, 0)
