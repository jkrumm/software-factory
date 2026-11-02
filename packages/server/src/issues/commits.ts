import { fetchOrigin, gitIn, originDefault, type Run } from './origin.ts'

/** What an Issue's commits touched. */
export interface CommitRead {
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
  read(input: { repo: string; branch: string; cut: string | null; reported: readonly string[] }): Promise<CommitRead>
}

/** More than any lead's branch has; a rebase over a busy base is cut here, and what the reported commits touched still counts. */
const MAX_BRANCH_COMMITS = 200

/** `git log` asked for every commit at once, with no walk: the commits are listed, not their history. */
const logOf = (shas: readonly string[], ...format: string[]) => ['log', '--no-walk', ...format, ...shas]

/**
 * Reads the commits a lead merged: those it reports with `ship`, each of which must be on the remote's default branch, and whatever else
 * is on its branch since the worktree was cut, so the bar is set by what the branch holds and not by what the lead chose to name. A branch
 * rebased over newer work counts those commits too: stricter, never lighter. A merge commit counts as what it brought in. A commit that
 * is not known, or not on the base, is looked for once more after a fetch: a pull request merged on GitHub is on no local ref until then.
 */
export class GitCommits implements Commits {
  constructor(private readonly options: { run?: Run; git?: string } = {}) {}

  async read(input: {
    repo: string
    branch: string
    cut: string | null
    reported: readonly string[]
  }): Promise<CommitRead> {
    const { repo, reported } = input
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

    if (full.length > 0) {
      let base = await originDefault(repo, this.options)
      const merged = async (sha: string) =>
        base ? (await git(['merge-base', '--is-ancestor', sha, base])).exitCode === 0 : false
      if (!base || !(await Promise.all(full.map(merged))).every(Boolean)) {
        await fetch()
        base = await originDefault(repo, this.options)
      }
      if (!base) throw new CommitsRefused(`${repo} has no origin default branch to check the commits against`)
      for (const sha of full) {
        if (!(await merged(sha)))
          throw new CommitsRefused(`commit ${sha.slice(0, 12)} is not on ${base}: merge it first`)
      }
    }

    const onBranch = await this.branchCommits(input)
    const commits = [...new Set([...full, ...onBranch])]
    if (commits.length === 0) return { commits, paths: [], mergedAt: null }

    const named = await git([
      '-c',
      'core.quotePath=false',
      ...logOf(commits, '-m', '--first-parent', '--name-only', '-z', '--format='),
    ])
    if (named.exitCode !== 0) throw new Error(`git log failed (exit ${named.exitCode})`)
    const paths = [...new Set(named.stdout.split(/[\0\n]/).filter(Boolean))].sort()

    if (full.length === 0) return { commits, paths, mergedAt: null }
    const times = await git(logOf(full, '--format=%ct'))
    if (times.exitCode !== 0) throw new Error(`git log failed (exit ${times.exitCode})`)
    const newest = Math.max(...times.stdout.split('\n').filter(Boolean).map(Number))
    return { commits, paths, mergedAt: new Date(newest * 1000) }
  }

  /** The lead's branch since its worktree was cut. No branch, or no cut to count from, is no commits. */
  private async branchCommits({ repo, branch, cut }: { repo: string; branch: string; cut: string | null }) {
    if (!cut) return []
    const range = `${cut}..refs/heads/${branch}`
    const listed = await gitIn(repo, ['rev-list', `--max-count=${MAX_BRANCH_COMMITS}`, range], this.options)
    return listed.exitCode === 0 ? listed.stdout.split('\n').filter(Boolean) : []
  }
}
