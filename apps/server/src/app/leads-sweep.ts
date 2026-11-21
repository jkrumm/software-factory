import { leadBranch } from '../domains/leads/names.ts'
import { ok } from '../kernel/result.ts'
import { issueNumber } from '../kernel/ids.ts'
import type { LeadDeps } from './leads.ts'

/** A kept worktree is looked at again this often: what kept it (an unarchivable file, a commit not yet on the base) can pass. */
const WORKTREE_SWEEP_EVERY_MS = 3_600_000

/** What the sweep keeps between passes: when it last ran, and whether one is running now. Losing it costs one early pass. */
export interface WorktreeSweepMemory {
  lastAt: number
  running: boolean
}

export const worktreeSweepMemory = (): WorktreeSweepMemory => ({ lastAt: 0, running: false })

export interface WorktreeSweep {
  /** worktrees looked at */
  looked: number
  removed: number
}

/**
 * The worktrees of closed Issues that finalize kept (the rule that kept them may be older than today's: untracked scratch
 * kept every one of them): each goes through `remove` again, the same check finalize makes. One that goes loses its
 * reason; one that stays keeps the reason it has unless the reason changed. Sequential, and the drain ends it between two.
 */
export async function sweepKeptWorktrees(deps: LeadDeps, signal?: AbortSignal): Promise<WorktreeSweep> {
  const read = await deps.uow.run(async ({ leads }) => ok(await leads.keptWorktrees()))
  if (!read.ok) return { looked: 0, removed: 0 }
  let looked = 0
  let removed = 0
  for (const kept of read.value) {
    if (signal?.aborted) break
    const located = await deps.repos.locate(kept.repo)
    if (!located.ok) continue
    looked++
    const shipped = await deps.uow.run(async ({ quality }) =>
      ok((await quality.lastShip(kept.issue, kept.attempt))?.commits?.commits ?? []),
    )
    if (!shipped.ok) continue
    const removal = await deps.worktrees.remove({
      repo: located.value,
      branch: leadBranch(kept.issue, kept.attempt),
      path: kept.path,
      shipped: shipped.value,
      issue: issueNumber(kept.issue),
      attempt: kept.attempt,
    })
    if (!removal.ok) continue
    if ('kept' in removal.value && kept.kept?.includes(removal.value.kept)) continue
    const at = deps.clock.now()
    const marked = await deps.uow.run(async ({ leads }) => {
      if ('kept' in removal.value) {
        await leads.markStep(kept.issue, kept.attempt, 'worktree', at, {
          kept: removal.value.kept,
          path: removal.value.path,
        })
      } else {
        await leads.markStep(kept.issue, kept.attempt, 'worktree', at, { kept: null, path: null })
        removed++
      }
      return ok(undefined)
    })
    if (!marked.ok) continue
  }
  return { looked, removed }
}

/** Starts a sweep unless one runs or the last was within the hour; never awaited by the tick (a first sweep walks every kept tree). */
export function startWorktreeSweep(deps: LeadDeps, memory: WorktreeSweepMemory, signal?: AbortSignal): void {
  const now = deps.clock.now().getTime()
  if (memory.running || now - memory.lastAt < WORKTREE_SWEEP_EVERY_MS) return
  memory.running = true
  memory.lastAt = now
  void sweepKeptWorktrees(deps, signal)
    .catch((error: unknown) => {
      console.error(`worktree sweep failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    .finally(() => {
      memory.running = false
    })
}
