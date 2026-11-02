import { branchOnBase, fetchOrigin, gitIn, originDefault, type Run } from './origin.ts'

/** What an Issue's commits touched. */
export interface CommitRead {
  /**
   * `origin/<default>` as it stood when the commits were proven landed: the sha that holds all the branch's work and every commit named.
   * What a deployed version must hold, whatever a squash or rebase did to the branch's own commits. Null where nothing was proven landed.
   */
  landedAt: string | null
  /** the reported commits, full, then what else is on the lead's branch */
  commits: string[]
  /** every path they touched */
  paths: string[]
  /** the newest committer time of the reported commits: evidence must be no older */
  mergedAt: Date | null
}

/** Why the commits cannot count; the answer the lead gets. */
export class CommitsRefused extends Error {}

/** A port, called outside any transaction: `git` with `childEnv()` and a process timeout. */
export interface Commits {
  read(input: ReadInput): Promise<CommitRead>
}

interface ReadInput {
  repo: string
  branch: string
  /** where the lead's worktree was cut */
  cut: string | null
  reported: readonly string[]
  /** `ship`: all the branch holds must be on the base, so an old commit named in its place proves nothing */
  merged?: boolean
}

/**
 * Reads the commits a lead merged: those it reports with `ship`, each of which must be on the remote's default branch, and whatever else
 * is on its branch since the worktree was cut, so the bar is set by what the branch holds and not by what the lead chose to name. A branch
 * rebased over newer work counts those commits too: stricter, never lighter. A merge commit counts as what it brought in. A reported
 * commit older than the cut is refused, and for `ship` so is a branch with work not on the base. What is not known, or not on the base, is
 * looked for once more after a fetch: a pull request merged on GitHub is on no local ref until then.
 */
export class GitCommits implements Commits {
  constructor(private readonly options: { run?: Run; git?: string } = {}) {}

  async read(input: ReadInput): Promise<CommitRead> {
    const { repo, reported, cut } = input
    const git = (args: string[]) => gitIn(repo, args, this.options)
    let fetched = false
    const fetch = async () => {
      if (fetched) return
      fetched = true
      await fetchOrigin(repo, this.options)
    }

    const full: string[] = []
    for (const sha of reported) {
      const resolve = () => git(['rev-parse', '-q', '--verify', `${sha}^{commit}`])
      let known = await resolve()
      if (known.exitCode !== 0) {
        await fetch()
        known = await resolve()
      }
      if (known.exitCode !== 0) throw new CommitsRefused(`commit ${sha} is not in ${repo}: push it first`)
      full.push(known.stdout.trim())
    }

    const onBranch = await this.branchCommits(input)
    const needsBase = input.merged === true && onBranch.length > 0
    /** Which of what must be on the base is not; every call looks at the base as it is now. */
    const lacking = async (): Promise<string | undefined> => {
      if (full.length === 0 && !needsBase) return undefined
      const base = await originDefault(repo, this.options)
      if (!base) return `${repo} has no origin default branch to check the commits against`
      for (const sha of full) {
        if ((await git(['merge-base', '--is-ancestor', sha, base])).exitCode !== 0)
          return `commit ${sha.slice(0, 12)} is not on ${base}: merge it first`
      }
      if (needsBase && !(await branchOnBase(repo, input.branch, base, { ...this.options, reported: full })))
        return `${input.branch} holds work that is not on ${base}: merge it first`
      return undefined
    }
    if (await lacking()) {
      await fetch()
      const reason = await lacking()
      if (reason) throw new CommitsRefused(reason)
    }
    for (const sha of full) {
      // An old commit of the base proves nothing about this attempt.
      if (cut && (await git(['merge-base', '--is-ancestor', sha, cut])).exitCode === 0)
        throw new CommitsRefused(`commit ${sha.slice(0, 12)} is older than this attempt`)
    }

    let landedAt: string | null = null
    if (full.length > 0 || needsBase) {
      const base = await originDefault(repo, this.options)
      const tip = base ? await git(['rev-parse', '-q', '--verify', `${base}^{commit}`]) : undefined
      if (tip?.exitCode === 0) landedAt = tip.stdout.trim()
    }

    const commits = [...new Set([...full, ...onBranch])]
    if (commits.length === 0) return { landedAt, commits, paths: [], mergedAt: null }

    const named = async (...range: string[]) => {
      const log = ['-c', 'core.quotePath=false', 'log', '-m', ...range, '--name-only', '-z', '--format=']
      const done = await git(log)
      if (done.exitCode !== 0) throw new Error(`git log failed (exit ${done.exitCode})`)
      return done.stdout.split(/[\0\n]/).filter(Boolean)
    }
    const paths = [
      ...(full.length > 0 ? await named('--no-walk', '--first-parent', ...full) : []),
      ...(onBranch.length > 0 ? await named(`${cut}..refs/heads/${input.branch}`) : []),
    ]
    const unique = [...new Set(paths)].sort()

    if (full.length === 0) return { landedAt, commits, paths: unique, mergedAt: null }
    const times = await git(['log', '--no-walk', '--format=%ct', ...full])
    if (times.exitCode !== 0) throw new Error(`git log failed (exit ${times.exitCode})`)
    const newest = Math.max(...times.stdout.split('\n').filter(Boolean).map(Number))
    return { landedAt, commits, paths: unique, mergedAt: new Date(newest * 1000) }
  }

  /** The lead's branch since its worktree was cut, all of it: a range that cannot be read fails the verb, it does not lower the bar. */
  private async branchCommits({ repo, branch, cut }: ReadInput): Promise<string[]> {
    if (!cut) return []
    const ref = `refs/heads/${branch}`
    const found = await gitIn(repo, ['rev-parse', '-q', '--verify', ref], this.options)
    // One is what `--verify -q` says of a ref that is not there; anything else is a git that failed.
    if (found.exitCode === 1) return []
    if (found.exitCode !== 0) throw new Error(`git rev-parse failed (exit ${found.exitCode})`)
    const listed = await gitIn(repo, ['rev-list', `${cut}..${ref}`], this.options)
    if (listed.exitCode !== 0) throw new Error(`git rev-list failed (exit ${listed.exitCode})`)
    return listed.stdout.split('\n').filter(Boolean)
  }
}
