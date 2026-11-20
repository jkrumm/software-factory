import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { makefileIn, scanGuard } from '@software-factory/contract'
import type { MergeGuard } from '../../domains/leads/ports.ts'

/**
 * Whether the worktree's Makefile (the one `make` reads: `GNUmakefile`, else `makefile`, else `Makefile`) defines a
 * `merge-guard` target; no Makefile is a repo without one, an unreadable one is unknown, and so is one that includes another
 * file and shows no such rule itself (only a Makefile read whole may claim the absence). `factory land` reads it by the same
 * rule (`scanGuard` of the contract).
 */
export function makefileMergeGuard(): MergeGuard {
  return {
    async has(worktree) {
      try {
        const name = makefileIn((candidate) => existsSync(join(worktree, candidate)))
        if (!name) return false
        const found = scanGuard(await Bun.file(join(worktree, name)).text())
        return found === 'rule' ? true : found === 'included' ? null : false
      } catch {
        return null
      }
    },
  }
}
