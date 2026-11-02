import { stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { FleetCommit, FleetGit } from '@software-factory/contract'
import { childEnv, EXIT_TIMEOUT, runProcess } from '../exec.ts'
import { GIT_TIMEOUT_MS } from './sources.ts'

/** The default branch, in the order both readers look: the first that exists. */
const DEFAULT_REFS = ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master']
/** How far down the default branch's first-parent line a tree is looked for (a squash merge is one commit there). */
const TREE_SEARCH = 300
/** Commits kept per repo for the since reading's Shipped group. */
export const RECENT_COMMITS = 20

/** Bounded, read-only git for the fleet builder: every call has a timeout, none writes (`--no-optional-locks`), none runs in a transaction. */
export class GitReader {
  constructor(private readonly run: typeof runProcess = runProcess) {}

  private async git(cwd: string, args: string[]): Promise<string> {
    const done = await this.run(
      ['git', '--no-optional-locks', '-C', cwd, ...args],
      GIT_TIMEOUT_MS,
      childEnv({ GIT_TERMINAL_PROMPT: '0' }),
    )
    if (done.exitCode === EXIT_TIMEOUT) throw new Error(`git ${args[0]} did not answer in time`)
    if (done.exitCode !== 0) throw new Error(`git ${args[0]} failed (exit ${done.exitCode})`)
    return done.stdout
  }

  /**
   * Branch, the dirty bit (untracked files do not count), the last commit and the recent ones. An empty repo has no commit; a detached head no
   * branch. `recentError` says why the recent commits could not be read (then `recent` is empty and the caller keeps what it had).
   */
  async state(repo: string): Promise<FleetGit & { recentError?: string }> {
    const status = await this.git(repo, ['status', '--porcelain=v2', '--branch', '--untracked-files=no'])
    let branch: string | null = null
    let dirty = false
    for (const line of status.split('\n')) {
      if (line.startsWith('# branch.head ')) {
        const head = line.slice('# branch.head '.length).trim()
        branch = head === '(detached)' ? null : head
      } else if (line && !line.startsWith('#')) dirty = true
    }
    const log = await this.git(repo, ['log', '-1', '--format=%H%x1f%cI%x1f%s']).catch(() => '')
    const [sha, at, subject] = log.trim().split('\x1f')
    // Only `recent` falls back when it cannot be read: the branch, the dirty bit and the last commit stand, and the builder keeps the previous
    // build's commits and says so in `errors`.
    let recent: FleetCommit[] = []
    let recentError: string | undefined
    try {
      recent = await this.recent(repo)
    } catch (error) {
      recentError = error instanceof Error ? error.message : String(error)
    }
    return {
      branch,
      dirty,
      lastCommit: sha && at ? { sha: sha.slice(0, 12), at, subject: subject ?? '' } : null,
      recent,
      recentError,
    }
  }

  /**
   * The last `limit` commits of the default branch (`defaultHead`), first-parent (a merge is one line, not the commits it brought), newest
   * first; no default branch is an empty list. Throws when git does not answer in time. Read-only, bounded, off the request path.
   */
  async recent(repo: string, limit = RECENT_COMMITS): Promise<FleetCommit[]> {
    const head = await this.defaultHead(repo)
    if (!head) return []
    const log = await this.git(repo, ['log', '--first-parent', `-${limit}`, '--format=%H%x1f%cI%x1f%s%x1e', head])
    return log
      .split('\x1e')
      .map((record) => record.trim())
      .filter(Boolean)
      .flatMap((record) => {
        const [sha, at, subject] = record.split('\x1f')
        return sha && at ? [{ sha: sha.slice(0, 12), at, subject: subject ?? '' }] : []
      })
  }

  /**
   * The tip of the default branch: the first of `origin/main`, `origin/master`, `main`, `master` that exists, from one `for-each-ref`
   * call; `undefined` when none does. Throws when git does not answer in time: that is no reason to read an older ref.
   */
  async defaultHead(repo: string): Promise<string | undefined> {
    const out = await this.git(repo, ['for-each-ref', '--format=%(refname)%1f%(objectname)', ...DEFAULT_REFS])
    const tips = new Map(
      out.split('\n').flatMap((line) => (line.includes('\x1f') ? [line.trim().split('\x1f') as [string, string]] : [])),
    )
    for (const ref of DEFAULT_REFS) {
      const tip = tips.get(ref)
      if (tip) return tip
    }
    return undefined
  }

  /** The time of the file's last commit; the file's mtime for one that has none (untracked, or outside any repo). */
  async touched(file: string): Promise<string | null> {
    const committed = await this.git(dirname(file), ['log', '-1', '--format=%cI', '--', basename(file)]).catch(() => '')
    if (committed.trim()) return committed.trim()
    return stat(file).then(
      (s) => s.mtime.toISOString(),
      () => null,
    )
  }

  /**
   * Whether the default branch (`defaultHead`) has moved past `sha`: it is a descendant of the commit, and not the commit. `undefined` when
   * git cannot say (no such commit here, no default branch, a history that does not contain it, a git that timed out). Read-only.
   */
  async newerThan(repo: string, sha: string): Promise<{ head: string } | false | undefined> {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return undefined
    const commit = await this.git(repo, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]).catch(() => '')
    if (!commit.trim()) return undefined
    const head = await this.defaultHead(repo).catch(() => undefined)
    if (!head) return undefined
    if (head === commit.trim()) return false
    const ancestor = await this.run(
      ['git', '--no-optional-locks', '-C', repo, 'merge-base', '--is-ancestor', commit.trim(), head],
      GIT_TIMEOUT_MS,
      childEnv({ GIT_TERMINAL_PROMPT: '0' }),
    )
    // A history that does not contain the commit (diverged) says nothing about a newer deploy.
    return ancestor.exitCode === 0 ? { head } : undefined
  }
  /** Entries of `git status --porcelain` in a worktree, untracked files included (ignored ones are not): 0 is clean. Throws when git cannot say. */
  async dirtyEntries(worktree: string): Promise<number> {
    const out = await this.git(worktree, ['status', '--porcelain', '--untracked-files=normal'])
    return out.split('\n').filter((line) => line.trim() !== '').length
  }

  /**
   * Whether the worktree's `HEAD` is in the repo's default branch, with the proof as one line. Merged is: the commit is an ancestor of
   * a default ref (any of `origin/main`, `origin/master`, `main`, `master` that exists), or every commit it has beyond one has an equal patch
   * there (`git cherry`), or its tree equals the tree of a commit on that ref's first-parent line (a squash merge). A head with a commit
   * the default branch lacks, in content as well, is unmerged. A `HEAD` with no commit (its branch is gone) cannot be compared. Read-only.
   */
  async mergeProof(worktree: string): Promise<{ merged: boolean; proof: string }> {
    const head = (
      await this.git(worktree, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => '')
    ).trim()
    if (!head) return { merged: false, proof: 'its branch has no commit to compare (gone)' }
    const refs = await this.defaultRefs(worktree)
    if (refs.length === 0) return { merged: false, proof: 'the repo has no default branch to compare with' }
    const tree = (await this.git(worktree, ['rev-parse', `${head}^{tree}`])).trim()
    const short = head.slice(0, 12)
    for (const ref of refs) {
      const name = ref.name.replace(/^refs\/(?:remotes|heads)\//, '')
      const ancestor = await this.run(
        ['git', '--no-optional-locks', '-C', worktree, 'merge-base', '--is-ancestor', head, ref.sha],
        GIT_TIMEOUT_MS,
        childEnv({ GIT_TERMINAL_PROMPT: '0' }),
      )
      if (ancestor.exitCode === 0) return { merged: true, proof: `commit ${short} is in ${name}` }
      if (ancestor.exitCode !== 1) throw new Error(`git merge-base failed (exit ${ancestor.exitCode})`)
      const cherry = (await this.git(worktree, ['cherry', ref.sha, head])).split('\n').filter(Boolean)
      if (cherry.length > 0 && cherry.every((line) => line.startsWith('- '))) {
        return { merged: true, proof: `every commit up to ${short} has an equal patch on ${name} (git cherry)` }
      }
      const line = await this.git(worktree, ['log', '--first-parent', `-${TREE_SEARCH}`, '--format=%H %T', ref.sha])
      const same = line.split('\n').find((entry) => entry.split(' ')[1] === tree)
      if (same) return { merged: true, proof: `its tree equals ${same.slice(0, 12)} on ${name}` }
    }
    const [first] = refs
    const ahead = first ? (await this.git(worktree, ['rev-list', '--count', `${first.sha}..${head}`])).trim() : '?'
    return { merged: false, proof: `${ahead} commit(s) the default branch lacks, in content as well` }
  }

  /** The branch a worktree is on; null when detached. */
  async branchOf(worktree: string): Promise<string | null> {
    const out = await this.git(worktree, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')
    return out.trim() || null
  }

  /** Every default ref that exists, in the order `defaultHead` prefers them. */
  private async defaultRefs(repo: string): Promise<{ name: string; sha: string }[]> {
    const out = await this.git(repo, ['for-each-ref', '--format=%(refname)%1f%(objectname)', ...DEFAULT_REFS])
    const tips = new Map(
      out.split('\n').flatMap((line) => (line.includes('\x1f') ? [line.trim().split('\x1f') as [string, string]] : [])),
    )
    return DEFAULT_REFS.flatMap((name) => {
      const sha = tips.get(name)
      return sha ? [{ name, sha }] : []
    })
  }
}
