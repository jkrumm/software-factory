import * as z from 'zod'
import type { CiLedgerRun, CiLedgerRuns, CiLive, CiRuns, CiRunTime, CiTimes } from '../../domains/loops/ports.ts'
import { err, ok, portError, type PortError, type Result } from '../../kernel/result.ts'
import { parseRemote } from '../intake/github.ts'
import { gitIn } from '../quality/git.ts'
import type { Run } from '../quality/process.ts'

const HTTP_TIMEOUT_MS = 15_000
const REMOTE_TIMEOUT_MS = 10_000
const RUNS_PAGE_SIZE = 30

const GithubRepo = z.looseObject({ default_branch: z.string().min(1) })

const WorkflowRuns = z.looseObject({
  workflow_runs: z.array(
    z.looseObject({
      id: z.number().int(),
      name: z.string().nullish(),
      head_sha: z.string(),
      status: z.string().nullish(),
      conclusion: z.string().nullish(),
      html_url: z.string(),
      created_at: z.string(),
    }),
  ),
})

export interface GithubCiOptions {
  /** the repo's main checkout (inside the allowed roots), whose `origin` names the GitHub repository */
  locate(repo: string): Promise<Result<string>>
  /** `FACTORY_GITHUB_TOKEN`; without it nothing is read */
  token: string | null
  /** the API base (`FACTORY_GITHUB_API_URL`); a scenario points it at a local fake */
  apiUrl: string
  run?: Run
  fetch?: typeof fetch
}

/** The GitHub reads both adapters share: one GET with the token, and the `owner/name` of a repo's origin. */
function githubReader(options: GithubCiOptions) {
  const api = options.apiUrl.replace(/\/+$/, '')
  const doFetch = options.fetch ?? fetch

  async function read<T>(url: string, schema: z.ZodType<T>): Promise<Result<T, PortError>> {
    let response: Response
    try {
      response = await doFetch(url, {
        headers: {
          Authorization: `Bearer ${options.token ?? ''}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'software-factory',
        },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      return err(
        portError(timedOut ? 'timeout' : 'unreadable', `github did not answer: ${timedOut ? 'timeout' : 'error'}`),
      )
    }
    if (response.status !== 200) return err(portError('unreadable', `github ${response.status}`))
    const parsed = schema.safeParse(await response.json().catch(() => undefined))
    return parsed.success ? ok(parsed.data) : err(portError('unreadable', 'github answered with an unexpected body'))
  }

  async function slugOf(repo: string): Promise<Result<string, PortError>> {
    if (!options.token) return err(portError('refused', 'no token'))
    const located = await options.locate(repo)
    if (!located.ok) return located
    const done = await gitIn(located.value, ['remote', 'get-url', 'origin'], {
      timeoutMs: REMOTE_TIMEOUT_MS,
      ...(options.run ? { run: options.run } : {}),
    }).catch(() => undefined)
    const remote = done?.exitCode === 0 ? parseRemote(done.stdout.trim()) : undefined
    if (!remote) return err(portError('refused', `${repo} has no github.com origin`))
    return ok(`${remote.owner}/${remote.name}`)
  }

  return { api, read, slugOf }
}

/**
 * The newest completed workflow runs of a branch of the repo's GitHub origin. Reads only; a missing token, an origin
 * that is not github.com, a status other than 200 or a body that does not parse is an error naming it, never a body.
 */
export function githubCiRuns(options: GithubCiOptions): CiRuns {
  const { api, read, slugOf } = githubReader(options)

  return {
    async latest(repo, branch) {
      const found = await slugOf(repo)
      if (!found.ok) return found
      const slug = found.value

      let ref = branch
      if (!ref) {
        const info = await read(`${api}/repos/${slug}`, GithubRepo)
        if (!info.ok) return info
        ref = info.value.default_branch
      }
      const runs = await read(
        `${api}/repos/${slug}/actions/runs?branch=${encodeURIComponent(ref)}&status=completed&per_page=${RUNS_PAGE_SIZE}`,
        WorkflowRuns,
      )
      if (!runs.ok) return runs
      return ok({
        branch: ref,
        runs: runs.value.workflow_runs.flatMap((run) =>
          run.conclusion
            ? [
                {
                  id: String(run.id),
                  workflow: run.name?.trim() || 'workflow',
                  sha: run.head_sha,
                  conclusion: run.conclusion,
                  url: run.html_url,
                  at: run.created_at,
                },
              ]
            : [],
        ),
      })
    },
  }
}

/** A workflow run in one of these statuses is not finished: GitHub's `completed` is the only end. */
const FINISHED = 'completed'

/**
 * Whether any workflow run of a branch is queued or in progress (the newest page of runs, any status). Reads only; the
 * errors are `githubCiRuns`'s, and a branch with no run is a plain no.
 */
export function githubCiLive(options: GithubCiOptions): CiLive {
  const { api, read, slugOf } = githubReader(options)

  return {
    async running(repo, branch) {
      const found = await slugOf(repo)
      if (!found.ok) return found
      const runs = await read(
        `${api}/repos/${found.value}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=${RUNS_PAGE_SIZE}`,
        WorkflowRuns,
      )
      if (!runs.ok) return runs
      return ok(runs.value.workflow_runs.some((run) => run.status && run.status !== FINISHED))
    },
  }
}

const TIMES_PAGE_SIZE = 100
/** At most this many pages of runs are read for a repo: 300 runs of the window. */
const TIMES_MAX_PAGES = 3
const MINUTE_MS = 60_000

const TimedRuns = z.looseObject({
  workflow_runs: z.array(
    z.looseObject({
      event: z.string(),
      head_branch: z.string().nullish(),
      conclusion: z.string().nullish(),
      run_attempt: z.number().int().nullish(),
      run_started_at: z.string().nullish(),
      updated_at: z.string(),
    }),
  ),
})

/**
 * How long the repo's finished CI runs took since a date: pushes to the default branch and pull request runs, ended
 * green or red (a cancelled or skipped run says nothing about the duration). A run is `flaky` when it ended green on a
 * rerun. Reads only, newest first, at most three pages; errors are `githubCiRuns`'s.
 */
export function githubCiTimes(options: GithubCiOptions): CiTimes {
  const { api, read, slugOf } = githubReader(options)

  return async (repo, since) => {
    const found = await slugOf(repo)
    if (!found.ok) return found
    const info = await read(`${api}/repos/${found.value}`, GithubRepo)
    if (!info.ok) return info
    const runs: CiRunTime[] = []
    let truncated = false
    for (let page = 1; page <= TIMES_MAX_PAGES; page++) {
      const answer = await read(
        `${api}/repos/${found.value}/actions/runs?status=completed&created=%3E%3D${since.toISOString().slice(0, 10)}&per_page=${TIMES_PAGE_SIZE}&page=${page}`,
        TimedRuns,
      )
      if (!answer.ok) return answer
      for (const run of answer.value.workflow_runs) {
        const conclusion = run.conclusion
        if ((conclusion !== 'success' && conclusion !== 'failure') || !run.run_started_at) continue
        const kind =
          run.event === 'push' && run.head_branch === info.value.default_branch
            ? 'default'
            : run.event === 'pull_request' || run.event === 'pull_request_target'
              ? 'pr'
              : null
        const ms = Date.parse(run.updated_at) - Date.parse(run.run_started_at)
        if (!kind || !Number.isFinite(ms) || ms < 0) continue
        runs.push({
          kind,
          minutes: ms / MINUTE_MS,
          conclusion,
          flaky: conclusion === 'success' && (run.run_attempt ?? 1) > 1,
        })
      }
      if (answer.value.workflow_runs.length < TIMES_PAGE_SIZE) break
      truncated = page === TIMES_MAX_PAGES
    }
    return ok({ runs, truncated })
  }
}

const LedgerRuns = z.looseObject({
  workflow_runs: z.array(
    z.looseObject({
      id: z.number().int(),
      name: z.string().nullish(),
      event: z.string(),
      head_branch: z.string().nullish(),
      head_sha: z.string(),
      conclusion: z.string().nullish(),
      run_attempt: z.number().int().nullish(),
      created_at: z.string(),
      run_started_at: z.string().nullish(),
      updated_at: z.string(),
    }),
  ),
})

/**
 * The finished workflow runs of the repo created since a date, newest first, at most three pages (300 runs), for the CI
 * ledger: every conclusion (a cancelled run held its head's pull request waiting too), with when it was queued, started
 * and finished. A rerun is queued at its latest attempt's start, not at the first attempt's creation. Reads only; errors
 * are `githubCiRuns`'s.
 */
export function githubCiLedger(options: GithubCiOptions): CiLedgerRuns {
  const { api, read, slugOf } = githubReader(options)

  return async (repo, since) => {
    const found = await slugOf(repo)
    if (!found.ok) return found
    const runs: CiLedgerRun[] = []
    for (let page = 1; page <= TIMES_MAX_PAGES; page++) {
      const answer = await read(
        `${api}/repos/${found.value}/actions/runs?status=completed&created=%3E%3D${since.toISOString().slice(0, 10)}&per_page=${TIMES_PAGE_SIZE}&page=${page}`,
        LedgerRuns,
      )
      if (!answer.ok) return answer
      for (const run of answer.value.workflow_runs) {
        if (!run.conclusion || !run.run_started_at) continue
        const attempt = run.run_attempt ?? 1
        const startedAt = new Date(run.run_started_at)
        const finishedAt = new Date(run.updated_at)
        const queuedAt = attempt > 1 ? startedAt : new Date(run.created_at)
        if ([queuedAt, startedAt, finishedAt].some((d) => Number.isNaN(d.getTime()))) continue
        // the clock of one run is one clock: a run that ends before it starts, or starts before it was queued, is clamped
        runs.push({
          runId: run.id,
          workflow: run.name?.trim() || 'workflow',
          event: run.event,
          headBranch: run.head_branch ?? null,
          headSha: run.head_sha,
          runAttempt: attempt,
          queuedAt: queuedAt > startedAt ? startedAt : queuedAt,
          startedAt,
          finishedAt: finishedAt < startedAt ? startedAt : finishedAt,
          conclusion: run.conclusion,
        })
      }
      if (answer.value.workflow_runs.length < TIMES_PAGE_SIZE) break
    }
    return ok(runs)
  }
}
