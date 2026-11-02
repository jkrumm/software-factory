import { stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { FleetCommit, FleetGit } from '@software-factory/contract'
import { childEnv, EXIT_TIMEOUT, runProcess } from '../exec.ts'
import { GIT_TIMEOUT_MS } from './sources.ts'

/** The default branch, in the order both readers look: the first that exists. */
const DEFAULT_REFS = ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master']
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

  /** Branch, the dirty bit (untracked files do not count) and the last commit. An empty repo has no commit; a detached head no branch. */
  async state(repo: string): Promise<FleetGit> {
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
    // A git that does not answer fails the state: the builder keeps the previous build's (commits included) with a line in `errors`, never an
    // empty list the cursor could pass.
    const recent = await this.recent(repo)
    return {
      branch,
      dirty,
      lastCommit: sha && at ? { sha: sha.slice(0, 12), at, subject: subject ?? '' } : null,
      recent,
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
}
