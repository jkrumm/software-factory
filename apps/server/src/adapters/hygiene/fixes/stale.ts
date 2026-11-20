import { EXIT_TIMEOUT, withStderr } from '../../process.ts'
import type { Checkout, FixEntry } from '../../../domains/loops/hygiene-model.ts'
import { exec, type Tools } from '../git.ts'
import { scanStale } from '../probes/stale.ts'

const GIT_TIMEOUT_MS = 60_000

/** The first line of a git failure, flattened. */
const firstLine = (text: string): string =>
  text
    .split('\n')
    .find((line) => line.trim())
    ?.trim()
    .slice(0, 160) ?? 'no output'

/** Output git prints for a branch that is gone already: deleting it again is done, not a failure. */
const GONE = /remote ref does not exist|unable to delete .*remote ref does not exist/i

/**
 * The scripted fix of the `stale` probe: it deletes what the probe calls merged and nothing else. A remote branch merged
 * into the default branch loses nothing (its commits are in the default); a worktree whose head is in the default branch and
 * that nobody touched for two days loses nothing either, and `git worktree remove` without `--force` still refuses one with
 * changes or a lock. A branch or worktree that is only untouched is a decision, not a script's. Idempotent: a branch that is
 * gone already counts as deleted.
 */
export async function fixStale(tools: Tools, checkout: Checkout, keys: ReadonlySet<string>): Promise<FixEntry[]> {
  const scan = await scanStale(tools, checkout.path)
  if (typeof scan === 'string') return []
  const entries: FixEntry[] = []

  if (keys.has('stale:branches')) {
    const merged = scan.branches.filter((branch) => branch.why === 'merged')
    if (merged.length) {
      let deleted = 0
      const refused: string[] = []
      for (const branch of merged) {
        const result = await exec(
          withStderr([tools.git, 'push', '-q', 'origin', `:refs/heads/${branch.name}`]),
          GIT_TIMEOUT_MS,
          checkout.path,
        )
        if (result.exitCode === 0 || GONE.test(result.stdout)) deleted++
        else {
          refused.push(
            `${branch.name}: ${result.exitCode === EXIT_TIMEOUT ? 'did not finish' : firstLine(result.stdout)}`,
          )
        }
      }
      entries.push(
        refused.length
          ? {
              key: 'stale:branches',
              outcome: 'failed',
              detail: `deleted ${deleted} of ${merged.length} merged remote branches; ${refused.length} refused`,
              output: refused.slice(0, 8),
            }
          : {
              key: 'stale:branches',
              outcome: 'fixed',
              detail: `deleted ${deleted} merged remote branch${deleted === 1 ? '' : 'es'}`,
            },
      )
    }
  }

  if (keys.has('stale:worktrees')) {
    const targets = scan.worktrees.filter(({ why }) => why === 'prunable' || why === 'merged')
    if (targets.length) {
      await exec(withStderr([tools.git, 'worktree', 'prune']), GIT_TIMEOUT_MS, checkout.path)
      let removed = 0
      const refused: string[] = []
      for (const { worktree, why } of targets) {
        if (why === 'prunable') {
          removed++
          continue
        }
        const result = await exec(
          withStderr([tools.git, 'worktree', 'remove', worktree.path]),
          GIT_TIMEOUT_MS,
          checkout.path,
        )
        if (result.exitCode === 0) removed++
        else refused.push(`${worktree.path.split('/').slice(-2).join('/')}: ${firstLine(result.stdout)}`)
      }
      entries.push(
        refused.length
          ? {
              key: 'stale:worktrees',
              outcome: 'failed',
              detail: `removed ${removed} of ${targets.length} leftover worktrees; ${refused.length} refused`,
              output: refused.slice(0, 8),
            }
          : {
              key: 'stale:worktrees',
              outcome: 'fixed',
              detail: `removed ${removed} leftover worktree${removed === 1 ? '' : 's'}`,
            },
      )
    }
  }
  return entries
}
