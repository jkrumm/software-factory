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
  /**
   * What review judges: the Issue's own commits as first-parent ranges of `landedAt`, oldest first. A run of own commits that follow each
   * other on the base is one range; commits others landed in between are in none. Empty where nothing is on the base.
   */
  reviewRanges: ReviewRange[]
}

/** `base..head`, as `agw review route|covered` take it. */
export interface ReviewRange {
  base: string
  head: string
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
 * rebased over what others landed is judged by its own commits, found from its reflog (`branchCommits`); where the reflog cannot say, the
 * whole range counts: stricter, never lighter. A merge commit counts as what it brought in. A reported
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
    if (commits.length === 0) return { landedAt, commits, paths: [], mergedAt: null, reviewRanges: [] }

    const unique = await this.pathsOf(repo, full, onBranch)
    const reviewRanges = landedAt && cut ? await this.rangesOf(repo, cut, landedAt, commits) : []
    return { landedAt, commits, paths: unique, mergedAt: await this.newestOf(repo, full), reviewRanges }
  }

  /** Every path the commits touched, sorted: a merge commit counts as what it brought in. */
  private async pathsOf(repo: string, ...groups: string[][]): Promise<string[]> {
    const paths: string[] = []
    for (const shas of groups) {
      if (shas.length === 0) continue
      const log = [
        '-c',
        'core.quotePath=false',
        'log',
        '-m',
        '--no-walk',
        '--first-parent',
        ...shas,
        '--name-only',
        '-z',
        '--format=',
      ]
      const done = await gitIn(repo, log, this.options)
      if (done.exitCode !== 0) throw new Error(`git log failed (exit ${done.exitCode})`)
      paths.push(...done.stdout.split(/[\0\n]/).filter(Boolean))
    }
    return [...new Set(paths)].sort()
  }

  /** The newest committer time of the commits: null where none is named. */
  private async newestOf(repo: string, shas: readonly string[]): Promise<Date | null> {
    if (shas.length === 0) return null
    const times = await gitIn(repo, ['log', '--no-walk', '--format=%ct', ...shas], this.options)
    if (times.exitCode !== 0) throw new Error(`git log failed (exit ${times.exitCode})`)
    return new Date(Math.max(...times.stdout.split('\n').filter(Boolean).map(Number)) * 1000)
  }

  /**
   * The Issue's own commits as ranges of `landedAt`'s first-parent line since `cut`: each commit stands for the first-parent commit that
   * holds it (itself, or the merge that brought it in), and neighbours on that line are one range. A commit that is not an ancestor of
   * `landedAt` (a squashed branch's own commits) is covered by the reported commit that squashed it.
   */
  private async rangesOf(repo: string, cut: string, landedAt: string, own: readonly string[]): Promise<ReviewRange[]> {
    const lines = async (args: string[]): Promise<string[]> => {
      const done = await gitIn(repo, ['rev-list', ...args], this.options)
      if (done.exitCode !== 0) throw new Error(`git rev-list failed (exit ${done.exitCode})`)
      return done.stdout.split('\n').filter(Boolean)
    }
    const line = (await lines(['--first-parent', `${cut}..${landedAt}`])).reverse()
    const index = new Map(line.map((sha, i) => [sha, i]))
    const held = new Set<number>()
    for (const sha of own) {
      const direct = index.get(sha)
      if (direct !== undefined) {
        held.add(direct)
        continue
      }
      const onBase = await gitIn(repo, ['merge-base', '--is-ancestor', sha, landedAt], this.options)
      if (onBase.exitCode !== 0) continue
      const holder = (await lines(['--first-parent', '--ancestry-path', `${sha}..${landedAt}`])).at(-1)
      const at = holder === undefined ? undefined : index.get(holder)
      if (at !== undefined) held.add(at)
    }
    const ranges: ReviewRange[] = []
    let run: { first: number; last: number } | undefined
    const close = () => {
      if (!run) return
      const first = line[run.first]
      const last = line[run.last]
      if (first && last) ranges.push({ base: `${first}^`, head: last })
      run = undefined
    }
    for (const at of [...held].sort((a, b) => a - b)) {
      if (run && at === run.last + 1) run.last = at
      else {
        close()
        run = { first: at, last: at }
      }
    }
    close()
    return Promise.all(
      ranges.map(async ({ base, head }) => {
        const resolved = await gitIn(repo, ['rev-parse', '-q', '--verify', `${base}^{commit}`], this.options)
        if (resolved.exitCode !== 0) throw new Error(`git rev-parse failed (exit ${resolved.exitCode})`)
        return { base: resolved.stdout.trim(), head }
      }),
    )
  }

  /**
   * The lead's own commits on its branch since its worktree was cut: a range that cannot be read fails the verb, it does not lower the bar.
   * A branch rebased over what others landed holds their commits too. Its reflog says what it was rebased onto: what that holds is theirs,
   * except what sat on top of an earlier onto when that rebase finished, and what was made on the branch (a `commit`, `cherry-pick`, `revert`, `am` or `merge` entry; a fast-forward only moved the tip onto others' work); those are
   * its own even where a later rebase put them under a newer onto (it landed part of its work, then went on). A reflog that cannot be read,
   * or no rebase in it, leaves the whole range: stricter, never lighter.
   */
  private async branchCommits({ repo, branch, cut }: ReadInput): Promise<string[]> {
    if (!cut) return []
    const ref = `refs/heads/${branch}`
    const found = await gitIn(repo, ['rev-parse', '-q', '--verify', ref], this.options)
    // One is what `--verify -q` says of a ref that is not there; anything else is a git that failed.
    if (found.exitCode === 1) return []
    if (found.exitCode !== 0) throw new Error(`git rev-parse failed (exit ${found.exitCode})`)
    const listed = await gitIn(repo, ['rev-list', `${cut}..${ref}`], this.options)
    if (listed.exitCode !== 0) throw new Error(`git rev-list failed (exit ${listed.exitCode})`)
    const all = listed.stdout.split('\n').filter(Boolean)
    if (all.length === 0) return all

    const own = await this.ownByReflog(repo, ref, cut, all)
    return own ? all.filter((sha) => own.has(sha)) : all
  }

  /** Which of the branch's commits are its own, from its reflog; undefined where that cannot be told. */
  private async ownByReflog(
    repo: string,
    ref: string,
    cut: string,
    all: readonly string[],
  ): Promise<Set<string> | undefined> {
    const reflog = await gitIn(repo, ['reflog', 'show', '--format=%H %gs', ref], this.options)
    if (reflog.exitCode !== 0) return undefined
    const made = new Set<string>()
    const rebased: { onto: string; tip: string }[] = []
    for (const entry of reflog.stdout.split('\n')) {
      const [tip, ...words] = entry.split(' ')
      const message = words.join(' ')
      if (tip && /^(commit|cherry-pick|revert|am|merge)\b[^:]*:/.test(message) && !message.endsWith(': Fast-forward'))
        made.add(tip)
      const onto = /\(finish\): \S+ onto ([0-9a-f]{40})\b/.exec(message)?.[1]
      if (tip && onto) rebased.push({ onto, tip })
    }
    if (rebased.length === 0) return undefined
    const theirs = await gitIn(
      repo,
      ['rev-list', `${cut}..${ref}`, '--not', ...rebased.map((step) => step.onto)],
      this.options,
    )
    if (theirs.exitCode !== 0) return undefined
    const own = new Set([...theirs.stdout.split('\n').filter(Boolean), ...all.filter((sha) => made.has(sha))])
    for (const step of rebased) {
      const top = await gitIn(repo, ['rev-list', step.tip, '--not', step.onto, cut], this.options)
      if (top.exitCode !== 0) return undefined
      for (const sha of top.stdout.split('\n').filter(Boolean)) own.add(sha)
    }
    return own
  }
}
