import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CommitRead, deploys, type ReviewRange } from '../../domains/quality/evidence.ts'
import type { Commits } from '../../domains/quality/ports.ts'
import { err, ok, portError, type Result } from '../../kernel/result.ts'
import { CannotExecute, childEnv, EXIT_TIMEOUT, type Run, runProcess } from './process.ts'

const GIT_TIMEOUT_MS = 30_000
const FETCH_TIMEOUT_MS = 30_000

export interface GitOptions {
  run?: Run
  git?: string
  signal?: AbortSignal
}

export class GitTimeout extends Error {}

/** Why the commits cannot count; the answer the lead gets. */
class CommitsRefused extends Error {}

/** Git in a repo: no prompt, the server's secrets left out, a process timeout. A timeout throws; an exit code is the caller's. */
export async function gitIn(
  repo: string,
  args: string[],
  options: GitOptions & { timeoutMs?: number } = {},
): Promise<{ exitCode: number; stdout: string }> {
  const run = options.run ?? runProcess
  const done = await run([options.git ?? 'git', '-C', repo, ...args], options.timeoutMs ?? GIT_TIMEOUT_MS, {
    env: childEnv({ GIT_TERMINAL_PROMPT: '0' }),
    ...(options.signal ? { group: true, signal: options.signal } : {}),
  })
  if (done.exitCode === EXIT_TIMEOUT) throw new GitTimeout(`git ${args[0]} did not finish in time`)
  return done
}

/** Asks the remote what it has now. False when it could not: what the last fetch left is then the best there is. */
const fetchOrigin = async (repo: string, options: GitOptions): Promise<boolean> => {
  const done = await gitIn(repo, ['fetch', '-q', 'origin'], { ...options, timeoutMs: FETCH_TIMEOUT_MS }).catch(
    () => undefined,
  )
  return done?.exitCode === 0
}

/**
 * The remote's default branch as last fetched, `origin/<it>`. Never the local branch: a checkout that is behind says
 * nothing about what was merged.
 */
async function originDefault(repo: string, options: GitOptions): Promise<string | undefined> {
  const head = await gitIn(repo, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], options)
  if (head.exitCode === 0 && head.stdout.trim()) return head.stdout.trim()
  for (const candidate of ['origin/master', 'origin/main']) {
    const found = await gitIn(repo, ['rev-parse', '-q', '--verify', candidate], options)
    if (found.exitCode === 0) return candidate
  }
  return undefined
}

const lines = (text: string): string[] => text.split('\n').filter(Boolean)

/**
 * A repo's main checkout as it is now, from local refs only (no fetch): the branch (null: a detached HEAD), the remote's
 * default branch as last fetched (null when unknown), and the paths with tracked uncommitted changes (untracked files
 * are not changes). A git that fails throws; `GitMainCheckouts` maps it.
 */
export async function readMainCheckout(
  repo: string,
  options: GitOptions = {},
): Promise<{ branch: string | null; defaultBranch: string | null; dirty: string[] }> {
  const head = await gitIn(repo, ['symbolic-ref', '-q', '--short', 'HEAD'], options)
  // Exit 1 is what `-q` says of a detached HEAD; anything else is a git that failed.
  if (head.exitCode !== 0 && head.exitCode !== 1) throw new Error(`git symbolic-ref failed (exit ${head.exitCode})`)
  const status = await gitIn(
    repo,
    ['--no-optional-locks', '-c', 'core.quotePath=false', 'status', '--porcelain', '-z', '--untracked-files=no'],
    options,
  )
  if (status.exitCode !== 0) throw new Error(`git status failed (exit ${status.exitCode})`)
  const base = await originDefault(repo, options)
  return {
    branch: head.exitCode === 0 && head.stdout.trim() ? head.stdout.trim() : null,
    defaultBranch: base ? base.replace(/^origin\//, '') : null,
    dirty: dirtyPaths(status.stdout),
  }
}

/** `XY path` entries of `status --porcelain -z`; a rename or copy (R or C) carries its source as the next entry, which is skipped. */
function dirtyPaths(porcelain: string): string[] {
  const entries = porcelain.split('\0').filter(Boolean)
  const paths: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? ''
    paths.push(entry.slice(3))
    if (/[RC]/.test(entry.slice(0, 2))) i++
  }
  return paths
}

/**
 * Whether what the lead reported as merged is what the branch holds: every file the branch changes is, at a reported
 * commit that is on the base and newer than the branch's fork point, exactly as the branch has it. Content, so a commit
 * that merely touches the same files proves nothing. What decides a squash whose lines moved on since, where a
 * three-way merge conflicts and says nothing. Anything git cannot answer is no proof.
 */
async function landedAs(
  repo: string,
  ref: string,
  base: string,
  reported: readonly string[],
  options: GitOptions,
): Promise<boolean> {
  const git = (args: string[]) => gitIn(repo, args, options)
  const fork = await git(['merge-base', base, ref])
  if (fork.exitCode !== 0) return false
  const onBase: string[] = []
  for (const sha of reported) {
    if ((await git(['merge-base', '--is-ancestor', sha, base])).exitCode !== 0) continue
    const newer = await git(['rev-list', '--count', '--ancestry-path', `${fork.stdout.trim()}..${sha}`])
    if (newer.exitCode === 0 && Number(newer.stdout.trim()) > 0) onBase.push(sha)
  }
  if (onBase.length === 0) return false
  const changed = async (from: string): Promise<Set<string> | undefined> => {
    const done = await git(['-c', 'core.quotePath=false', 'diff', '--no-renames', '--name-only', '-z', from, ref])
    return done.exitCode === 0 ? new Set(done.stdout.split('\0').filter(Boolean)) : undefined
  }
  const own = await changed(fork.stdout.trim())
  if (!own) return false
  const differing = await Promise.all(onBase.map(changed))
  if (differing.some((set) => set === undefined)) return false
  return [...own].every((path) => differing.some((set) => !set?.has(path)))
}

/** Whether all a branch holds is on the base: by commit, by content (a merge that changes nothing), or as the commits reported. */
async function branchOnBase(
  repo: string,
  branch: string,
  base: string,
  reported: readonly string[],
  options: GitOptions,
): Promise<boolean> {
  const ref = `refs/heads/${branch}`
  const git = (args: string[]) => gitIn(repo, args, options)
  if ((await git(['rev-parse', '-q', '--verify', ref])).exitCode !== 0) return true
  const ahead = await git(['rev-list', '--count', ref, '--not', base])
  if (ahead.exitCode === 0 && ahead.stdout.trim() === '0') return true
  const merged = await git(['merge-tree', '--write-tree', base, ref])
  const tree = await git(['rev-parse', `${base}^{tree}`])
  if (merged.exitCode === 0 && merged.stdout.trim() === tree.stdout.trim()) return true
  return landedAs(repo, ref, base, reported, options)
}

/**
 * Reads the commits a ship names: each must exist and be on the remote's default branch (looked for again after a
 * fetch, because a pull request merged on GitHub is on no local ref until then) and be newer than the lead's worktree
 * cut. What else the lead's branch holds counts too, and all of it must be on the base, so the commits a lead names do
 * not set the bar. A branch rebased over what others landed is judged by its own commits, found from its reflog; where
 * the reflog cannot say, the whole range counts: stricter, never lighter.
 */
export class GitCommits implements Commits {
  constructor(private readonly options: { run?: Run; git?: string } = {}) {}

  async read(input: Parameters<Commits['read']>[0]): Promise<Result<CommitRead>> {
    try {
      return ok(await this.readOrThrow(input))
    } catch (error) {
      if (error instanceof CommitsRefused) return err(portError('refused', error.message))
      if (error instanceof CannotExecute) return err(portError('gone', error.message))
      const detail = error instanceof Error ? error.message : String(error)
      return err(portError(error instanceof GitTimeout ? 'timeout' : 'unreadable', detail))
    }
  }

  private async readOrThrow({ repo, branch, cut, reported }: Parameters<Commits['read']>[0]): Promise<CommitRead> {
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

    const onBranch = branch && cut ? await this.branchCommits(repo, branch, cut) : []
    const needsBase = onBranch.length > 0
    /** Which of what must be on the base is not; every call looks at the base as it is now. */
    const lacking = async (): Promise<string | undefined> => {
      const base = await originDefault(repo, this.options)
      if (!base) return `${repo} has no origin default branch to check the commits against`
      for (const sha of full) {
        if ((await git(['merge-base', '--is-ancestor', sha, base])).exitCode !== 0)
          return `commit ${sha.slice(0, 12)} is not on ${base}: merge it first`
      }
      if (needsBase && branch && !(await branchOnBase(repo, branch, base, full, this.options)))
        return `${branch} holds work that is not on ${base}: merge it first`
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

    const base = await originDefault(repo, this.options)
    const tip = base ? await git(['rev-parse', '-q', '--verify', `${base}^{commit}`]) : undefined
    const landedAt = tip?.exitCode === 0 ? tip.stdout.trim() : null

    const commits = [...new Set([...full, ...onBranch])]
    const paths = await this.pathsOf(repo, full, onBranch)
    // Without a cut (no worktree on record) the ship's range starts at the parent of the oldest commit it names.
    const from = cut ?? (await this.parentOfOldest(repo, full))
    const reviewRanges = landedAt && from ? await this.rangesOf(repo, from, landedAt, commits, onBranch) : []
    return { landedAt, commits, paths, mergedAt: await this.newestOf(repo, full), reviewRanges }
  }

  /** Every path the commits touched, sorted: a merge commit counts as what it brought in. */
  private async pathsOf(repo: string, ...groups: string[][]): Promise<string[]> {
    const paths: string[] = []
    for (const shas of groups) {
      if (shas.length === 0) continue
      const done = await gitIn(
        repo,
        [
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
        ],
        this.options,
      )
      if (done.exitCode !== 0) throw new Error(`git log failed (exit ${done.exitCode})`)
      paths.push(...done.stdout.split(/[\0\n]/).filter(Boolean))
    }
    return [...new Set(paths)].sort()
  }

  /** The newest committer time of the commits. */
  private async newestOf(repo: string, shas: readonly string[]): Promise<Date | null> {
    if (shas.length === 0) return null
    const times = await gitIn(repo, ['log', '--no-walk', '--format=%ct', ...shas], this.options)
    if (times.exitCode !== 0) throw new Error(`git log failed (exit ${times.exitCode})`)
    return new Date(Math.max(...lines(times.stdout).map(Number)) * 1000)
  }

  /** The first parent of the oldest commit named (the one with the fewest ancestors); null for a root commit. */
  private async parentOfOldest(repo: string, shas: readonly string[]): Promise<string | null> {
    let oldest: { sha: string; ancestors: number } | undefined
    for (const sha of shas) {
      const count = await gitIn(repo, ['rev-list', '--count', sha], this.options)
      const ancestors = Number(count.stdout.trim())
      if (count.exitCode === 0 && (!oldest || ancestors < oldest.ancestors)) oldest = { sha, ancestors }
    }
    if (!oldest) return null
    const parent = await gitIn(repo, ['rev-parse', '-q', '--verify', `${oldest.sha}^`], this.options)
    return parent.exitCode === 0 ? parent.stdout.trim() : null
  }

  /**
   * The Issue's own commits as ranges of `landedAt`'s first-parent line since `cut`: each commit stands for the
   * first-parent commit that holds it (itself, or the merge that brought it in), and neighbours on that line are one
   * range. A commit that is not an ancestor of `landedAt` is a squashed branch's own commit, and a review is bound to
   * the commits it judged, never to the squash commit (its tree and ancestry are not the reviewed head's): where a
   * commit on the line changed exactly the paths those commits did, it is the squash, and the range to review is the
   * branch's own commits instead. Where none matches, the commit on the line stays the range: stricter, never lighter.
   */
  private async rangesOf(
    repo: string,
    cut: string,
    landedAt: string,
    own: readonly string[],
    onBranch: readonly string[],
  ): Promise<ReviewRange[]> {
    const listed = async (args: string[]): Promise<string[]> => {
      const done = await gitIn(repo, ['rev-list', ...args], this.options)
      if (done.exitCode !== 0) throw new Error(`git rev-list failed (exit ${done.exitCode})`)
      return lines(done.stdout)
    }
    const line = (await listed(['--first-parent', `${cut}..${landedAt}`])).reverse()
    const index = new Map(line.map((sha, i) => [sha, i]))
    const held = new Set<number>()
    const squashed: string[] = []
    for (const sha of own) {
      const direct = index.get(sha)
      if (direct !== undefined) {
        held.add(direct)
        continue
      }
      const onBase = await gitIn(repo, ['merge-base', '--is-ancestor', sha, landedAt], this.options)
      if (onBase.exitCode !== 0) {
        if (onBranch.includes(sha)) squashed.push(sha)
        continue
      }
      const holder = (await listed(['--first-parent', '--ancestry-path', `${sha}..${landedAt}`])).at(-1)
      const at = holder === undefined ? undefined : index.get(holder)
      if (at !== undefined) held.add(at)
    }
    const branchRange = await this.takeSquashes(repo, cut, { line, held, squashed })
    const ranges = await this.runsOf(repo, line, held)
    return branchRange ? [...ranges, branchRange] : ranges
  }

  /**
   * Removes from `held` the first commit on the line that is the squash of `squashed` (it changed exactly its paths) and
   * returns the branch's range to review in its place; null, and `held` untouched, where none is.
   */
  private async takeSquashes(
    repo: string,
    cut: string,
    { line, held, squashed }: { line: readonly string[]; held: Set<number>; squashed: readonly string[] },
  ): Promise<ReviewRange | null> {
    const branchRange = await this.squashedRange(repo, cut, squashed)
    if (!branchRange) return null
    for (const at of [...held].sort((a, b) => a - b)) {
      const sha = line[at]
      if (!sha || !(await this.samePaths(repo, { base: `${sha}^`, head: sha }, branchRange))) continue
      // One squash stands for the branch; a later commit with the same paths is not it and keeps its own range.
      held.delete(at)
      return branchRange
    }
    return null
  }

  /** The held positions of the line, neighbours as one range each. */
  private async runsOf(repo: string, line: readonly string[], held: ReadonlySet<number>): Promise<ReviewRange[]> {
    const runs: { first: number; last: number }[] = []
    for (const at of [...held].sort((a, b) => a - b)) {
      const run = runs.at(-1)
      if (run && at === run.last + 1) run.last = at
      else runs.push({ first: at, last: at })
    }
    const ranges: ReviewRange[] = []
    for (const { first, last } of runs) {
      const start = line[first]
      const head = line[last]
      if (!start || !head) continue
      const resolved = await gitIn(repo, ['rev-parse', '-q', '--verify', `${start}^`], this.options)
      if (resolved.exitCode !== 0) throw new Error(`git rev-parse failed (exit ${resolved.exitCode})`)
      ranges.push({ base: resolved.stdout.trim(), head })
    }
    return ranges
  }

  /** The squashed branch commits as one range: from the parent of the oldest to the newest, in the branch's own order. */
  private async squashedRange(repo: string, cut: string, squashed: readonly string[]): Promise<ReviewRange | null> {
    if (squashed.length === 0) return null
    const ordered = await gitIn(
      repo,
      ['rev-list', '--topo-order', '--reverse', ...squashed, '--not', cut],
      this.options,
    )
    if (ordered.exitCode !== 0) throw new Error(`git rev-list failed (exit ${ordered.exitCode})`)
    const mine = lines(ordered.stdout).filter((sha) => squashed.includes(sha))
    const oldest = mine[0]
    const head = mine.at(-1)
    if (!oldest || !head) return null
    const parent = await gitIn(repo, ['rev-parse', '-q', '--verify', `${oldest}^`], this.options)
    return parent.exitCode === 0 ? { base: parent.stdout.trim(), head } : null
  }

  /** Whether two ranges changed exactly the same paths. */
  private async samePaths(repo: string, a: ReviewRange, b: ReviewRange): Promise<boolean> {
    const changed = async ({ base, head }: ReviewRange): Promise<string | null> => {
      const done = await gitIn(
        repo,
        ['-c', 'core.quotePath=false', 'diff', '--no-renames', '--name-only', '-z', base, head],
        this.options,
      )
      return done.exitCode === 0 ? done.stdout : null
    }
    const [one, two] = await Promise.all([changed(a), changed(b)])
    return one !== null && one !== '' && one === two
  }

  /**
   * The lead's own commits on its branch since its worktree was cut. A branch rebased over what others landed holds
   * their commits too; its reflog says what it was rebased onto, and what that holds is theirs, except what sat on top
   * of an earlier onto and what was made on the branch. A reflog that cannot be read, or no rebase in it, leaves the
   * whole range.
   */
  private async branchCommits(repo: string, branch: string, cut: string): Promise<string[]> {
    const ref = `refs/heads/${branch}`
    const found = await gitIn(repo, ['rev-parse', '-q', '--verify', ref], this.options)
    // One is what `--verify -q` says of a ref that is not there; anything else is a git that failed.
    if (found.exitCode === 1) return []
    if (found.exitCode !== 0) throw new Error(`git rev-parse failed (exit ${found.exitCode})`)
    const listed = await gitIn(repo, ['rev-list', `${cut}..${ref}`], this.options)
    if (listed.exitCode !== 0) throw new Error(`git rev-list failed (exit ${listed.exitCode})`)
    const all = lines(listed.stdout)
    if (all.length === 0) return all
    const own = await this.ownByReflog(repo, ref, cut, all)
    return own ? all.filter((sha) => own.has(sha)) : all
  }

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
    const own = new Set([...lines(theirs.stdout), ...all.filter((sha) => made.has(sha))])
    for (const step of rebased) {
      const top = await gitIn(repo, ['rev-list', step.tip, '--not', step.onto, cut], this.options)
      if (top.exitCode !== 0) return undefined
      for (const sha of lines(top.stdout)) own.add(sha)
    }
    return own
  }
}

export interface CheckoutSync {
  /** `advanced`: fast-forwarded; `current`: nothing to pull; `unknown`: no answer from the remote; `blocked`: behind and not ours to move */
  state: 'current' | 'advanced' | 'unknown' | 'blocked'
  detail: string
  /** on `blocked`: the remote's default branch (`origin/<it>`) a throwaway worktree can read instead of the owner's checkout */
  ref?: string
}

const firstLine = (text: string): string => text.trim().split('\n')[0]?.trim() ?? ''

/**
 * Brings the repo's main checkout up to `origin/<default>` for a check that reads it (`make verify`, `make version`).
 * Fast-forward only: a checkout that is not on the default branch, has a tracked change, or has commits the remote
 * lacks is the owner's and is never touched (`blocked`). No remote answer is `unknown`, and the check goes on with
 * what is there.
 */
export async function syncCheckout(repo: string, options: GitOptions = {}): Promise<CheckoutSync> {
  const git = (args: string[]) => gitIn(repo, args, options)
  if (!(await fetchOrigin(repo, options))) return { state: 'unknown', detail: `could not fetch origin for ${repo}` }
  const remote = await originDefault(repo, options)
  if (!remote) return { state: 'unknown', detail: `${repo} has no origin default branch` }
  const count = async (range: string): Promise<number | undefined> => {
    const done = await git(['rev-list', '--count', range])
    const n = Number(done.stdout.trim())
    return done.exitCode === 0 && Number.isInteger(n) ? n : undefined
  }
  const behind = await count(`HEAD..${remote}`)
  const ahead = await count(`${remote}..HEAD`)
  if (behind === undefined || ahead === undefined)
    return { state: 'unknown', detail: `could not compare ${repo} with ${remote}` }
  if (behind === 0) return { state: 'current', detail: `${repo} holds ${remote}` }

  const branch = remote.slice(remote.indexOf('/') + 1)
  const head = await git(['symbolic-ref', '-q', '--short', 'HEAD'])
  const on = head.exitCode === 0 ? head.stdout.trim() : ''
  if (on !== branch) {
    return {
      state: 'blocked',
      ref: remote,
      detail: `${repo} is ${on ? `on branch ${on}` : 'on a detached HEAD'}, not ${branch}, and ${behind} commits behind ${remote}`,
    }
  }
  const status = await git(['status', '--porcelain', '--untracked-files=no'])
  if (status.exitCode !== 0 || status.stdout.trim()) {
    const paths = lines(status.stdout).map((line) => line.slice(3))
    const shown = paths.slice(0, 3).join(', ')
    return {
      state: 'blocked',
      ref: remote,
      detail: `${repo} has uncommitted changes (${shown}${paths.length > 3 ? ', …' : ''}) and is ${behind} commits behind ${remote}`,
    }
  }
  if (ahead > 0)
    return {
      state: 'blocked',
      ref: remote,
      detail: `${repo} diverged from ${remote}: ${ahead} ahead, ${behind} behind`,
    }
  const merged = await git(['merge', '--ff-only', remote])
  if (merged.exitCode !== 0) {
    return {
      state: 'blocked',
      ref: remote,
      detail: `${repo} could not fast-forward to ${remote}: ${firstLine(merged.stdout) || `git exit ${merged.exitCode}`}`,
    }
  }
  const sha = await git(['rev-parse', 'HEAD'])
  return { state: 'advanced', detail: `fast-forwarded ${repo} ${behind} commits to ${sha.stdout.trim().slice(0, 12)}` }
}

/**
 * Runs `work` in a throwaway detached worktree of `ref` (a checkout the factory may not move is not where a check reads
 * the shipped commit). The worktree is gone when `work` returns or throws. Undefined: it could not be made.
 */
export async function inScratchWorktree<T>(
  repo: string,
  ref: string,
  work: (path: string) => Promise<T>,
  options: GitOptions = {},
): Promise<T | undefined> {
  const base = await mkdtemp(join(tmpdir(), 'factory-verify-'))
  const path = join(base, 'tree')
  try {
    const added = await gitIn(repo, ['worktree', 'add', '--detach', '-q', path, ref], options).catch(() => undefined)
    if (added?.exitCode !== 0) return undefined
    return await work(path)
  } finally {
    await gitIn(repo, ['worktree', 'remove', '--force', path], options).catch(() => undefined)
    await gitIn(repo, ['worktree', 'prune'], options).catch(() => undefined)
    await rm(base, { recursive: true, force: true })
  }
}

/**
 * Whether the deployed commit `make version` printed holds `landedAt`, the `origin/<default>` the ship found: that sha
 * is the deployed one or an ancestor of it. Only reads: a deployed commit the repo has not seen yet is fetched for.
 * `merge-base --is-ancestor` says 1 for "not an ancestor"; any other exit is a git that could not compare, which is not
 * the same as "not deployed".
 */
export async function deployedHolds(
  repo: string,
  deployed: string,
  landedAt: string,
  options: GitOptions = {},
): Promise<{ ok: boolean; detail: string }> {
  const git = (args: string[]) => gitIn(repo, args, options)
  const resolve = (ref: string) => git(['rev-parse', '-q', '--verify', `${ref}^{commit}`])
  let known = await resolve(deployed)
  if (known.exitCode !== 0) {
    await fetchOrigin(repo, options)
    known = await resolve(deployed)
  }
  if (known.exitCode !== 0) return { ok: false, detail: `the deployed commit ${deployed} is not in ${repo}` }
  const full = known.stdout.trim()
  const landed = await resolve(landedAt)
  if (landed.exitCode !== 0)
    return { ok: false, detail: `could not compare: ${landedAt.slice(0, 12)} is not in ${repo}` }
  const compared = await git(['merge-base', '--is-ancestor', landedAt, full])
  if (compared.exitCode === 0)
    return { ok: true, detail: `deployed ${full.slice(0, 12)} holds ${landedAt.slice(0, 12)}, where the work landed` }
  if (compared.exitCode === 1) {
    // `landedAt` is the default branch's tip, so a docs commit pushed after the merge sits in it and is never deployed:
    // behind it only by paths no deploy carries is the same as holding it (what `scripts/verify.sh` reads too).
    const behind = await git(['merge-base', '--is-ancestor', full, landedAt])
    if (behind.exitCode === 0) {
      const changed = await git(['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', full, landedAt])
      if (changed.exitCode === 0 && !deploys(changed.stdout.split('\0').filter(Boolean))) {
        return {
          ok: true,
          detail: `deployed ${full.slice(0, 12)} is behind ${landedAt.slice(0, 12)}, where the work landed, only by changes no deploy carries`,
        }
      }
    }
    return {
      ok: false,
      detail: `deployed ${full.slice(0, 12)} does not hold ${landedAt.slice(0, 12)}, where the work landed: \`make deploy\` has not run on it`,
    }
  }
  return { ok: false, detail: `could not compare: git merge-base exit ${compared.exitCode}` }
}
