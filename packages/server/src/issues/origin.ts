import { childEnv, EXIT_TIMEOUT, runProcess } from '../exec.ts'

/** The process runner, for tests that want to count or break it. */
export type Run = typeof runProcess

const GIT_TIMEOUT_MS = 30_000
export const FETCH_TIMEOUT_MS = 30_000

/** Git in a repo: `GIT_TERMINAL_PROMPT=0`, the server's secrets left out, a process timeout. A timeout throws; an exit code is the caller's. */
export async function gitIn(
  repo: string,
  args: string[],
  options: { run?: Run; timeoutMs?: number; git?: string } = {},
): Promise<{ exitCode: number; stdout: string }> {
  const run = options.run ?? runProcess
  const done = await run(
    [options.git ?? 'git', '-C', repo, ...args],
    options.timeoutMs ?? GIT_TIMEOUT_MS,
    childEnv({ GIT_TERMINAL_PROMPT: '0' }),
  )
  if (done.exitCode === EXIT_TIMEOUT) throw new Error(`git ${args[0]} did not finish in time`)
  return done
}

/** Asks the remote what it has now. False when it could not: what the last fetch left is then the best there is. */
export const fetchOrigin = async (repo: string, options: { run?: Run; git?: string } = {}): Promise<boolean> => {
  const done = await gitIn(repo, ['fetch', '-q', 'origin'], { ...options, timeoutMs: FETCH_TIMEOUT_MS }).catch(
    () => undefined,
  )
  return done?.exitCode === 0
}

/** Whether all a branch holds is on the base: by commit, or by content (a squash merge leaves no commit of the branch behind). */
export async function branchOnBase(
  repo: string,
  branch: string,
  base: string,
  options: { run?: Run; git?: string } = {},
): Promise<boolean> {
  const ref = `refs/heads/${branch}`
  const git = (args: string[]) => gitIn(repo, args, options)
  if ((await git(['rev-parse', '-q', '--verify', ref])).exitCode !== 0) return true
  const ahead = await git(['rev-list', '--count', ref, '--not', base])
  if (ahead.exitCode === 0 && ahead.stdout.trim() === '0') return true
  const merged = await git(['merge-tree', '--write-tree', base, ref])
  if (merged.exitCode !== 0) return false
  return merged.stdout.trim() === (await git(['rev-parse', `${base}^{tree}`])).stdout.trim()
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
