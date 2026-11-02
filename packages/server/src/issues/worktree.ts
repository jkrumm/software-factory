import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { childEnv, EXIT_TIMEOUT, runProcess } from '../exec.ts'
import { branchOnBase, fetchOrigin, originDefault } from './origin.ts'

/** A lead's own checkout: a branch of the repo, cut from the default branch as it is on the remote. */
export interface Worktree {
  path: string
  /** `origin/<default>` */
  base: string
  sha: string
}

/** What became of a lead's worktree at the end of its attempt. */
export type Removal = { removed: true } | { kept: string; path: string | null }

/**
 * Makes and removes a lead's worktree (the steps of dotfiles' `fan-worktree.sh`, which `rd fan` uses). `create` is idempotent per branch: a
 * branch whose worktree was made whole answers that worktree, so a start that crashed after it and before its spawn finds its work; one
 * left half made is removed and made again. `remove` takes it away only when nothing would be lost. A port: no call of it is inside a
 * transaction.
 */
export interface Worktrees {
  create(input: { repo: string; branch: string }): Promise<Worktree>
  remove(input: { repo: string; branch: string }): Promise<Removal>
}

export class WorktreeFailed extends Error {}

const FETCH_TIMEOUT_MS = 90_000
const GIT_TIMEOUT_MS = 30_000
/** The repo's own `wtp` hooks install dependencies and copy env files. */
const WTP_TIMEOUT_MS = 300_000
/** In the worktree's git directory, not its files, so it never reads as a change: written last, it says the setup finished. */
const READY_MARKER = 'factory-ready'

/** `git` and `wtp` on the host. Fetches the remote first, so the branch is cut from what is pushed, not from a checkout that is behind. */
export class GitWorktrees implements Worktrees {
  constructor(private readonly options: { git?: string; wtp?: string; run?: typeof runProcess } = {}) {}

  private async run(cmd: string[], timeoutMs: number, what: string, cwd?: string): Promise<string> {
    const run = this.options.run ?? runProcess
    const result = await run(
      cwd ? ['sh', '-c', 'cd "$1" && shift && exec "$@"', 'sh', cwd, ...cmd] : cmd,
      timeoutMs,
      childEnv(),
    )
    if (result.exitCode === EXIT_TIMEOUT)
      throw new WorktreeFailed(`${what} did not finish in ${Math.round(timeoutMs / 1000)} s`)
    if (result.exitCode !== 0) throw new WorktreeFailed(`${what} failed (exit ${result.exitCode})`)
    return result.stdout.trim()
  }

  private async probe(cmd: string[]): Promise<string | undefined> {
    const run = this.options.run ?? runProcess
    const result = await run(cmd, GIT_TIMEOUT_MS, childEnv())
    return result.exitCode === 0 ? result.stdout.trim() : undefined
  }

  private async git(repo: string, ...args: string[]): Promise<string | undefined> {
    return this.probe([this.options.git ?? 'git', '-C', repo, ...args])
  }

  private async listed(repo: string, branch: string): Promise<string | undefined> {
    const git = this.options.git ?? 'git'
    const listing = await this.run(
      [git, '-C', repo, 'worktree', 'list', '--porcelain'],
      GIT_TIMEOUT_MS,
      'git worktree list',
    )
    return worktreeOf(listing, branch)
  }

  private async marker(path: string): Promise<string | undefined> {
    const dir = await this.git(path, 'rev-parse', '--absolute-git-dir')
    return dir ? join(dir, READY_MARKER) : undefined
  }

  /** What a setup that did not finish left: nobody has worked in it. Best effort, and the next try looks again. */
  private async discard(repo: string, branch: string): Promise<void> {
    const path = await this.listed(repo, branch).catch(() => undefined)
    if (path) await this.git(repo, 'worktree', 'remove', '--force', path)
    await this.git(repo, 'worktree', 'prune')
    await this.git(repo, 'branch', '-D', branch)
  }

  async create({ repo, branch }: { repo: string; branch: string }): Promise<Worktree> {
    const git = this.options.git ?? 'git'
    await this.run([git, '-C', repo, 'fetch', '-q', 'origin'], FETCH_TIMEOUT_MS, 'git fetch origin')

    const base = await originDefault(repo, this.options)
    if (!base) throw new WorktreeFailed(`no origin default branch in ${repo}`)
    const sha = await this.run([git, '-C', repo, 'rev-parse', base], GIT_TIMEOUT_MS, 'git rev-parse')

    // The branch exists: its worktree is this one's earlier try, or the branch is somebody else's.
    if (await this.probe([git, '-C', repo, 'rev-parse', '-q', '--verify', `refs/heads/${branch}`])) {
      const path = await this.listed(repo, branch)
      if (!path) throw new WorktreeFailed(`branch ${branch} already exists in ${repo}`)
      const marker = await this.marker(path)
      // The sha it was cut from: the base has moved on since, and evidence counts the branch from there. A crash in the write leaves none.
      const cut = marker && existsSync(marker) ? (await Bun.file(marker).text()).trim() : ''
      if (/^[0-9a-f]{40,64}$/.test(cut)) return { path, base, sha: cut }
      // No lead started in a tree with no marker, but commits say somebody worked here: it is not this code's to delete.
      if ((await this.git(repo, 'rev-list', '--count', `refs/heads/${branch}`, '--not', base)) !== '0')
        throw new WorktreeFailed(`branch ${branch} has commits and no finished setup: it is left as it is`)
      await this.discard(repo, branch)
    }

    try {
      const path = await this.make(repo, branch, base)
      const marker = await this.marker(path)
      if (!marker) throw new WorktreeFailed(`${path} is no worktree`)
      await Bun.write(marker, `${sha}\n`)
      return { path, base, sha }
    } catch (error) {
      await this.discard(repo, branch)
      throw error
    }
  }

  private async make(repo: string, branch: string, base: string): Promise<string> {
    const git = this.options.git ?? 'git'
    let path: string
    const wtp = this.options.wtp ?? Bun.which('wtp')
    // As the base has it: a checkout that is behind must not decide how a worktree of what is pushed is set up.
    const wantsWtp = (await this.probe([git, '-C', repo, 'cat-file', '-e', `${base}:.wtp.yml`])) !== undefined
    // Plain git would skip the repo's setup hooks (dependencies, env files): a lead in such a tree is worse than none.
    if (wantsWtp && !wtp) throw new WorktreeFailed(`${repo} has a .wtp.yml and wtp is not on PATH: install wtp`)
    if (wtp && wantsWtp) {
      const out = await this.run([wtp, 'add', '-b', branch, base, '--quiet'], WTP_TIMEOUT_MS, 'wtp add', repo)
      path = out.split('\n').pop()?.trim() ?? ''
    } else {
      path = `${repo}/.claude/worktrees/${branch.replaceAll('/', '-')}`
      await this.run(
        [git, '-C', repo, 'worktree', 'add', '-q', '-b', branch, path, base],
        GIT_TIMEOUT_MS,
        'git worktree add',
      )
    }
    if (!path || !existsSync(path)) throw new WorktreeFailed(`worktree path '${path}' is missing after the create`)
    // A branch cut from origin/<default> must not track it: a bare `git push` would target the default branch.
    await this.probe([git, '-C', path, 'branch', '--unset-upstream', branch])
    return path
  }

  /**
   * Removes the worktree and its branch when it is clean and its commits are on the fetched base; otherwise leaves both and says why. A
   * worktree that is gone already is removed. A failed fetch reads what the last one left, which can only keep more.
   */
  async remove({ repo, branch }: { repo: string; branch: string }): Promise<Removal> {
    await this.git(repo, 'worktree', 'prune')
    const path = (await this.listed(repo, branch)) ?? null
    if (path && (await this.git(path, 'status', '--porcelain')) !== '')
      return { kept: 'it has uncommitted changes', path }
    await fetchOrigin(repo, this.options)
    const base = await originDefault(repo, this.options)
    if (!base) return { kept: `${repo} has no origin default branch to check it against`, path }
    if (!(await branchOnBase(repo, branch, base, this.options))) return { kept: `its commits are not on ${base}`, path }
    if (path && (await this.git(repo, 'worktree', 'remove', path)) === undefined)
      return { kept: 'git worktree remove refused', path }
    await this.git(repo, 'branch', '-D', branch)
    return { removed: true }
  }
}

/** The path `git worktree list --porcelain` gives for a branch, if any worktree has it checked out. */
export function worktreeOf(porcelain: string, branch: string): string | undefined {
  for (const block of porcelain.split('\n\n')) {
    const lines = block.split('\n')
    const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length)
    if (path && lines.includes(`branch refs/heads/${branch}`)) return path
  }
  return undefined
}
