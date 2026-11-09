import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Worktree, WorktreeRemoval, Worktrees } from '../../domains/leads/ports.ts'
import { err, ok, portError, type PortError, type Result } from '../../kernel/result.ts'
import { CannotExecute, childEnv, EXIT_TIMEOUT, runProcess } from '../hc/process.ts'

const FETCH_TIMEOUT_MS = 90_000
const GIT_TIMEOUT_MS = 30_000
/** The repo's own `wtp` hooks install dependencies and copy env files. */
const WTP_TIMEOUT_MS = 300_000
/** In the worktree's git directory, not its files, so it never reads as a change: written last, it says the setup finished. */
const READY_MARKER = 'factory-ready'

class Failed extends Error {
  constructor(
    message: string,
    readonly kind: PortError['kind'] = 'gone',
  ) {
    super(message)
  }
}

/** git in a repo, giving its trimmed output, or nothing when it fails. */
export type GitProbe = (repo: string, ...args: string[]) => Promise<string | undefined>

/** `origin/<default>` of the repo, as the last fetch left it. */
export async function originDefaultOf(gitIn: GitProbe, repo: string): Promise<string | undefined> {
  const head = await gitIn(repo, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD')
  if (head) return head
  for (const candidate of ['origin/master', 'origin/main']) {
    if (await gitIn(repo, 'rev-parse', '-q', '--verify', candidate)) return candidate
  }
  return undefined
}

/** Whether everything the ref holds is on the base: no commit ahead, or a merge that changes nothing. A missing ref holds nothing. */
export async function refOnBase(gitIn: GitProbe, repo: string, ref: string, base: string): Promise<boolean> {
  if (!(await gitIn(repo, 'rev-parse', '-q', '--verify', ref))) return true
  if ((await gitIn(repo, 'rev-list', '--count', ref, '--not', base)) === '0') return true
  const merged = await gitIn(repo, 'merge-tree', '--write-tree', base, ref)
  return merged !== undefined && merged === (await gitIn(repo, 'rev-parse', `${base}^{tree}`))
}

export interface GitWorktreesOptions {
  git?: string
  wtp?: string
}

/**
 * Makes and removes a lead's worktree. `create` fetches the remote first, so the branch is cut from what is pushed, not
 * from a checkout that is behind, and is idempotent per branch: one made whole answers that worktree, one left half made
 * is removed and made again. `remove` takes it away only when nothing would be lost.
 */
export function gitWorktrees(options: GitWorktreesOptions = {}): Worktrees {
  const git = options.git ?? 'git'

  async function probe(cmd: string[], cwd?: string): Promise<string | undefined> {
    const result = await runProcess(cmd, GIT_TIMEOUT_MS, childEnv(), undefined, cwd)
    return result.exitCode === 0 ? result.stdout.trim() : undefined
  }
  const gitIn = (repo: string, ...args: string[]) => probe([git, '-C', repo, ...args])

  async function run(cmd: string[], timeoutMs: number, what: string, cwd?: string): Promise<string> {
    const result = await runProcess(cmd, timeoutMs, childEnv(), undefined, cwd)
    if (result.exitCode === EXIT_TIMEOUT) {
      throw new Failed(`${what} did not finish in ${Math.round(timeoutMs / 1000)} s`, 'timeout')
    }
    if (result.exitCode !== 0) throw new Failed(`${what} failed (exit ${result.exitCode})`)
    return result.stdout.trim()
  }

  const originDefault = (repo: string) => originDefaultOf(gitIn, repo)

  /** The path `git worktree list --porcelain` gives for a branch, if any worktree has it checked out. */
  async function listed(repo: string, branch: string): Promise<string | undefined> {
    const listing = await run([git, '-C', repo, 'worktree', 'list', '--porcelain'], GIT_TIMEOUT_MS, 'git worktree list')
    for (const block of listing.split('\n\n')) {
      const lines = block.split('\n')
      const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
      if (path && lines.includes(`branch refs/heads/${branch}`)) return path
    }
    return undefined
  }

  async function marker(path: string): Promise<string | undefined> {
    const dir = await gitIn(path, 'rev-parse', '--absolute-git-dir')
    return dir ? join(dir, READY_MARKER) : undefined
  }

  /** What a setup that did not finish left: nobody has worked in it. Best effort, and the next try looks again. */
  async function discard(repo: string, branch: string): Promise<void> {
    const path = await listed(repo, branch).catch(() => undefined)
    if (path) await gitIn(repo, 'worktree', 'remove', '--force', path)
    await gitIn(repo, 'worktree', 'prune')
    await gitIn(repo, 'branch', '-D', branch)
  }

  async function make(repo: string, branch: string, base: string): Promise<string> {
    const wtp = options.wtp ?? Bun.which('wtp')
    // As the base has it: a checkout that is behind must not decide how a worktree of what is pushed is set up.
    const wantsWtp = (await gitIn(repo, 'cat-file', '-e', `${base}:.wtp.yml`)) !== undefined
    // Plain git would skip the repo's setup hooks (dependencies, env files): a lead in such a tree is worse than none.
    if (wantsWtp && !wtp) throw new Failed(`${repo} has a .wtp.yml and wtp is not on PATH: install wtp`, 'refused')
    let path: string
    if (wtp && wantsWtp) {
      const out = await run([wtp, 'add', '-b', branch, base, '--quiet'], WTP_TIMEOUT_MS, 'wtp add', repo)
      path = out.split('\n').pop()?.trim() ?? ''
    } else {
      path = `${repo}/.claude/worktrees/${branch.replaceAll('/', '-')}`
      await run(
        [git, '-C', repo, 'worktree', 'add', '-q', '-b', branch, path, base],
        GIT_TIMEOUT_MS,
        'git worktree add',
      )
    }
    if (!path || !existsSync(path)) throw new Failed(`worktree path '${path}' is missing after the create`)
    // A branch cut from origin/<default> must not track it: a bare `git push` would target the default branch.
    await gitIn(path, 'branch', '--unset-upstream', branch)
    return path
  }

  async function create(input: { repo: string; branch: string }): Promise<Worktree> {
    const { repo, branch } = input
    await run([git, '-C', repo, 'fetch', '-q', 'origin'], FETCH_TIMEOUT_MS, 'git fetch origin')
    const base = await originDefault(repo)
    if (!base) throw new Failed(`no origin default branch in ${repo}`, 'refused')
    const sha = await run([git, '-C', repo, 'rev-parse', base], GIT_TIMEOUT_MS, 'git rev-parse')

    // The branch exists: its worktree is this one's earlier try, or the branch is somebody else's.
    if (await gitIn(repo, 'rev-parse', '-q', '--verify', `refs/heads/${branch}`)) {
      const path = await listed(repo, branch)
      if (!path) throw new Failed(`branch ${branch} already exists in ${repo}`, 'refused')
      const file = await marker(path)
      const cut = file && existsSync(file) ? (await Bun.file(file).text()).trim() : ''
      if (/^[0-9a-f]{40,64}$/.test(cut)) return { path, base, sha: cut }
      // No marker, but commits say somebody worked here: it is not this code's to delete.
      if ((await gitIn(repo, 'rev-list', '--count', `refs/heads/${branch}`, '--not', base)) !== '0') {
        throw new Failed(`branch ${branch} has commits and no finished setup: it is left as it is`, 'refused')
      }
      await discard(repo, branch)
    }
    try {
      const path = await make(repo, branch, base)
      const file = await marker(path)
      if (!file) throw new Failed(`${path} is no worktree`)
      await Bun.write(file, `${sha}\n`)
      return { path, base, sha }
    } catch (error) {
      await discard(repo, branch)
      throw error
    }
  }

  const onBase = (repo: string, branch: string, base: string) => refOnBase(gitIn, repo, `refs/heads/${branch}`, base)

  async function remove(input: { repo: string; branch: string }): Promise<WorktreeRemoval> {
    const { repo, branch } = input
    await gitIn(repo, 'worktree', 'prune')
    const path = (await listed(repo, branch)) ?? null
    if (path && (await gitIn(path, 'status', '--porcelain')) !== '') return { kept: 'it has uncommitted changes', path }
    // A failed fetch reads what the last one left, which can only keep more.
    await probe([git, '-C', repo, 'fetch', '-q', 'origin'])
    const base = await originDefault(repo)
    if (!base) return { kept: `${repo} has no origin default branch to check it against`, path }
    if (!(await onBase(repo, branch, base))) return { kept: `its commits are not on ${base}`, path }
    if (path && (await gitIn(repo, 'worktree', 'remove', path)) === undefined) {
      return { kept: 'git worktree remove refused', path }
    }
    await gitIn(repo, 'branch', '-D', branch)
    return { removed: true }
  }

  const guarded = async <T>(step: () => Promise<T>): Promise<Result<T>> => {
    try {
      return ok(await step())
    } catch (error) {
      if (error instanceof Failed) return err(portError(error.kind, error.message))
      if (error instanceof CannotExecute) return err(portError('gone', error.message))
      throw error
    }
  }
  return { create: (input) => guarded(() => create(input)), remove: (input) => guarded(() => remove(input)) }
}
