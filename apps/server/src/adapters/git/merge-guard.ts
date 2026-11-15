import { join } from 'node:path'
import type { MergeGuard } from '../../domains/leads/ports.ts'

/** A Makefile rule named `merge-guard`, alone or among others (`a merge-guard: b`). */
const TARGET = /^(?:[\w.-]+\s+)*merge-guard(?:\s+[\w.-]+)*\s*:(?!=)/m

/** Whether the worktree's `Makefile` defines a `merge-guard` target; no Makefile is a repo without one, an unreadable one is unknown. */
export function makefileMergeGuard(): MergeGuard {
  return {
    async has(worktree) {
      const file = Bun.file(join(worktree, 'Makefile'))
      try {
        if (!(await file.exists())) return false
        return TARGET.test(await file.text())
      } catch {
        return null
      }
    },
  }
}
