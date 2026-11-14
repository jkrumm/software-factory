import type { QuiesceProcess } from './ports.ts'
import type { SessionView } from './session.ts'

/** A lead whose Issue has waited this long, quiet, is dormant: past the hour its prompt cache is gone anyway. */
export const QUIESCE_AFTER_MS = 30 * 60_000
/** Failed resumes of a dormant session after which the lead is called gone. */
export const MAX_REVIVE_TRIES = 3

export type QuiesceVerdict = { quiesce: true } | { quiesce: false; why: string }

/**
 * Whether a waiting lead's `claude` may be ended now. Every `no` names the reason; the rule is pure, so it is read the same
 * on every pass.
 *  - the Issue waits with a reason that gave its claim up (a person, a timer, a dependency): a stall keeps its lead alive,
 *    and the steward acts on it;
 *  - the wait and the session have both been quiet for `afterMs`;
 *  - the session is `idle` at its prompt (not mid-turn, no background work in flight, no API error to resume) and its
 *    session id is known, which is what the wake resumes by;
 *  - its tree holds nothing else: a process that carries the lead's `FACTORY_SESSION` and has a parent that does too is a
 *    child of the lead. A `factory merge-lock`, `deploy-lock` or `slot run`, a test, a build or a background shell is always
 *    one, so this covers the locks. The lead's own root process must be seen, or the table says nothing about its tree;
 *  - no slot is granted to a directory inside its worktree.
 */
export function quiesceVerdict(input: {
  now: Date
  afterMs: number
  session: string
  /** the Issue waits and its wait gave the claim up */
  waitingFree: boolean
  /** when the wait began; null when the history does not say */
  waitSince: Date | null
  view: SessionView
  /** null: the process table could not be read */
  processes: readonly QuiesceProcess[] | null
  /** the lead's worktree, null when the attempt has none recorded */
  worktree: string | null
  slotCwds: readonly string[]
}): QuiesceVerdict {
  const { view } = input
  if (!input.waitingFree) return { quiesce: false, why: 'its Issue is not in a wait that gave its claim up' }
  if (!input.waitSince) return { quiesce: false, why: 'the start of the wait is unknown' }
  if (view.state !== 'idle') return { quiesce: false, why: `its session is ${view.state}, not idle` }
  if (view.backgroundTasks) return { quiesce: false, why: 'background work is in flight in its session' }
  if (view.apiIncident) return { quiesce: false, why: 'its last turn ended on an API error' }
  if (!view.claudeSession) return { quiesce: false, why: 'its session id is not known' }
  const quietFrom = Math.max(input.waitSince.getTime(), view.lastEventAt?.getTime() ?? 0)
  if (input.now.getTime() - quietFrom < input.afterMs) return { quiesce: false, why: 'it has not waited long enough' }

  if (input.processes === null) return { quiesce: false, why: 'the process table could not be read' }
  const tree = input.processes.filter((proc) => proc.session === input.session)
  const pids = new Set(tree.map((proc) => proc.pid))
  if (!tree.some((proc) => !pids.has(proc.ppid)))
    return { quiesce: false, why: 'its process is not in the process table' }
  const child = tree.find((proc) => pids.has(proc.ppid))
  if (child) return { quiesce: false, why: `process ${child.pid} runs in its tree` }

  const inside = input.worktree
    ? input.slotCwds.find((cwd) => cwd === input.worktree || cwd.startsWith(`${input.worktree}/`))
    : undefined
  if (inside) return { quiesce: false, why: 'a slot is granted to its worktree' }
  return { quiesce: true }
}
