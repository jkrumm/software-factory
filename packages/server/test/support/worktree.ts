import { mkdirSync } from 'node:fs'
import type { Removal, Worktree, Worktrees } from '../../src/issues/worktree.ts'

/** A worktree port that makes a directory under the repo and remembers the calls; the same branch answers the same directory. */
export class FakeWorktrees implements Worktrees {
  made: { repo: string; branch: string }[] = []
  failure?: Error
  removed: { repo: string; branch: string }[] = []
  /** what `remove` answers */
  removal: Removal = { removed: true }

  async create({ repo, branch }: { repo: string; branch: string }): Promise<Worktree> {
    if (this.failure) throw this.failure
    this.made.push({ repo, branch })
    const path = `${repo}/.claude/worktrees/${branch.replaceAll('/', '-')}`
    mkdirSync(path, { recursive: true })
    return { path, base: 'origin/master', sha: '0'.repeat(40) }
  }

  async remove({ repo, branch }: { repo: string; branch: string }): Promise<Removal> {
    this.removed.push({ repo, branch })
    return this.removal
  }
}
