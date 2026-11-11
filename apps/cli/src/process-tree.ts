/** One line of `ps -Ao pid=,ppid=,rss=,time=`. */
export interface PsRow {
  pid: number
  ppid: number
  /** resident size in KiB */
  rssKib: number
  cpuSeconds: number
}

/** `[[h:]m]m:ss[.xx]` and `d-hh:mm:ss` as seconds; null for anything else. */
export function parseCpuTime(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text)
  if (!match) return null
  const [, days, hours, minutes, seconds] = match
  return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)
}

/** The rows of a `ps` listing; a line that does not parse is skipped. */
export function parsePsTree(text: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of text.split('\n')) {
    const [pid, ppid, rss, time] = line.trim().split(/\s+/)
    if (pid === undefined || ppid === undefined || rss === undefined || time === undefined) continue
    const cpuSeconds = parseCpuTime(time)
    const row = { pid: Number(pid), ppid: Number(ppid), rssKib: Number(rss), cpuSeconds }
    if (cpuSeconds === null || ![row.pid, row.ppid, row.rssKib].every(Number.isInteger)) continue
    rows.push({ ...row, cpuSeconds })
  }
  return rows
}

/** The root and all its descendants (by ppid). */
export function treeOf(rows: readonly PsRow[], root: number): PsRow[] {
  const children = new Map<number, PsRow[]>()
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row])
  const found: PsRow[] = []
  const seen = new Set<number>()
  const queue = [root]
  while (queue.length > 0) {
    const pid = queue.shift() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    const own = rows.find((row) => row.pid === pid)
    if (own) found.push(own)
    for (const child of children.get(pid) ?? []) queue.push(child.pid)
  }
  return found
}

/** Follows one command's process tree across samples: its resident size now and at the peak, and the CPU it used. */
export function treeMeter(root: number) {
  let peakKib = 0
  let nowKib = 0
  /** the largest cputime seen per pid: a process that ended keeps what it used */
  const cpu = new Map<number, number>()
  return {
    sample(rows: readonly PsRow[]): void {
      const tree = treeOf(rows, root)
      nowKib = tree.reduce((sum, row) => sum + row.rssKib, 0)
      peakKib = Math.max(peakKib, nowKib)
      for (const row of tree) cpu.set(row.pid, Math.max(cpu.get(row.pid) ?? 0, row.cpuSeconds))
    },
    /** null until a sample saw the tree */
    get rssMib(): number | null {
      return cpu.size === 0 ? null : Math.round(nowKib / 1024)
    },
    get peakRssMib(): number | null {
      return cpu.size === 0 ? null : Math.round(peakKib / 1024)
    },
    get cpuSeconds(): number | null {
      return cpu.size === 0 ? null : Math.round([...cpu.values()].reduce((a, b) => a + b, 0) * 100) / 100
    },
  }
}

/** One timed `ps`; null when it failed. */
export async function readProcesses(timeoutMs = 3000): Promise<PsRow[] | null> {
  try {
    const proc = Bun.spawn(['/bin/ps', '-Ao', 'pid=,ppid=,rss=,time='], {
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
    })
    const timer = setTimeout(() => proc.kill(), timeoutMs)
    try {
      const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      return code === 0 ? parsePsTree(text) : null
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null
  }
}
