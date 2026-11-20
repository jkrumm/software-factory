import { join } from 'node:path'
import type { MergeGuard } from '../../domains/leads/ports.ts'

/** A Makefile rule named `merge-guard`, alone or among others (`a merge-guard: b`). */
const TARGET = /^(?:[\w.-]+\s+)*merge-guard(?:\s+[\w.-]+)*\s*:(?!=)/m

/** An `include` can define the target in a file this scan does not read. */
const INCLUDE = /^-?s?include\s/m

/**
 * Whether the worktree's `Makefile` defines a `merge-guard` target; no Makefile is a repo without one, an unreadable one
 * is unknown, and so is one that includes another file and shows no such rule itself (only a Makefile read whole may claim the absence).
 */
export function makefileMergeGuard(): MergeGuard {
  return {
    async has(worktree) {
      const file = Bun.file(join(worktree, 'Makefile'))
      try {
        if (!(await file.exists())) return false
        const text = await file.text()
        if (TARGET.test(text)) return true
        return INCLUDE.test(text) ? null : false
      } catch {
        return null
      }
    },
  }
}
