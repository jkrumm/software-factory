import * as z from 'zod'
import type { BranchCleaning, LeadBranches } from '../../domains/leads/ports.ts'
import { err, ok, portError, type Result } from '../../kernel/result.ts'
import { parseRemote } from '../intake/github.ts'
import { gitIn as runGit } from '../quality/git.ts'
import type { Run } from '../quality/process.ts'
import { type GitProbe, originDefaultOf, refOnBase } from './worktrees.ts'

const FETCH_TIMEOUT_MS = 90_000
const PUSH_TIMEOUT_MS = 60_000
const HTTP_TIMEOUT_MS = 15_000
const NOT_MERGED = 'its commits are not on origin/master and no merged PR or shipped commit'

const Pulls = z.array(z.looseObject({ merged_at: z.string().nullish() }))

export interface GitBranchesOptions {
  /** `FACTORY_GITHUB_TOKEN`; without it the merged pull request is not asked */
  token: string | null
  /** the API base (`FACTORY_GITHUB_API_URL`) */
  apiUrl: string
  run?: Run
  fetch?: typeof fetch
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Takes away the branches a closed Issue's leads left, local and on origin. It asks the remote first (a failed fetch
 * reads what the last one left, which can only keep more), never touches a branch that a worktree has checked out, and
 * never a branch of another number. Nothing here throws: a failure on a branch keeps that branch and says why.
 */
export function gitBranches(options: GitBranchesOptions): LeadBranches {
  const api = options.apiUrl.replace(/\/+$/, '')
  const doFetch = options.fetch ?? fetch
  const withRun = options.run ? { run: options.run } : {}

  async function raw(repo: string, args: string[], timeoutMs?: number): Promise<{ exitCode: number; stdout: string }> {
    try {
      return await runGit(repo, args, { ...withRun, ...(timeoutMs ? { timeoutMs } : {}) })
    } catch {
      return { exitCode: -1, stdout: '' }
    }
  }
  const git: GitProbe = async (repo, ...args) => {
    const done = await raw(repo, args)
    return done.exitCode === 0 ? done.stdout.trim() : undefined
  }

  async function checkedOut(repo: string): Promise<Map<string, string>> {
    const listing = (await git(repo, 'worktree', 'list', '--porcelain')) ?? ''
    const found = new Map<string, string>()
    for (const block of listing.split('\n\n')) {
      const lines = block.split('\n')
      const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
      const branch = lines.find((line) => line.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length)
      if (path && branch) found.set(branch, path)
    }
    return found
  }

  async function mergedPull(repo: string, branch: string): Promise<boolean> {
    if (!options.token) return false
    const url = await git(repo, 'remote', 'get-url', 'origin')
    const remote = url ? parseRemote(url) : undefined
    if (!remote) return false
    const head = encodeURIComponent(`${remote.owner}:${branch}`)
    try {
      const response = await doFetch(`${api}/repos/${remote.owner}/${remote.name}/pulls?head=${head}&state=all`, {
        headers: {
          Authorization: `Bearer ${options.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'software-factory',
        },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
      if (response.status !== 200) return false
      const pulls = Pulls.safeParse(await response.json().catch(() => undefined))
      return pulls.success && pulls.data.some((pull) => Boolean(pull.merged_at))
    } catch {
      return false
    }
  }

  async function clean(input: Parameters<LeadBranches['clean']>[0]): Promise<Result<BranchCleaning>> {
    const { repo, issue, closed, shipped } = input
    await raw(repo, ['fetch', '-q', '--prune', 'origin'], FETCH_TIMEOUT_MS)
    await git(repo, 'worktree', 'prune')

    const listing = await raw(repo, [
      'for-each-ref',
      '--format=%(refname)',
      'refs/heads/factory/',
      'refs/remotes/origin/factory/',
    ])
    if (listing.exitCode !== 0) return err(portError('gone', `git for-each-ref failed in ${repo}`))
    const own = new RegExp(`^(refs/heads/|refs/remotes/origin/)(factory/${escaped(String(issue))}-\\d+)$`)
    const refs = new Map<string, { local: boolean; remote: boolean }>()
    for (const line of listing.stdout.split('\n')) {
      const match = own.exec(line.trim())
      const [, where, name] = match ?? []
      if (!where || !name) continue
      const seen = refs.get(name) ?? { local: false, remote: false }
      refs.set(name, where === 'refs/heads/' ? { ...seen, local: true } : { ...seen, remote: true })
    }

    const base = await originDefaultOf(git, repo)
    const trees = await checkedOut(repo)
    const landed =
      base !== undefined &&
      (
        await Promise.all(
          shipped.map(
            async (sha) =>
              /^[0-9a-f]{7,64}$/.test(sha) &&
              (await raw(repo, ['merge-base', '--is-ancestor', sha, base])).exitCode === 0,
          ),
        )
      ).some(Boolean)

    const result: BranchCleaning = { deleted: [], kept: [] }
    for (const [name, copies] of [...refs].sort(([a], [b]) => a.localeCompare(b))) {
      const keep = (why: string) => result.kept.push({ branch: name, why })
      const tree = trees.get(name)
      if (tree) {
        keep(`checked out in the worktree ${tree}`)
        continue
      }
      const tips = [
        copies.local ? `refs/heads/${name}` : null,
        copies.remote ? `refs/remotes/origin/${name}` : null,
      ].filter((ref): ref is string => ref !== null)
      const settled =
        closed === 'dropped' ||
        closed === 'cancelled' ||
        landed ||
        (base !== undefined && (await everyOnBase(repo, tips, base))) ||
        (await mergedPull(repo, name))
      if (!settled) {
        keep(NOT_MERGED)
        continue
      }
      if (copies.local && (await git(repo, 'branch', '-D', name)) === undefined) {
        keep('git branch -D failed')
        continue
      }
      if (copies.remote) {
        const pushed = await raw(repo, ['push', 'origin', '--delete', name], PUSH_TIMEOUT_MS)
        if (pushed.exitCode !== 0) {
          keep('git push origin --delete failed')
          continue
        }
      }
      result.deleted.push(name)
    }
    return ok(result)
  }

  async function everyOnBase(repo: string, tips: string[], base: string): Promise<boolean> {
    for (const tip of tips) if (!(await refOnBase(git, repo, tip, base))) return false
    return true
  }

  return { clean }
}
