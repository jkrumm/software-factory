/**
 * One process of the host's table: its parent, its resident memory in KiB, its physical footprint in KiB (null: `top`
 * did not list it) and the directory it works in (null: unknown).
 */
export interface ProcInfo {
  pid: number
  ppid: number
  rssKib: number
  footprintKib: number | null
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
  /** the summed resident memory: shared pages are counted once per process */
  rssMib: number
  /**
   * The summed physical footprint, which leaves shared clean pages out; a process `top` did not list counts at its
   * resident size. Null when no process of the tree had a footprint (`top` failed): then only RSS is known.
   */
  footprintMib: number | null
  procs: number
}

const inside = (cwd: string, path: string): boolean => cwd === path || cwd.startsWith(`${path}/`)

const trimmed = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path)

/**
 * Which worktree (its index in the list) each process belongs to: the worktree with the longest path that contains the
 * process's working directory (on a path boundary: `/a/b` does not contain `/a/bc`), and everything started under such a
 * process, whatever its own directory is (a browser a lead launched). A process is claimed once, by the first worktree in
 * the list whose tree reaches it. A process no worktree claims is not in the map.
 */
export function worktreeOwners(
  procs: readonly { pid: number; ppid: number; cwd: string | null }[],
  worktrees: readonly { path: string }[],
): Map<number, number> {
  const paths = worktrees.map((w) => trimmed(w.path))
  const children = new Map<number, number[]>()
  for (const proc of procs) children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), proc.pid])

  const ownerOf = (cwd: string): number => {
    let best = -1
    paths.forEach((path, index) => {
      if (inside(cwd, path) && (best < 0 || path.length > (paths[best]?.length ?? 0))) best = index
    })
    return best
  }
  const roots = new Map<number, number[]>()
  for (const proc of procs) {
    if (proc.cwd === null) continue
    const owner = ownerOf(proc.cwd)
    if (owner >= 0) roots.set(owner, [...(roots.get(owner) ?? []), proc.pid])
  }

  const owners = new Map<number, number>()
  worktrees.forEach((_, index) => {
    const stack = [...(roots.get(index) ?? [])]
    while (stack.length > 0) {
      const pid = stack.pop() as number
      if (owners.has(pid)) continue
      owners.set(pid, index)
      stack.push(...(children.get(pid) ?? []))
    }
  })
  return owners
}

/**
 * What each lead's process tree costs. A process belongs to the worktree with the longest path that contains its working
 * directory (on a path boundary: `/a/b` does not contain `/a/bc`); everything started under it follows, whatever its own
 * directory is (a browser a lead launched). A process is counted once, for the first worktree in the list that claims it.
 * A worktree with no process is left out. Each tree is summed twice, as resident memory and as physical footprint.
 */
export function attribute(procs: readonly ProcInfo[], worktrees: readonly WorktreeRef[]): LeadCost[] {
  const owners = worktreeOwners(procs, worktrees)
  const costs: LeadCost[] = []
  worktrees.forEach((worktree, index) => {
    let rssKib = 0
    let footprintKib = 0
    let measured = 0
    let count = 0
    for (const proc of procs) {
      if (owners.get(proc.pid) !== index) continue
      rssKib += proc.rssKib
      footprintKib += proc.footprintKib ?? proc.rssKib
      if (proc.footprintKib !== null) measured += 1
      count += 1
    }
    if (count > 0) {
      costs.push({
        ...worktree,
        rssMib: Math.round(rssKib / 1024),
        footprintMib: measured > 0 ? Math.round(footprintKib / 1024) : null,
        procs: count,
      })
    }
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
