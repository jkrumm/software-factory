import { EXIT_TIMEOUT, childEnv, withStderr } from '../../hc/process.ts'
import { MAX_EVIDENCE_LINES } from '../../../domains/loops/hygiene-model.ts'
import { exec, gitTry, type Tools } from '../git.ts'

/** The branch every landing bump uses: one name, so a leftover of a pass that was cut short is found and closed by the next. */
const BUMP_BRANCH = 'factory/hygiene-deps'
const GIT_TIMEOUT_MS = 90_000
const GH_TIMEOUT_MS = 60_000
const MAKE_TIMEOUT_MS = 10 * 60_000
/** How long the pass waits for the repo's merge window before it asks again at the next pass (the window's own limit is 90 min). */
const WINDOW_WAIT_MS = 30 * 60_000
const WINDOW_GRACE_MS = 60_000
const METHODS = [
  ['squashMergeAllowed', '--squash'],
  ['rebaseMergeAllowed', '--rebase'],
  ['mergeCommitAllowed', '--merge'],
] as const

/** How long the pass looks at the pull request's CI: a run that has not started, and one that has not finished. */
export interface CiWait {
  everyMs: number
  noChecksMs: number
  maxMs: number
}
const CI_WAIT: CiWait = { everyMs: 30_000, noChecksMs: 3 * 60_000, maxMs: 45 * 60_000 }

const tailOf = (text: string, lines = MAX_EVIDENCE_LINES): string[] =>
  text
    .split('\n')
    .map((line) => line.trim().slice(0, 240))
    .filter(Boolean)
    .slice(-lines)

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** What the pass found out about a bump it had committed: it merged, or why it did not, and whether asking again later can help. */
export type Landed =
  | { kind: 'merged'; number: number; method: string; sha: string }
  | { kind: 'deferred'; detail: string }
  | { kind: 'failed'; detail: string; output?: string[] }

/**
 * The merge method the repo allows, and the one gh would use: squash, else rebase, else merge. Undefined when gh cannot read
 * the repo (not signed in, not a GitHub remote): the caller does not start what it cannot land.
 */
export async function mergeMethod(tools: Tools, cwd: string): Promise<string | undefined> {
  const read = await exec(
    [tools.gh, 'repo', 'view', '--json', METHODS.map(([key]) => key).join(',')],
    GH_TIMEOUT_MS,
    cwd,
  ).catch(() => undefined)
  if (read?.exitCode !== 0) return undefined
  try {
    const allowed = JSON.parse(read.stdout) as Record<string, unknown>
    return METHODS.find(([key]) => allowed[key] === true)?.[1]
  } catch {
    return undefined
  }
}

/**
 * Holds the project's merge window (`factory merge-lock`, the one lock a lead's merge also takes) while `use` runs: a child
 * that prints "held" once it has the lock and then waits on its stdin, so the lock is let go when this process closes the
 * pipe, kills the child or dies. Undefined when the window was not free within `WINDOW_WAIT_MS`.
 */
async function inWindow<T>(tools: Tools, project: string, cwd: string, use: () => Promise<T>): Promise<T | undefined> {
  if (!tools.mergeLock.length) return undefined
  const proc = Bun.spawn([...tools.mergeLock, '--project', project, '--', 'sh', '-c', 'echo held; exec cat'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
    env: childEnv({ FACTORY_MERGE_LOCK_WAIT_MS: String(WINDOW_WAIT_MS) }),
    cwd,
  })
  const reader = proc.stdout.getReader()
  let timer: Timer | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), WINDOW_WAIT_MS + WINDOW_GRACE_MS)
  })
  const held = (async () => {
    let seen = ''
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return false
      seen += new TextDecoder().decode(chunk.value)
      if (seen.includes('held')) return true
    }
  })()
  try {
    const outcome = await Promise.race([held, deadline])
    if (outcome !== true) return undefined
    return await use()
  } finally {
    clearTimeout(timer)
    try {
      void proc.stdin.end()
    } catch {
      // already closed
    }
    let kill: Timer | undefined
    const late = new Promise<'late'>((resolve) => {
      kill = setTimeout(() => resolve('late'), 10_000)
    })
    if ((await Promise.race([proc.exited, late])) === 'late') proc.kill('SIGTERM')
    clearTimeout(kill)
    await reader.cancel().catch(() => {})
  }
}

interface Checks {
  state: 'none' | 'pending' | 'green' | 'red'
  failed: string[]
}

/** `gh pr checks` as one word: its exit code says pending or failing, its JSON says which, so the JSON is what is read. */
async function checksOf(tools: Tools, cwd: string, number: number): Promise<Checks> {
  const read = await exec(
    [tools.gh, 'pr', 'checks', String(number), '--json', 'name,bucket'],
    GH_TIMEOUT_MS,
    cwd,
  ).catch(() => undefined)
  let rows: { name?: string; bucket?: string }[] = []
  try {
    const parsed: unknown = JSON.parse(read?.stdout ?? '')
    if (Array.isArray(parsed)) rows = parsed as typeof rows
  } catch {
    return { state: 'none', failed: [] }
  }
  if (!rows.length) return { state: 'none', failed: [] }
  const failed = rows.filter((row) => row.bucket === 'fail' || row.bucket === 'cancel').map((row) => row.name ?? '?')
  if (failed.length) return { state: 'red', failed }
  // Green is a check that ran and passed: a set that is all skipped (a path or `if` filter) is no CI at all.
  const done = rows.every((row) => row.bucket === 'pass' || row.bucket === 'skipping')
  if (done && !rows.some((row) => row.bucket === 'pass')) return { state: 'none', failed: [] }
  return { state: done ? 'green' : 'pending', failed: [] }
}

async function waitForCi(tools: Tools, cwd: string, number: number, wait: CiWait): Promise<Checks | 'timeout'> {
  const started = Date.now()
  let greens = 0
  for (;;) {
    const checks = await checksOf(tools, cwd, number)
    if (checks.state === 'red') return checks
    // Green twice in a row: a workflow that registers a moment after the first one must not be merged past.
    greens = checks.state === 'green' ? greens + 1 : 0
    if (greens >= 2) return checks
    const elapsed = Date.now() - started
    if (checks.state === 'none' && elapsed >= wait.noChecksMs) return { state: 'none', failed: [] }
    if (elapsed >= wait.maxMs) return 'timeout'
    await sleep(wait.everyMs)
  }
}

/**
 * The guard of the merge window: the repo's own `make merge-guard` where it has one (`make -n` says so for any way a Makefile
 * declares or includes it), else the branch contains master and master's last finished run is not red.
 */
async function guard(tools: Tools, cwd: string, base: string): Promise<string[] | undefined> {
  const declared = await exec([tools.make, '-n', 'merge-guard'], GIT_TIMEOUT_MS, cwd).catch(() => undefined)
  if (declared?.exitCode === 0) {
    const run = await exec(withStderr([tools.make, 'merge-guard']), MAKE_TIMEOUT_MS, cwd)
    return run.exitCode === 0 ? undefined : tailOf(run.stdout)
  }
  const contains = await exec([tools.git, 'merge-base', '--is-ancestor', `origin/${base}`, 'HEAD'], GIT_TIMEOUT_MS, cwd)
  if (contains.exitCode !== 0) return [`the branch does not contain origin/${base}`]
  const runs = await exec(
    [tools.gh, 'run', 'list', '--branch', base, '--limit', '5', '--json', 'status,conclusion'],
    GH_TIMEOUT_MS,
    cwd,
  ).catch(() => undefined)
  if (runs?.exitCode !== 0) return [`the runs of ${base} could not be read`]
  try {
    const rows = JSON.parse(runs.stdout) as { status?: string; conclusion?: string }[]
    const last = rows.find((row) => row.status === 'completed')
    if (last && last.conclusion !== 'success' && last.conclusion !== 'skipped')
      return [`the last finished run of ${base} is ${last.conclusion}`]
  } catch {
    return [`the runs of ${base} could not be read`]
  }
  return undefined
}

async function abandon(tools: Tools, cwd: string, number: number | undefined, why: string): Promise<void> {
  if (number !== undefined) {
    await exec(
      [tools.gh, 'pr', 'close', String(number), '--delete-branch', '--comment', why],
      GH_TIMEOUT_MS,
      cwd,
    ).catch(() => {})
  } else {
    await exec([tools.git, 'push', '-q', 'origin', `:refs/heads/${BUMP_BRANCH}`], GIT_TIMEOUT_MS, cwd).catch(() => {})
  }
}

/**
 * Lands a committed bump the way a lead lands a change, in one pass with no state carried over: it takes the repo's merge
 * window, brings the commit onto the default branch's tip (a rebase that conflicts is not forced: the next pass bumps again),
 * pushes the branch `BUMP_BRANCH`, opens the pull request, waits for its CI, runs the guard and merges by the method the repo
 * allows. Whatever stops it closes the pull request and deletes the branch, so a lead who gets the finding starts clean and
 * a pass cut short leaves at most one branch, which the next pass closes. Nothing is deployed: like a pushed bump, it rides
 * the repo's next ship.
 */
export async function landByPullRequest(input: {
  tools: Tools
  cwd: string
  project: string
  base: string
  method: string
  title: string
  body: string
  wait?: CiWait
}): Promise<Landed> {
  const { tools, cwd, base, method } = input
  const outcome = await inWindow(tools, input.project, cwd, async (): Promise<Landed> => {
    const fetched = await exec(withStderr([tools.git, 'fetch', '-q', 'origin']), GIT_TIMEOUT_MS, cwd)
    if (fetched.exitCode !== 0) return { kind: 'failed', detail: 'git fetch failed', output: tailOf(fetched.stdout) }
    const contains = await exec(
      [tools.git, 'merge-base', '--is-ancestor', `origin/${base}`, 'HEAD'],
      GIT_TIMEOUT_MS,
      cwd,
    )
    if (contains.exitCode !== 0) {
      const rebase = await exec(withStderr([tools.git, 'rebase', '-q', `origin/${base}`]), GIT_TIMEOUT_MS, cwd)
      if (rebase.exitCode !== 0) {
        await exec([tools.git, 'rebase', '--abort'], GIT_TIMEOUT_MS, cwd)
        return {
          kind: 'deferred',
          detail: `${base} moved and the bump no longer applies to it: bumped again at the next pass`,
        }
      }
    }
    // A branch a pass cut short left behind: its pull request is closed before the name is used again.
    const left = await exec(
      [tools.gh, 'pr', 'list', '--head', BUMP_BRANCH, '--state', 'open', '--json', 'number'],
      GH_TIMEOUT_MS,
      cwd,
    ).catch(() => undefined)
    try {
      for (const row of JSON.parse(left?.stdout ?? '[]') as { number: number }[]) {
        await abandon(tools, cwd, row.number, 'A newer bump replaces this one.')
      }
    } catch {
      // nothing readable: the push below replaces the branch
    }
    const push = await exec(
      withStderr([tools.git, 'push', '-q', '--force', 'origin', `HEAD:refs/heads/${BUMP_BRANCH}`]),
      GIT_TIMEOUT_MS,
      cwd,
    )
    if (push.exitCode !== 0) {
      return {
        kind: 'failed',
        detail:
          push.exitCode === EXIT_TIMEOUT
            ? 'git push did not finish'
            : `git push of ${BUMP_BRANCH} was refused (exit ${push.exitCode})`,
        output: tailOf(push.stdout),
      }
    }
    const created = await exec(
      [tools.gh, 'pr', 'create', '--base', base, '--head', BUMP_BRANCH, '--title', input.title, '--body', input.body],
      GH_TIMEOUT_MS,
      cwd,
    ).catch(() => undefined)
    const number = Number(/\/pull\/(\d+)/.exec(created?.stdout ?? '')?.[1])
    if (created?.exitCode !== 0 || !Number.isInteger(number)) {
      await abandon(tools, cwd, undefined, '')
      return {
        kind: 'failed',
        detail: 'gh pr create did not open a pull request',
        output: tailOf(created?.stdout ?? ''),
      }
    }
    const stop = async (result: Landed, why: string): Promise<Landed> => {
      await abandon(tools, cwd, number, why)
      return result
    }

    const checks = await waitForCi(tools, cwd, number, input.wait ?? CI_WAIT)
    if (checks === 'timeout') {
      return stop(
        { kind: 'failed', detail: `CI of pull request #${number} did not finish` },
        'CI did not finish in time.',
      )
    }
    if (checks.state === 'none') {
      return stop({ kind: 'failed', detail: `no CI check appeared on pull request #${number}` }, 'No CI check ran.')
    }
    if (checks.state === 'red') {
      return stop(
        {
          kind: 'failed',
          detail: `CI of pull request #${number} is red with the bumps`,
          output: checks.failed.map((name) => `failed: ${name}`),
        },
        'CI is red with these bumps.',
      )
    }
    const refused = await guard(tools, cwd, base)
    if (refused) {
      return stop(
        { kind: 'deferred', detail: `the merge guard refused pull request #${number}: asked again at the next pass` },
        `The merge guard refused: ${refused[0] ?? 'see the pass'}`,
      )
    }
    const merge = await exec(
      withStderr([tools.gh, 'pr', 'merge', String(number), method, '--delete-branch']),
      GH_TIMEOUT_MS,
      cwd,
    )
    if (merge.exitCode !== 0) {
      return stop(
        {
          kind: 'failed',
          detail: `gh pr merge refused pull request #${number} (exit ${merge.exitCode})`,
          output: tailOf(merge.stdout),
        },
        'The merge was refused.',
      )
    }
    const sha = ((await gitTry(tools, cwd, ['rev-parse', '--short', 'HEAD'])) ?? '').trim()
    return { kind: 'merged', number, method: method.replace('--', ''), sha }
  })
  if (!outcome) {
    return {
      kind: 'deferred',
      detail: `the merge window of ${input.project} was not free in time: asked again at the next pass`,
    }
  }
  return outcome
}
