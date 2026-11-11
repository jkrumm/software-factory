import * as z from 'zod'
import type { CiLive, CiRuns } from '../../domains/loops/ports.ts'
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
