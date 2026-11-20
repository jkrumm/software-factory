import { mibOfDu } from '../../domains/capacity/disk.ts'
import type { WorktreeSizer } from '../../domains/capacity/ports.ts'
import { runProcess } from '../process.ts'

/** A worktree with a build output is some GiB over many files: `du` reads it in seconds, and past this it is left for the next try. */
const DU_TIMEOUT_MS = 90_000

/**
 * What a worktree takes on disk, by `du -sk`. APFS clones (a build output copied from the target seed) are counted in full by
 * `du`, so the figure is above what the volume really loses: a fit that errs towards refusing, never towards filling the disk.
 */
export function duSizer(options: { du?: string } = {}): WorktreeSizer {
  const du = options.du ?? 'du'
  return {
    async sizeMib(path) {
      const out = await runProcess([du, '-sk', path], DU_TIMEOUT_MS)
      return out.exitCode === 0 ? mibOfDu(out.stdout) : null
    },
  }
}
