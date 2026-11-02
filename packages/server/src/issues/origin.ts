import { childEnv, EXIT_TIMEOUT, runProcess } from '../exec.ts'

/** The process runner, for tests that want to count or break it. */
export type Run = typeof runProcess

const GIT_TIMEOUT_MS = 30_000
export const FETCH_TIMEOUT_MS = 30_000

/** Git in a repo: `GIT_TERMINAL_PROMPT=0`, the server's secrets left out, a process timeout. A timeout throws; an exit code is the caller's. */
export async function gitIn(
  repo: string,
  args: string[],
  options: { run?: Run; timeoutMs?: number; git?: string; signal?: AbortSignal } = {},
): Promise<{ exitCode: number; stdout: string }> {
  const run = options.run ?? runProcess
  const done = await run(
    [options.git ?? 'git', '-C', repo, ...args],
    options.timeoutMs ?? GIT_TIMEOUT_MS,
    childEnv({ GIT_TERMINAL_PROMPT: '0' }),
    undefined,
    // With a signal (the server is stopping) a kill reaches what git started.
    options.signal ? { group: true, signal: options.signal } : undefined,
  )
  if (done.exitCode === EXIT_TIMEOUT) throw new Error(`git ${args[0]} did not finish in time`)
  return done
}

/** Asks the remote what it has now. False when it could not: what the last fetch left is then the best there is. */
export const fetchOrigin = async (
  repo: string,
  options: { run?: Run; git?: string; signal?: AbortSignal } = {},
): Promise<boolean> => {
  const done = await gitIn(repo, ['fetch', '-q', 'origin'], { ...options, timeoutMs: FETCH_TIMEOUT_MS }).catch(
    () => undefined,
  )
  return done?.exitCode === 0
}

/**
 * Whether what the lead reported as merged is what the branch holds: every file the branch changes is, at a reported commit that is on the
 * base and newer than the branch's fork point, exactly as the branch has it. Content, so a commit that merely touches the same files proves nothing and more work after a partial
 * merge is still work. What decides a squash whose lines moved on since, where a three-way merge conflicts and says nothing about
 * whether the work landed. Anything git cannot answer is no proof: a wrong yes here deletes a branch.
 */
async function landedAs(
  repo: string,
  ref: string,
  base: string,
  reported: readonly string[],
  options: { run?: Run; git?: string },
): Promise<boolean> {
  const git = (args: string[]) => gitIn(repo, args, options)
  const fork = await git(['merge-base', base, ref])
  if (fork.exitCode !== 0) return false
  // On the base and strictly newer than where the branch forked: a commit from before it can equal a branch that deletes or reverts
  // what the commit lacked, and that proves nothing landed.
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

/**
 * Whether all a branch holds is on the base: by commit; by content, a merge of it that changes nothing; or as the commits the lead
 * reported as merged. A conflict alone says nothing: later commits on the same lines conflict with a squash that landed.
 */
export async function branchOnBase(
  repo: string,
  branch: string,
  base: string,
  options: { run?: Run; git?: string; reported?: readonly string[] } = {},
): Promise<boolean> {
  const ref = `refs/heads/${branch}`
  const git = (args: string[]) => gitIn(repo, args, options)
  if ((await git(['rev-parse', '-q', '--verify', ref])).exitCode !== 0) return true
  const ahead = await git(['rev-list', '--count', ref, '--not', base])
  if (ahead.exitCode === 0 && ahead.stdout.trim() === '0') return true
  const merged = await git(['merge-tree', '--write-tree', base, ref])
  const tree = await git(['rev-parse', `${base}^{tree}`])
  if (merged.exitCode === 0 && merged.stdout.trim() === tree.stdout.trim()) return true
  return landedAs(repo, ref, base, options.reported ?? [], options)
}

/**
 * The remote's default branch as last fetched, `origin/<it>`. Never the local branch: a checkout that is behind says nothing about
 * what was merged. `origin/HEAD` names it; a clone without one has `origin/master` or `origin/main`.
 */
export async function originDefault(
  repo: string,
  options: { run?: Run; git?: string } = {},
): Promise<string | undefined> {
  const head = await gitIn(repo, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], options)
  if (head.exitCode === 0 && head.stdout.trim()) return head.stdout.trim()
  for (const candidate of ['origin/master', 'origin/main']) {
    const found = await gitIn(repo, ['rev-parse', '-q', '--verify', candidate], options)
    if (found.exitCode === 0) return candidate
  }
  return undefined
}

export interface DeployedCheck {
  ok: boolean
  /** what was found, in words the lead reads as the reason of a red check */
  detail: string
}

/**
 * Whether the deployed commit `make version` printed holds `landedAt`, the `origin/<default>` the ship found: that sha is the deployed
 * one or an ancestor of it. One sha, whatever a squash or rebase did to the branch's commits. Only reads: a deployed commit the repo has
 * not seen yet is fetched for, which writes remote refs and objects and touches no index or working tree. `merge-base --is-ancestor` says
 * 1 for "not an ancestor"; any other exit is a git that could not compare, which is not the same as "not deployed".
 */
export async function deployedHolds(
  repo: string,
  deployed: string,
  landedAt: string,
  options: { run?: Run; git?: string; signal?: AbortSignal } = {},
): Promise<DeployedCheck> {
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
  if (compared.exitCode === 1)
    return {
      ok: false,
      detail: `deployed ${full.slice(0, 12)} does not hold ${landedAt.slice(0, 12)}, where the work landed: \`make deploy\` has not run on it`,
    }
  return { ok: false, detail: `could not compare: git merge-base exit ${compared.exitCode}` }
}
