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
   * Whether the work of this worktree is in the repo's default branch, with the proof as one line. Work is every commit made here, as the
   * worktree's own `HEAD` log shows it (`commit`, `commit (amend)`, `cherry-pick`, `revert`, `rebase (pick)` and the like; a merge commit made
   * to bring the default branch in is none, and a commit an amend replaced is not counted). None at all is `nothing`: a branch still where the
   * worktree was cut proves nothing. Merged is: `HEAD` is in the default branch (an ancestor of any of `origin/main`, `origin/master`,
   * `main`, `master` that exists; or every commit up to it has an equal patch there, `git cherry`; or its tree equals a commit on the first-parent
   * line, a squash merge), **and** every commit made here that `HEAD` no longer holds (a reset or a checkout moved off it) is on the default
   * branch by commit or by patch. A commit made here that is not there keeps the worktree ("own commit X not on the default branch"). Read-only.
   */
  async mergeProof(worktree: string): Promise<{ merged: boolean; proof: string; nothing?: boolean }> {
    const own = await this.ownCommits(worktree)
    if ('why' in own) return { merged: false, proof: own.why, nothing: own.nothing }
    const head = (
      await this.git(worktree, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => '')
    ).trim()
    if (!head) return { merged: false, proof: 'its head has no commit' }
    const refs = await this.defaultRefs(worktree)
    if (refs.length === 0) return { merged: false, proof: 'the repo has no default branch to compare with' }

    const held = await this.headProof(worktree, head, refs)
    if (!held.merged) return held
    // The commits made here that HEAD does not hold any more (a reset or a checkout moved off them): each must be on the default branch
    // itself, by commit or by patch. One `rev-list` per ref says which are not there by commit, and `git cherry` looks at what is left.
    const loose = await this.notIn(worktree, own.shas, head)
    let rest = loose
    for (const ref of refs) {
      if (rest.length === 0) break
      rest = await this.notIn(worktree, rest, ref.sha)
    }
    for (const sha of rest) {
      let there = false
      for (const ref of refs) {
        if (await this.patchThere(worktree, ref.sha, sha)) {
          there = true
          break
        }
      }
      if (!there) return { merged: false, proof: `own commit ${sha.slice(0, 12)} not on the default branch` }
    }
    return {
      merged: true,
      proof: loose.length > 0 ? `${held.proof}; ${loose.length} commit(s) it moved off are there too` : held.proof,
    }
  }

  /** `HEAD` against the default refs: by commit, by patch, or by tree. */
  private async headProof(
    worktree: string,
    head: string,
    refs: readonly { name: string; sha: string }[],
  ): Promise<{ merged: boolean; proof: string }> {
    const tree = (await this.git(worktree, ['rev-parse', `${head}^{tree}`])).trim()
    const short = head.slice(0, 12)
    for (const ref of refs) {
      const name = ref.name.replace(/^refs\/(?:remotes|heads)\//, '')
      if (await this.isAncestor(worktree, head, ref.sha))
        return { merged: true, proof: `commit ${short} is in ${name}` }
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
    return { merged: false, proof: `unmerged, ${ahead} commit(s) the default branch lacks, in content as well` }
  }

  /** Whether `sha` is in the history of `of`. Throws when git cannot say. */
  private async isAncestor(worktree: string, sha: string, of: string): Promise<boolean> {
    const done = await this.run(
      ['git', '--no-optional-locks', '-C', worktree, 'merge-base', '--is-ancestor', sha, of],
      GIT_TIMEOUT_MS,
      childEnv({ GIT_TERMINAL_PROMPT: '0' }),
    )
    if (done.exitCode === 0) return true
    if (done.exitCode === 1) return false
    throw new Error(`git merge-base failed (exit ${done.exitCode})`)
  }

  /** Those of `shas` that are not in the history of `of` (one `rev-list`). Throws when git cannot say. */
  private async notIn(worktree: string, shas: readonly string[], of: string): Promise<string[]> {
    if (shas.length === 0) return []
    const out = await this.git(worktree, ['rev-list', ...shas, '--not', of])
    const unreachable = new Set(out.split('\n').filter(Boolean))
    return shas.filter((sha) => unreachable.has(sha))
  }

  /** Whether the patch of `sha` is on `upstream` (`git cherry` marks it `-`). */
  private async patchThere(worktree: string, upstream: string, sha: string): Promise<boolean> {
    const lines = (await this.git(worktree, ['cherry', upstream, sha])).split('\n').filter(Boolean)
    return lines.length > 0 && lines.every((line) => line.startsWith('- '))
  }

  /**
   * The commits made in this worktree, oldest first, from its own `HEAD` log (read from the file in its git dir: it outlives a moved or
   * deleted branch). Merge commits made to bring a branch in are left out, and so is a commit an amend replaced. One that is not in the repo
   * any more (pruned) cannot be judged and is left out. `why` says that nothing was made here.
   */
  private async ownCommits(worktree: string): Promise<{ shas: string[] } | { why: string; nothing: boolean }> {
    const dir = (await this.git(worktree, ['rev-parse', '--absolute-git-dir']).catch(() => '')).trim()
    const log = dir
      ? await Bun.file(`${dir}/logs/HEAD`)
          .text()
          .catch(() => undefined)
      : undefined
    if (log === undefined) return { why: 'no commit made here (no reflog)', nothing: true }
    // `<old> <new> <who> <time> <zone>\t<message>`, oldest first.
    const made: string[] = []
    const replaced = new Set<string>()
    for (const line of log.split('\n')) {
      const [front, subject = ''] = line.split('\t')
      const [old, sha] = front?.split(' ') ?? []
      if (!sha) continue
      if (/^commit \(amend\)/.test(subject) && old) replaced.add(old)
      if (
        /^(?:commit(?! \(merge\))|cherry-pick|revert|rebase \((?:pick|reword|squash|fixup|continue)\))(?:[\s:(]|$)/.test(
          subject,
        )
      ) {
        made.push(sha)
      }
    }
    const shas = [...new Set(made)].filter((sha) => !replaced.has(sha))
    if (shas.length === 0) return { why: 'no commit made here', nothing: true }
    // One call says which of them the repo has. A commit that is gone (pruned) cannot be proven and keeps the worktree; a call that fails
    // throws, and the worktree is judged again at the next pass.
    const checked = await this.run(
      ['git', '--no-optional-locks', '-C', worktree, 'cat-file', '--batch-check'],
      GIT_TIMEOUT_MS,
      childEnv({ GIT_TERMINAL_PROMPT: '0' }),
      `${shas.join('\n')}\n`,
    )
    if (checked.exitCode !== 0) throw new Error(`git cat-file failed (exit ${checked.exitCode})`)
    const missing = checked.stdout.split('\n').find((line) => line.endsWith(' missing'))
    if (missing) return { why: `own commit ${missing.slice(0, 12)} is not in the repo any more`, nothing: false }
    return { shas }
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
