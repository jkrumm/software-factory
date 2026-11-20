/** One process of the host as the reaper reads it: only the session the lead's terminal gave it, never its command line. */
export interface ReaperProc {
  pid: number
  ppid: number
  /** seconds since it started */
  ageS: number
  /** the executable's basename */
  comm: string
  /** the `FACTORY_SESSION` of its environment when it is a lead's (`lead-<issue>-<attempt>`) */
  session: string | null
  cwd: string | null
}

/**
 * An attempt as the reaper knows it. `closedAt` is when the attempt's finalization was done (`lead_finalizations.done_at`:
 * the claim released, the terminals closed, the transcripts archived and the worktree removed or kept). It is null while
 * the attempt can still need its worktree: a lead that is merely `gone_at` and not yet finalized is NOT closed.
 */
export interface ReaperAttempt {
  session: string
  worktree: string | null
  closedAt: Date | null
  /** the finalization kept the worktree (unmerged or uncommitted work): the owner may work in it, so a path never marks a leak */
  kept: boolean
}

export interface Leak {
  pid: number
  ppid: number
  ageS: number
  comm: string
  /** the closed attempt the process belonged to */
  session: string
  worktree: string | null
  reason: 'session' | 'worktree'
}

export interface ReapingInput {
  procs: readonly ReaperProc[]
  attempts: readonly ReaperAttempt[]
  now: Date
  graceMs: number
  /** pids never touched, with their ancestors: pid 1, this server */
  protect: readonly number[]
  /** pids that got a SIGTERM on an earlier pass, with their age then */
  previouslyTermed: readonly { pid: number; ageS: number }[]
}

export interface Reaping {
  term: Leak[]
  kill: Leak[]
  skipped: { protected: number; live: number; young: number; unknown: number }
}

const trimmed = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path)

/** On a path boundary: `/a/b` contains `/a/b/c` and itself, not `/a/bc`. */
const inside = (cwd: string, path: string): boolean => cwd === path || cwd.startsWith(`${path}/`)

/**
 * Which processes belong to a closed lead attempt and must end. A process is a leak when its session names a closed attempt
 * (closed for longer than the grace, no live attempt with the same key), or its directory lies inside such an attempt's
 * worktree (one the finalization removed, not a kept one) and inside no live attempt's. Nothing else is touched: an unknown session or directory, a live attempt's
 * process, one inside the grace, a protected pid or any ancestor of one. A leak SIGTERMed before and still the same
 * process (same pid, not younger than recorded: a smaller age is a reused pid) is escalated to SIGKILL.
 */
export function decideReaping(input: ReapingInput): Reaping {
  const live = input.attempts.filter((a) => a.closedAt === null)
  const liveSessions = new Set(live.map((a) => a.session))
  const liveTrees = live.flatMap((a) => (a.worktree === null ? [] : [trimmed(a.worktree)]))
  const closed = input.attempts.filter((a) => a.closedAt !== null && !liveSessions.has(a.session))
  const closedBySession = new Map(closed.map((a) => [a.session, a]))

  const parent = new Map(input.procs.map((p) => [p.pid, p.ppid]))
  const safe = new Set<number>()
  for (const start of input.protect) {
    let pid: number | undefined = start
    while (pid !== undefined && pid > 0 && !safe.has(pid)) {
      safe.add(pid)
      pid = parent.get(pid)
    }
  }

  const termed = new Map(input.previouslyTermed.map((t) => [t.pid, t.ageS]))
  const result: Reaping = { term: [], kill: [], skipped: { protected: 0, live: 0, young: 0, unknown: 0 } }

  for (const proc of input.procs) {
    if (safe.has(proc.pid)) {
      result.skipped.protected++
      continue
    }
    if (proc.session !== null && liveSessions.has(proc.session)) {
      result.skipped.live++
      continue
    }
    const cwd = proc.cwd === null ? null : trimmed(proc.cwd)
    if (cwd !== null && liveTrees.some((tree) => inside(cwd, tree))) {
      result.skipped.live++
      continue
    }

    let attempt = proc.session === null ? undefined : closedBySession.get(proc.session)
    let reason: Leak['reason'] = 'session'
    if (!attempt && cwd !== null) {
      reason = 'worktree'
      for (const candidate of closed) {
        if (candidate.worktree === null || candidate.kept) continue
        const tree = trimmed(candidate.worktree)
        if (inside(cwd, tree) && (!attempt || tree.length > trimmed(attempt.worktree ?? '').length)) attempt = candidate
      }
    }
    if (!attempt?.closedAt) {
      if (proc.session !== null) result.skipped.unknown++
      continue
    }
    if (input.now.getTime() - attempt.closedAt.getTime() < input.graceMs) {
      result.skipped.young++
      continue
    }

    const leak: Leak = {
      pid: proc.pid,
      ppid: proc.ppid,
      ageS: proc.ageS,
      comm: proc.comm,
      session: attempt.session,
      worktree: attempt.worktree,
      reason,
    }
    const before = termed.get(proc.pid)
    if (before !== undefined && proc.ageS >= before) result.kill.push(leak)
    else result.term.push(leak)
  }
  return result
}
