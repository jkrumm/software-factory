import { existsSync } from 'node:fs'
import { childEnv, EXIT_TIMEOUT, runProcess } from '../exec.ts'

/** A lead's own checkout: a branch of the repo, cut from the default branch as it is on the remote. */
export interface Worktree {
  path: string
  /** `origin/<default>` */
  base: string
  sha: string
}

/**
 * Makes a lead's worktree (the steps of dotfiles' `fan-worktree.sh`, which `rd fan` uses). Idempotent per branch: a branch whose
 * worktree already exists answers that worktree, so a start that crashed after the checkout and before its spawn finds its work.
 * A port: no call of it is inside a transaction.
 */
export interface Worktrees {
  create(input: { repo: string; branch: string }): Promise<Worktree>
}

export class WorktreeFailed extends Error {}

const FETCH_TIMEOUT_MS = 90_000
const GIT_TIMEOUT_MS = 30_000
/** The repo's own `wtp` hooks install dependencies and copy env files. */
const WTP_TIMEOUT_MS = 300_000

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

  async create({ repo, branch }: { repo: string; branch: string }): Promise<Worktree> {
    const git = this.options.git ?? 'git'
    await this.run([git, '-C', repo, 'fetch', '-q', 'origin'], FETCH_TIMEOUT_MS, 'git fetch origin')

    let base = await this.probe([git, '-C', repo, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])
    if (!base) {
      for (const candidate of ['origin/master', 'origin/main']) {
        if (await this.probe([git, '-C', repo, 'rev-parse', '-q', '--verify', candidate])) {
          base = candidate
          break
        }
      }
    }
    if (!base) throw new WorktreeFailed(`no origin default branch in ${repo}`)
    const sha = await this.run([git, '-C', repo, 'rev-parse', base], GIT_TIMEOUT_MS, 'git rev-parse')

    // The branch exists: its worktree is this one's earlier try, or the branch is somebody else's.
    if (await this.probe([git, '-C', repo, 'rev-parse', '-q', '--verify', `refs/heads/${branch}`])) {
      const listing = await this.run(
        [git, '-C', repo, 'worktree', 'list', '--porcelain'],
        GIT_TIMEOUT_MS,
        'git worktree list',
      )
      const path = worktreeOf(listing, branch)
      if (!path) throw new WorktreeFailed(`branch ${branch} already exists in ${repo}`)
      return { path, base, sha }
    }

    let path: string
    const wtp = this.options.wtp ?? Bun.which('wtp')
    const wantsWtp = existsSync(`${repo}/.wtp.yml`)
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
    return { path, base, sha }
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
