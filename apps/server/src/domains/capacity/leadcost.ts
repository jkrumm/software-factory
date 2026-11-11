/** One process of the host's table: its parent, its resident memory in KiB and the directory it works in (null: unknown). */
export interface ProcInfo {
  pid: number
  ppid: number
  rssKib: number
  cwd: string | null
}

/** A lead's worktree as the factory knows it from the attempt. */
export interface WorktreeRef {
  path: string
  repo: string
  issue: number | null
  attempt: number | null
}

export interface LeadCost extends WorktreeRef {
  rssMib: number
  procs: number
}

const inside = (cwd: string, path: string): boolean => cwd === path || cwd.startsWith(`${path}/`)

const trimmed = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path)

/**
 * What each lead's process tree costs. A process belongs to the worktree with the longest path that contains its working
 * directory (on a path boundary: `/a/b` does not contain `/a/bc`); everything started under it follows, whatever its own
 * directory is (a browser a lead launched). A process is counted once, for the first worktree in the list that claims it.
 * A worktree with no process is left out.
 */
export function attribute(procs: readonly ProcInfo[], worktrees: readonly WorktreeRef[]): LeadCost[] {
  const paths = worktrees.map((w) => trimmed(w.path))
  const children = new Map<number, ProcInfo[]>()
  for (const proc of procs) children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), proc])

  const ownerOf = (cwd: string): number => {
    let best = -1
    paths.forEach((path, index) => {
      if (inside(cwd, path) && (best < 0 || path.length > (paths[best]?.length ?? 0))) best = index
    })
    return best
  }
  const roots = new Map<number, ProcInfo[]>()
  for (const proc of procs) {
    if (proc.cwd === null) continue
    const owner = ownerOf(proc.cwd)
    if (owner >= 0) roots.set(owner, [...(roots.get(owner) ?? []), proc])
  }

  const claimed = new Set<number>()
  const costs: LeadCost[] = []
  worktrees.forEach((worktree, index) => {
    let rssKib = 0
    let count = 0
    const stack = [...(roots.get(index) ?? [])]
    while (stack.length > 0) {
      const proc = stack.pop() as ProcInfo
      if (claimed.has(proc.pid)) continue
      claimed.add(proc.pid)
      rssKib += proc.rssKib
      count += 1
      stack.push(...(children.get(proc.pid) ?? []))
    }
    if (count > 0) costs.push({ ...worktree, rssMib: Math.round(rssKib / 1024), procs: count })
  })
  return costs
}

const PEAKS_KEPT = 10
const PEAKS_NEEDED = 3

/**
 * What a new lead is expected to take: the 80th percentile (nearest rank) of the newest ten attempts' peak MiB, newest
 * first as given. Null with fewer than three attempts: a guess from one or two is worse than none.
 */
export function learnedLeadMib(attemptPeaks: readonly number[]): number | null {
  const newest = attemptPeaks.slice(0, PEAKS_KEPT)
  if (newest.length < PEAKS_NEEDED) return null
  const sorted = [...newest].sort((a, b) => a - b)
  return sorted[Math.ceil(0.8 * sorted.length) - 1] ?? null
}

/**
 * The memory the running leads will still take on: what each repo's lead is learned to peak at, less what its tree holds
 * now (a lead with no fresh sample holds 0). A lead of a repo with no learned value adds nothing.
 */
export function leadGrowthMib(running: readonly { learnedMib: number | null; currentMib: number }[]): number {
  return running.reduce((sum, lead) => sum + Math.max(0, (lead.learnedMib ?? 0) - lead.currentMib), 0)
}
